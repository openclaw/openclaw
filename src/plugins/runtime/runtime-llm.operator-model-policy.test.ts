import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import type * as CompletionRuntime from "../../agents/simple-completion-runtime.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { ZERO_USAGE_FIXTURE } from "../../agents/test-helpers/usage-fixtures.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  acquire: vi.fn<typeof CompletionRuntime.acquireSimpleCompletionModelForAgent>(),
  complete: vi.fn<typeof CompletionRuntime.completeWithPreparedSimpleCompletionModel>(),
  select: vi.fn<typeof CompletionRuntime.resolveSimpleCompletionSelectionForAgent>(),
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
const operatorSource = {
  profileId: "model-reader",
  scopes: ["operator.write"],
  assertCurrent() {},
};
const preparePolicy = (allow = ["test-provider/allowed"]) =>
  prepareOperatorModelPolicy({ cfg, policy: { sourceAgent: "main", allow }, manifestPlugins: [] });

function preparedModel(modelId = "allowed", selectedId = "allowed") {
  return {
    async [Symbol.asyncDispose]() {},
    selection: { ...selection, modelId: selectedId },
    model: makeProviderModelFixture({
      provider: "test-provider",
      id: modelId,
      api: "openai-completions" as const,
      baseUrl: "https://fixture.invalid/v1",
    }),
    auth: { apiKey: "synthetic-test-key", source: "fixture", mode: "api-key" as const },
  };
}

function isolatedAnswer(text = "Allowed answer.") {
  return {
    text,
    provider: "test-provider",
    model: "allowed",
    owner: { kind: "harness" as const, id: "test-harness" },
  };
}

function requester() {
  let active = true;
  const release = vi.fn();
  const retain = vi.fn(() => release);
  return {
    release,
    retain,
    retire: () => {
      active = false;
    },
    authority: operator(() => {
      if (!active) {
        throw new Error("requester retired");
      }
    }, retain),
  };
}

async function expectDenied(pending: Promise<unknown>, message?: unknown) {
  await expect(pending).rejects.toMatchObject({
    name: "LlmCompleteError",
    code: "LLM_COMPLETION_NOT_AUTHORIZED",
    ...(message ? { message } : {}),
  });
}

function waitForWork(started: Promise<unknown>, pending: Promise<unknown>) {
  return Promise.race([
    started,
    pending.then(() => {
      throw new Error("completion settled before work started");
    }),
  ]);
}

function operator(assertCurrent: () => void = () => {}, retain?: () => () => void) {
  return createAdmittedRunOperatorAuthority({
    ...operatorSource,
    assertCurrent,
    retain,
    modelPolicy: preparePolicy(),
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
                ...createOperatorClient(operatorSource),
                internal: { operatorRunAuthority: authority },
              },
        isWebchatConnect: () => source === "request",
      },
      run,
    );
  }
  return withOperatorToolGatewayAuthority(
    {
      authenticatedUserProfile: createOperatorClient(operatorSource).authenticatedUserProfile,
      scopes: ["operator.write"],
      ...(source === "direct-tool" ? { operatorRunAuthority: authority } : {}),
    },
    run,
  );
}

function completeAs(
  authority: AdmittedRunOperatorAuthority,
  mode: CompletionMode,
  source: OperatorSource = "agent-tool",
) {
  return withWork(() => asOperator(authority, () => completion().complete(request(mode)), source));
}

async function withWork<T>(run: () => Promise<T>): Promise<T> {
  const work = new AsyncWorkScope();
  try {
    return await work.track(run);
  } finally {
    await work.drain();
  }
}

function pauseExecution(mode: CompletionMode, wait: (signal?: AbortSignal) => Promise<unknown>) {
  if (mode === "direct") {
    mocks.acquire.mockImplementation(async ({ signal }) => {
      await wait(signal);
      return preparedModel();
    });
  } else {
    mocks.isolated.mockImplementation(async (params) => {
      await wait(params.abortSignal);
      params.assertCurrent?.();
      return isolatedAnswer();
    });
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockReturnValue(selection);
  mocks.acquire.mockImplementation(async () => preparedModel());
  mocks.complete.mockImplementation(async (params) => {
    params.assertCurrent?.();
    return makeAgentAssistantMessage({
      content: [{ type: "text", text: "Allowed answer." }],
      api: "openai-completions",
      provider: "test-provider",
      model: "allowed",
      usage: { ...ZERO_USAGE_FIXTURE, input: 1, output: 1, totalTokens: 2 },
    });
  });
  mocks.isolated.mockImplementation(async (params) => {
    params.assertCurrent?.();
    return isolatedAnswer();
  });
});

