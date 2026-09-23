import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { LlmCompleteParams, LlmIsolatedAgentRuntimeCompleteParams } from "./types-core.js";

const mocks = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  complete:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel
    >(),
  select:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").resolveSimpleCompletionSelectionForAgent
    >(),
  isolated: vi.fn<typeof import("../../agents/isolated-completion.js").runIsolatedCompletion>(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: mocks.acquire,
  completeWithPreparedSimpleCompletionModel: mocks.complete,
  resolveSimpleCompletionSelectionForAgent: mocks.select,
}));
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: mocks.isolated }));

const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { model: "test-provider/allowed" } },
};
const selection = { provider: "test-provider", modelId: "allowed", agentDir: "/tmp/model-policy" };

function preparedModel(modelId = "allowed") {
  return {
    async [Symbol.asyncDispose]() {},
    selection,
    model: {
      provider: "test-provider",
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      baseUrl: "https://fixture.invalid/v1",
      input: ["text" as const],
      reasoning: false,
      contextWindow: 8192,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    auth: { apiKey: "synthetic-test-key", source: "fixture", mode: "api-key" as const },
  };
}

function operator(assertCurrent: () => void = () => {}, retain?: () => () => void) {
  return createAdmittedRunOperatorAuthority({
    profileId: "model-reader",
    scopes: ["operator.write"],
    assertCurrent,
    retain,
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "main", allow: ["test-provider/allowed"] },
      manifestPlugins: [],
    }),
  });
}

type CompletionMode = "direct" | "isolated";
function request(mode: CompletionMode): LlmCompleteParams {
  const messages: LlmIsolatedAgentRuntimeCompleteParams["messages"] = [
    { role: "user", content: "Answer the synthetic question." },
  ];
  return mode === "isolated"
    ? { messages, model: "friendly-alias", execution: { mode: "isolated-agent-runtime" } }
    : { messages, model: "friendly-alias" };
}

function completion() {
  return createRuntimeLlm({
    getConfig: () => cfg,
    authority: {
      allowComplete: true,
      allowModelOverride: true,
      allowedModels: [
        "test-provider/allowed",
        "test-provider/blocked",
        "test-provider/model-a",
        "test-provider/model-b",
      ],
    },
  });
}

function asOperator<T>(authority: AdmittedRunOperatorAuthority, run: () => Promise<T>) {
  return withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority: authority },
    run,
  );
}

