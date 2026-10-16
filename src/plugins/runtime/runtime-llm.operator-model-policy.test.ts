import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  runWithPluginSessionWorkAuthority,
  type PluginSessionWorkAuthority,
} from "../../gateway/plugin-session-work-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as profileReader from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./gateway-request-scope.js";
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

type OperatorSource =
  | "agent-tool"
  | "request"
  | "direct-tool"
  | "unbound-operator"
  | "missing-binding";

function asOperator<T>(
  authority: AdmittedRunOperatorAuthority,
  run: () => Promise<T>,
  source: OperatorSource = "agent-tool",
) {
  if (source === "agent-tool") {
    return withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority: authority },
      run,
    );
  }
  if (source === "request" || source === "missing-binding") {
    return withPluginRuntimeGatewayRequestScope(
      {
        client:
          source === "missing-binding"
            ? createSyntheticPluginRuntimeClient({
                operatorRoleActor: { kind: "operator", profileId: "model-reader" },
                scopes: ["operator.write"],
              })
            : {
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
        isWebchatConnect: () => source === "request",
      },
      run,
    );
  }
  return withOperatorToolGatewayAuthority(
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
  it.each(["foreground", "recovery"] as const)(
    "binds each completion to the trusted %s target without granting overrides",
    async (mode) => {
      const llm = createRuntimeLlm({
        getConfig: () => cfg,
        authority: { allowComplete: true, allowAgentIdOverride: false },
      });
      const run = <T>(agentId: string, work: () => Promise<T>) =>
        mode === "foreground"
          ? withGatewayToolCallerIdentity(
              { agentId, sessionKey: `agent:${agentId}:research`, operatorAuthority: operator() },
              work,
            )
          : runWithPluginSessionWorkAuthority(
              {
                target: { agentId, sessionKey: `agent:${agentId}:research`, sessionId: "accepted" },
                signal: new AbortController().signal,
                assertCurrent: () => {},
                assertToolAllowed: () => {},
                pluginId: "deep-research",
                context: createContext(),
              },
              () => asOperator(operator(), work, "direct-tool"),
            );
      for (const agentId of ["research", "main"]) {
        const result = await run(agentId, () => llm.complete({ messages: [] }));
        expect(result.agentId).toBe(agentId);
        expect(result.audit.sessionKey).toBe(`agent:${agentId}:research`);
        expect(mocks.acquire).toHaveBeenLastCalledWith(expect.objectContaining({ agentId }));
      }
      mocks.acquire.mockClear();
      await expect(
        run("research", () => llm.complete({ messages: [], agentId: "main" })),
      ).rejects.toThrow(/cannot override the (active session|target) agent/);
      expect(mocks.acquire).not.toHaveBeenCalled();
      const conflicting = createRuntimeLlm({
        getConfig: () => cfg,
        authority: { allowComplete: true, agentId: "main" },
      });
      await expect(run("research", () => conflicting.complete({ messages: [] }))).rejects.toThrow(
        "conflicts with the current invocation",
      );
      expect(mocks.acquire).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "foreground", permission: "none" },
    { mode: "foreground", permission: "plugin" },
    { mode: "foreground", permission: "host" },
    { mode: "foreground", permission: "host-denied" },
    { mode: "recovery", permission: "none" },
    { mode: "recovery", permission: "plugin" },
    { mode: "recovery", permission: "host" },
    { mode: "recovery", permission: "host-denied" },
  ] as const)(
    "preserves $mode cross-agent permission from $permission",
    async ({ mode, permission }) => {
      const llm = createRuntimeLlm({
        getConfig: () => ({
          ...cfg,
          plugins: {
            entries: {
              "test-plugin": {
                llm: {
                  allowAgentIdOverride: permission === "plugin" || permission === "host-denied",
                },
              },
            },
          },
        }),
        authority: {
          caller: { kind: "plugin", id: "test-plugin" },
          allowComplete: true,
          ...(permission === "host" ? { allowAgentIdOverride: true } : {}),
          ...(permission === "host-denied" ? { allowAgentIdOverride: false } : {}),
        },
      });
      const run = <T>(work: () => Promise<T>) =>
        mode === "foreground"
          ? withGatewayToolCallerIdentity(
              {
                agentId: "research",
                sessionKey: "agent:research:accepted",
                operatorAuthority: operator(),
              },
              work,
            )
          : runWithPluginSessionWorkAuthority(
              {
                target: {
                  agentId: "research",
                  sessionKey: "agent:research:accepted",
                  sessionId: "accepted",
                },
                signal: new AbortController().signal,
                assertCurrent: () => {},
                assertToolAllowed: () => {},
                pluginId: "test-plugin",
                context: createContext(),
              },
              () => asOperator(operator(), work, "direct-tool"),
            );
      const pending = withWork(() => run(() => llm.complete({ messages: [], agentId: "worker" })));
      if (mode === "foreground" && (permission === "plugin" || permission === "host")) {
        await expect(pending).resolves.toMatchObject({
          agentId: "worker",
          audit: { sessionKey: "agent:research:accepted" },
        });
        expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ agentId: "worker" }));
      } else {
        await expect(pending).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
        expect(mocks.acquire).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps original model restrictions on an authorized foreground agent override", async () => {
    mocks.select.mockReturnValue({ ...selection, modelId: "blocked" });
    const llm = createRuntimeLlm({
      getConfig: () => ({
        ...cfg,
        plugins: { entries: { "test-plugin": { llm: { allowAgentIdOverride: true } } } },
      }),
      authority: { caller: { kind: "plugin", id: "test-plugin" }, allowComplete: true },
    });
    await expect(
      withWork(() =>
        withGatewayToolCallerIdentity(
          {
            agentId: "research",
            sessionKey: "agent:research:accepted",
            operatorAuthority: operator(),
          },
          () => llm.complete({ messages: [], agentId: "worker" }),
        ),
      ),
    ).rejects.toThrow("cannot use this model");
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ agentId: "worker" }));
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it.each(["preparation", "provider"] as const)(
    "retains the borrowed-work fence across %s awaits",
    async (boundary) => {
      let active = true;
      const borrowed: PluginSessionWorkAuthority = {
        target: {
          agentId: "research",
          sessionKey: "agent:research:accepted",
          sessionId: "accepted",
        },
        signal: new AbortController().signal,
        assertCurrent: () => {
          if (!active) {
            throw new Error("borrow ended");
          }
        },
        assertToolAllowed: () => {},
        pluginId: "deep-research",
        context: createContext(),
      };
      if (boundary === "preparation") {
        mocks.acquire.mockImplementation(async () => {
          await Promise.resolve();
          active = false;
          return preparedModel();
        });
      } else {
        const complete = mocks.complete.getMockImplementation()!;
        mocks.complete.mockImplementation(async (...args) => {
          const result = await complete(...args);
          active = false;
          return result;
        });
      }
      await expect(
        withWork(() =>
          runWithPluginSessionWorkAuthority(borrowed, () =>
            asOperator(operator(), () => completion().complete(request("direct")), "direct-tool"),
          ),
        ),
      ).rejects.toThrow("borrow ended");
      expect(mocks.complete).toHaveBeenCalledTimes(boundary === "provider" ? 1 : 0);
    },
  );

  it.each(["restricted model", "cancelled request", "replaced caller"] as const)(
    "preserves the original scoped requester during profile preparation: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("completion-reader@example.test");
        setUserProfileRole(profile.id, "reader");
        const context = createContext();
        context.getRuntimeConfig = () => ({
          ...cfg,
          gateway: {
            roles: {
              definitions: {
                reader: {
                  agents: [],
                  sessions: { others: "none" },
                  scopes: ["operator.write"],
                  modelPolicy: { allow: ["test-provider/allowed"] },
                },
              },
            },
          },
        });
        const started = createDeferredCore();
        const resume = createDeferredCore();
        const source = new AbortController();
        let current = true;
        const release = vi.fn();
        const prepare = profileReader.prepareUserProfileIdentity;
        const spy = vi
          .spyOn(profileReader, "prepareUserProfileIdentity")
          .mockImplementation(async (...args) => {
            const prepared = await prepare(...args);
            started.resolve();
            await resume.promise;
            return {
              ...prepared,
              release: () => {
                release();
                prepared.release();
              },
            };
          });
        mocks.select.mockReturnValue({ ...selection, modelId: "blocked" });
        let scope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
        const pending = withWork(() =>
          withPluginRuntimeGatewayRequestScope(
            {
              context,
              client: createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] }),
              signal: source.signal,
              hasCurrentClientAuthority: () => current,
              isWebchatConnect: () => true,
            },
            () => {
              scope = getPluginRuntimeGatewayRequestScope();
              return completion().complete(request("direct"));
            },
          ),
        );
        const rejected = expect(pending).rejects.toThrow(
          scenario === "restricted model" ? "cannot use this model" : /authority|request ended/,
        );
        try {
          await Promise.race([started.promise, pending]);
          if (scenario === "cancelled request") {
            source.abort(new Error("request ended"));
            if (scope) {
              scope.signal = new AbortController().signal;
            }
          } else if (scenario === "replaced caller") {
            current = false;
            if (scope) {
              scope.hasCurrentClientAuthority = () => true;
            }
          }
          resume.resolve();
          await rejected;
          expect(mocks.acquire).not.toHaveBeenCalled();
          expect(mocks.complete).not.toHaveBeenCalled();
          expect(release).toHaveBeenCalledOnce();
        } finally {
          resume.resolve();
          await Promise.allSettled([pending]);
          spy.mockRestore();
        }
      });
    },
  );

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
        await expect(first).rejects.toMatchObject({
          name: "LlmCompleteError",
          code: "LLM_COMPLETION_NOT_AUTHORIZED",
          message: expect.stringContaining("cannot use this model"),
        });
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
    { mode: "direct", source: "agent-tool", denial: "selected model" },
    { mode: "isolated", source: "request", denial: "selected model" },
    { mode: "direct", source: "direct-tool", denial: "selected model" },
    { mode: "isolated", source: "unbound-operator", denial: "selected model" },
    { mode: "direct", source: "missing-binding", denial: "missing binding" },
    { mode: "direct", source: "agent-tool", denial: "prepared model" },
    { mode: "direct", source: "agent-tool", denial: "retired requester" },
    { mode: "isolated", source: "agent-tool", denial: "retired requester" },
  ] as const)(
    "rejects $denial before $mode provider execution from $source",
    async ({ mode, source, denial }) => {
      if (denial === "selected model") {
        mocks.select.mockReturnValue({ ...selection, modelId: "blocked" });
      } else if (denial === "prepared model") {
        mocks.acquire.mockResolvedValue({
          ...preparedModel("blocked"),
          selection: { ...selection, modelId: "blocked" },
        });
      }
      const authority = operator(() => {
        if (denial === "retired requester") {
          throw new Error("requester retired");
        }
      });
      await expect(
        withWork(() => asOperator(authority, () => completion().complete(request(mode)), source)),
      ).rejects.toMatchObject({
        name: "LlmCompleteError",
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
        message:
          denial === "retired requester"
            ? "requester retired"
            : denial === "missing binding"
              ? "Plugin model completion requires its current Gateway binding."
              : expect.stringContaining(
                  source === "unbound-operator"
                    ? "requires original Gateway authority"
                    : "cannot use this model",
                ),
      });
      if (denial !== "prepared model") {
        expect(mocks.acquire).not.toHaveBeenCalled();
      }
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.isolated).not.toHaveBeenCalled();
    },
  );

  it.each(["direct", "isolated"] as const)(
    "allows a resolved alias on %s completion",
    async (mode) => {
      if (mode === "direct") {
        mocks.acquire.mockResolvedValue(preparedModel("provider-execution-id"));
      }
      const authority = operator();
      await expect(
        withWork(() =>
          asOperator(
            authority,
            () => completion().complete(request(mode)),
            mode === "direct" ? "direct-tool" : "agent-tool",
          ),
        ),
      ).resolves.toMatchObject({ text: "Allowed answer." });
      expect(mode === "direct" ? mocks.complete : mocks.isolated).toHaveBeenCalledOnce();
    },
  );

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

  it.each(["direct", "isolated"] as const)(
    "rechecks a retired requester after awaited %s work",
    async (mode) => {
      const started = createDeferredCore();
      const resume = createDeferredCore();
      let active = true;
      const release = vi.fn();
      const retain = vi.fn(() => release);
      if (mode === "direct") {
        mocks.acquire.mockImplementation(async () => {
          started.resolve();
          await resume.promise;
          return preparedModel();
        });
      } else {
        mocks.isolated.mockImplementation(async (params) => {
          started.resolve();
          await resume.promise;
          params.assertCurrent?.();
          return {
            text: "Allowed answer.",
            provider: "test-provider",
            model: "allowed",
            owner: { kind: "harness", id: "test-harness" },
          };
        });
      }
      const authority = operator(() => {
        if (!active) {
          throw new Error("requester retired");
        }
      }, retain);
      const pending = withWork(() =>
        asOperator(authority, () => completion().complete(request(mode))),
      );
      await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("completion settled before work started");
        }),
      ]);
      active = false;
      resume.resolve();
      await expect(pending).rejects.toMatchObject({
        name: "LlmCompleteError",
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
        message: "requester retired",
      });
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(retain.mock.calls.length);
    },
  );

  it.each(["direct", "isolated"] as const)(
    "codes source revocation during %s work before the next guard",
    async (mode) => {
      const controller = new AbortController();
      const revocation = new Error("source revoked");
      const started = createDeferredCore();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "model-reader",
        scopes: ["operator.write"],
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const waitForAbort = async (signal: AbortSignal | undefined) => {
        if (!signal) {
          throw new Error("operator signal missing");
        }
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(revocation), { once: true });
        });
      };
      if (mode === "direct") {
        mocks.acquire.mockImplementation(async (params) => {
          await waitForAbort(params.signal);
          return preparedModel();
        });
      } else {
        mocks.isolated.mockImplementation(async (params) => {
          await waitForAbort(params.abortSignal);
          return {
            text: "unreachable",
            provider: "test-provider",
            model: "allowed",
            owner: { kind: "harness", id: "test-harness" },
          };
        });
      }
      const pending = withWork(() =>
        asOperator(authority, () => completion().complete(request(mode))),
      );
      await Promise.race([started.promise, pending]);
      controller.abort(revocation);
      await expect(pending).rejects.toMatchObject({
        name: "LlmCompleteError",
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
      });
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { mode: "direct", result: "answer" },
    { mode: "isolated", result: "answer" },
    { mode: "direct", result: "denial" },
    { mode: "isolated", result: "denial" },
  ] as const)(
    "retains the requester through $mode cleanup after returning the $result",
    async ({ mode, result }) => {
      const cleanup = createDeferredCore();
      const release = vi.fn();
      const retain = vi.fn(() => release);
      let active = true;
      if (mode === "direct") {
        if (result === "denial") {
          mocks.complete.mockImplementation(async (params) => {
            void trackAsyncWork(() => cleanup.promise);
            active = false;
            params.assertCurrent?.();
            throw new Error("retired completion passed its guard");
          });
        }
        mocks.acquire.mockImplementation(async () => ({
          ...preparedModel(),
          async [Symbol.asyncDispose]() {
            await cleanup.promise;
          },
        }));
      } else {
        mocks.isolated.mockImplementation(async (params) => {
          void trackAsyncWork(() => cleanup.promise);
          if (result === "denial") {
            active = false;
            params.assertCurrent?.();
          }
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
        const pending = work.track(() =>
          asOperator(
            operator(() => {
              if (!active) {
                throw new Error("requester retired");
              }
            }, retain),
            () => completion().complete(request(mode)),
          ),
        );
        if (result === "answer") {
          await expect(pending).resolves.toMatchObject({ text: "Allowed answer." });
        } else {
          await expect(pending).rejects.toMatchObject({
            name: "LlmCompleteError",
            code: "LLM_COMPLETION_NOT_AUTHORIZED",
          });
        }
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