describe("operator model policy on plugin completions", () => {
  it.each(["restricted model", "cancelled request", "replaced caller"] as const)(
    "preserves the original scoped requester during profile preparation: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("completion-reader@example.test");
        setUserProfileRole(profile.id, "reader");
        const context = createContext();
        const reader: GatewayOperatorRoleDefinition = {
          agents: [],
          sessions: { others: "none" },
          scopes: ["operator.write"],
          modelPolicy: { allow: ["test-provider/allowed"] },
        };
        context.getRuntimeConfig = () => ({
          ...cfg,
          gateway: { roles: { definitions: { reader } } },
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
      let policy =
        initial === "restricted"
          ? preparePolicy(["test-provider/model-a", "test-provider/model-b"])
          : undefined;
      const observers = new Set<() => void>();
      const authority = createAdmittedRunOperatorAuthority({
        ...operatorSource,
        get modelPolicy() {
          return policy;
        },
        onModelPolicyChanged: (listener) => {
          observers.add(listener);
          return () => observers.delete(listener);
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
      mocks.acquire.mockImplementation(async ({ modelRef = "model-a" }) =>
        preparedModel(modelRef, modelRef),
      );
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
      const run = (model: string) =>
        work.track(() =>
          asOperator(authority, () => llm.complete({ ...request("direct"), model })),
        );
      const first = run("model-a");
      // Vitest's manual mock loader shares import callstacks; overlap provider work after import.
      const second = waitForWork(firstStarted.promise, first).then(() => run("model-b"));
      try {
        await waitForWork(started.promise, Promise.all([first, second]));
        policy = preparePolicy(["test-provider/model-b"]);
        observers.forEach((listener) => listener());
        expect(signals.get("model-a")?.aborted).toBe(true);
        expect(signals.get("model-b")?.aborted).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
        finishA.resolve();
        await expectDenied(first, expect.stringContaining("cannot use this model"));
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
        mocks.acquire.mockResolvedValue(preparedModel("blocked", "blocked"));
      }
      const authority = operator(() => {
        if (denial === "retired requester") {
          throw new Error("requester retired");
        }
      });
      await expectDenied(
        completeAs(authority, mode, source),
        denial === "retired requester"
          ? "requester retired"
          : denial === "missing binding"
            ? "Plugin model completion requires its current Gateway binding."
            : expect.stringContaining(
                source === "unbound-operator"
                  ? "requires original Gateway authority"
                  : "cannot use this model",
              ),
      );
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
        completeAs(authority, mode, mode === "direct" ? "direct-tool" : "agent-tool"),
      ).resolves.toMatchObject({ text: "Allowed answer." });
      expect(mode === "direct" ? mocks.complete : mocks.isolated).toHaveBeenCalledOnce();
    },
  );

  it("keeps the host-bound context engine independent of the ambient requester", async () => {
    mocks.select.mockReturnValue({ ...selection, modelId: "system-model" });
    mocks.acquire.mockResolvedValue(preparedModel("system-model", "system-model"));
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
      const { authority, retire, release, retain } = requester();
      pauseExecution(mode, async () => {
        started.resolve();
        await resume.promise;
      });
      const pending = completeAs(authority, mode);
      await waitForWork(started.promise, pending);
      retire();
      resume.resolve();
      await expectDenied(pending, "requester retired");
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
        ...operatorSource,
        signal: controller.signal,
      });
      pauseExecution(mode, async (signal) => {
        if (!signal) {
          throw new Error("operator signal missing");
        }
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(revocation), { once: true });
        });
      });
      const pending = completeAs(authority, mode);
      await Promise.race([started.promise, pending]);
      controller.abort(revocation);
      await expectDenied(pending);
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
      const { authority, retire, release, retain } = requester();
      if (mode === "direct") {
        if (result === "denial") {
          mocks.complete.mockImplementation(async (params) => {
            void trackAsyncWork(() => cleanup.promise);
            retire();
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
            retire();
            params.assertCurrent?.();
          }
          return isolatedAnswer();
        });
      }
      const work = new AsyncWorkScope();
      try {
        const pending = work.track(() =>
          asOperator(authority, () => completion().complete(request(mode))),
        );
        if (result === "answer") {
          await expect(pending).resolves.toMatchObject({ text: "Allowed answer." });
        } else {
          await expectDenied(pending);
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