async function withWork<T>(run: () => Promise<T>): Promise<T> {
  const work = new AsyncWorkScope();
  try {
    return await work.track(run);
  } finally {
    await work.drain();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockReturnValue(selection);
  mocks.acquire.mockImplementation(async () => preparedModel());
  mocks.complete.mockImplementation(async (params) => {
    params.assertCurrent?.();
    return {
      role: "assistant",
      content: [{ type: "text", text: "Allowed answer." }],
      api: "openai-completions",
      provider: "test-provider",
      model: "allowed",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
  });
  mocks.isolated.mockImplementation(async (params) => {
    params.assertCurrent?.();
    return {
      text: "Allowed answer.",
      provider: "test-provider",
      model: "allowed",
      owner: { kind: "harness", id: "test-harness" },
    };
  });
});

describe("operator model policy on plugin completions", () => {
  it("reports a missing Gateway binding before preparing an operator completion", async () => {
    await expect(
      withWork(() =>
        withPluginRuntimeGatewayRequestScope(
          {
            client: createSyntheticPluginRuntimeClient({
              operatorRoleActor: { kind: "operator", profileId: "model-reader" },
              scopes: ["operator.write"],
            }),
            isWebchatConnect: () => false,
          },
          () => completion().complete(request("direct")),
        ),
      ),
    ).rejects.toMatchObject({
      name: "LlmCompleteError",
      code: "LLM_COMPLETION_NOT_AUTHORIZED",
      message: "Plugin model completion requires its current Gateway binding.",
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["restricted", "unrestricted"] as const)(
    "aborts only a removed in-flight model from an initially %s source",
    async (initial) => {
      const preparePolicy = (allow: string[]) =>
        prepareOperatorModelPolicy({
          cfg,
          policy: { sourceAgent: "main", allow },
          manifestPlugins: [],
        });
      let policy =
        initial === "restricted"
          ? preparePolicy(["test-provider/model-a", "test-provider/model-b"])
          : undefined;
      const observers = new Set<() => void>();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "model-reader",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        get modelPolicy() {
          return policy;
        },
        onModelPolicyChanged: (listener) => {
          observers.add(listener);
          return () => {
            observers.delete(listener);
          };
        },
      });
      const firstStarted = createDeferredCore();
      const started = createDeferredCore();
      const finishA = createDeferredCore();
      const finishB = createDeferredCore();
      const signals = new Map<string, AbortSignal>();
      mocks.select.mockImplementation(({ modelRef }) => ({
        ...selection,
        modelId: modelRef ?? "model-a",
      }));
      mocks.acquire.mockImplementation(async ({ modelRef }) => ({
        ...preparedModel(modelRef),
        selection: { ...selection, modelId: modelRef ?? "model-a" },
      }));
      const finishCompletion = mocks.complete.getMockImplementation();
      if (!finishCompletion) {
        throw new Error("completion fixture is unavailable");
      }
      mocks.complete.mockImplementation(async (params) => {
        const signal = params.options?.signal;
        if (!signal) {
          throw new Error("model execution has no cancellation signal");
        }
        signals.set(params.model.id, signal);
        if (params.model.id === "model-a") {
          firstStarted.resolve();
        }
        if (signals.size === 2) {
          started.resolve();
        }
        await (params.model.id === "model-a" ? finishA.promise : finishB.promise);
        return finishCompletion(params);
      });
      const work = new AsyncWorkScope();
      const llm = completion();
      const first = work.track(() =>
        asOperator(authority, () => llm.complete({ ...request("direct"), model: "model-a" })),
      );
      // Vitest's manual mock loader shares import callstacks; overlap provider work after import.
      const second = Promise.race([
        firstStarted.promise,
        first.then(() => {
          throw new Error("first completion settled before provider work started");
        }),
      ]).then(() =>
        work.track(() =>
          asOperator(authority, () => llm.complete({ ...request("direct"), model: "model-b" })),
        ),
      );
      try {
        await Promise.race([
          started.promise,
          Promise.all([first, second]).then(() => {
            throw new Error("completions settled before policy changed");
          }),
        ]);
        policy = preparePolicy(["test-provider/model-b"]);
        for (const listener of observers) {
          listener();
        }
        expect(signals.get("model-a")?.aborted).toBe(true);
        expect(signals.get("model-b")?.aborted).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
        finishA.resolve();
        await expect(first).rejects.toThrow("cannot use this model");
        finishB.resolve();
        await expect(second).resolves.toMatchObject({ text: "Allowed answer." });
      } finally {
        finishA.resolve();
        finishB.resolve();
        await Promise.allSettled([first, second]);
        await work.drain();
      }
      expect(observers.size).toBe(0);
    },
  );
  it.each([
    { mode: "direct", source: "agent-tool" },
    { mode: "isolated", source: "request" },
    { mode: "direct", source: "direct-tool" },
    { mode: "isolated", source: "unbound-operator" },
  ] as const)(
    "denies a resolved alias before $mode preparation from $source",
    async ({ mode, source }) => {
      mocks.select.mockReturnValue({ ...selection, modelId: "blocked" });
      const authority = operator();
      const invoke = () => completion().complete(request(mode));
      await expect(
        withWork(() =>
          source === "agent-tool"
            ? asOperator(authority, invoke)
            : source === "request"
              ? withPluginRuntimeGatewayRequestScope(
                  {
                    client: {
                      connect: {
                        minProtocol: 1,
                        maxProtocol: 1,
                        client: {
                          id: "openclaw-control-ui",
                          version: "test",
                          platform: "test",
                          mode: "webchat",
                        },
                        role: "operator",
                        scopes: ["operator.write"],
                      },
                      internal: { operatorRunAuthority: authority },
                    },
                    isWebchatConnect: () => true,
                  },
                  invoke,
                )
              : withOperatorToolGatewayAuthority(
                  {
                    authenticatedUserProfile: {
                      profileId: authority.profileId,
                      displayName: "Model Reader",
                      hasAvatar: false,
                      updatedAt: 1,
                    },
                    scopes: ["operator.write"],
                    ...(source === "direct-tool" ? { operatorRunAuthority: authority } : {}),
                  },
                  invoke,
                ),
        ),
      ).rejects.toThrow(
        source === "unbound-operator"
          ? "requires original Gateway authority"
          : "cannot use this model",
      );
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.isolated).not.toHaveBeenCalled();
    },
  );

  it.each(["direct", "isolated"] as const)(
    "allows a resolved alias on %s completion",
    async (mode) => {
      const authority = operator();
      const invoke = () => completion().complete(request(mode));
      await expect(
        withWork(() =>
          mode === "direct"
            ? withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: {
                    profileId: authority.profileId,
                    displayName: "Model Reader",
                    hasAvatar: false,
                    updatedAt: 1,
                  },
                  scopes: ["operator.write"],
                  operatorRunAuthority: authority,
                },
                invoke,
              )
            : asOperator(authority, invoke),
        ),
      ).resolves.toMatchObject({ text: "Allowed answer." });
      expect(mode === "direct" ? mocks.complete : mocks.isolated).toHaveBeenCalledOnce();
    },
  );

  it("checks the prepared logical model rather than the earlier selection", async () => {
    mocks.acquire.mockResolvedValue({
      ...preparedModel("blocked"),
      selection: { ...selection, modelId: "blocked" },
    });
    await expect(
      withWork(() => asOperator(operator(), () => completion().complete(request("direct")))),
    ).rejects.toThrow("cannot use this model");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("preserves a permitted logical model's provider transport mapping", async () => {
    mocks.acquire.mockResolvedValue(preparedModel("provider-execution-id"));
    await expect(
      withWork(() => asOperator(operator(), () => completion().complete(request("direct")))),
    ).resolves.toMatchObject({ text: "Allowed answer." });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("keeps the host-bound context engine independent of the ambient requester", async () => {
    mocks.select.mockReturnValue({ ...selection, modelId: "system-model" });
    mocks.acquire.mockResolvedValue({
      ...preparedModel("system-model"),
      selection: { ...selection, modelId: "system-model" },
    });
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        caller: { kind: "context-engine", id: "summary" },
        agentId: "main",
        requiresBoundAgent: true,
        allowModelOverride: false,
        allowAgentIdOverride: false,
        allowComplete: true,
      },
    });
    await expect(
      withWork(() =>
        asOperator(operator(), () =>
          llm.complete({
            messages: [{ role: "user", content: "Summarize the accepted context." }],
          }),
        ),
      ),
    ).resolves.toMatchObject({ text: "Allowed answer." });
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it("rechecks a retired requester after model preparation", async () => {
    const started = createDeferredCore();
    const resume = createDeferredCore();
    let active = true;
    mocks.acquire.mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      return preparedModel();
    });
    const authority = operator(() => {
      if (!active) {
        throw new Error("requester retired");
      }
    });
    const pending = withWork(() =>
      asOperator(authority, () => completion().complete(request("direct"))),
    );
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("completion settled before model preparation started");
      }),
    ]);
    active = false;
    resume.resolve();
    await expect(pending).rejects.toThrow("requester retired");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each(["direct", "isolated"] as const)(
    "retains the requester through %s cleanup after returning the answer",
    async (mode) => {
      const cleanup = createDeferredCore();
      const release = vi.fn();
      const retain = vi.fn(() => release);
      if (mode === "direct") {
        mocks.acquire.mockImplementation(async () => ({
          ...preparedModel(),
          async [Symbol.asyncDispose]() {
            await cleanup.promise;
          },
        }));
      } else {
        mocks.isolated.mockImplementation(async () => {
          void trackAsyncWork(() => cleanup.promise);
          return {
            text: "Allowed answer.",
            provider: "test-provider",
            model: "allowed",
            owner: { kind: "harness", id: "test-harness" },
          };
        });
      }
      const work = new AsyncWorkScope();
      try {
        const result = await work.track(() =>
          asOperator(
            operator(() => {}, retain),
            () => completion().complete(request(mode)),
          ),
        );
        expect(result.text).toBe("Allowed answer.");
        expect(retain).toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        await work.drain();
      }
      expect(release).toHaveBeenCalledTimes(retain.mock.calls.length);
    },
  );
});
