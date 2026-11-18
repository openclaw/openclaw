import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSubsystemLogger } from "../../../test/helpers/mock-subsystem-logger.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { getActiveEmbeddedRunSnapshot } from "../../agents/embedded-agent-runner/runs.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { FailoverError } from "../../agents/failover-error.js";
import { resetFallbackSkipCacheForTest } from "../../agents/fallback-skip-cache.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";

const state = vi.hoisted(() => ({
  cli: vi.fn<(params: RunCliAgentParams) => Promise<EmbeddedAgentRunResult>>(),
  embedded: vi.fn<(params: RunEmbeddedAgentInternalParams) => Promise<EmbeddedAgentRunResult>>(),
  toolsAllow: undefined as string[] | undefined,
  locked: false,
  entry: { sessionId: "session-talk", updatedAt: 1 } as SessionEntry,
  clearBinding: vi.fn(),
  readSessionEntry: vi.fn<() => Promise<SessionEntry | undefined>>(),
}));

// mock-isolation: Keep CLI continuity writes in memory while testing the admitted turn owner.
vi.mock("../../agents/cli-session-store.js", () => ({
  clearCliSessionInStore: state.clearBinding,
  persistStoppedFirstCliSessionInStore: async () => undefined,
  persistCliSessionBindingResult: async ({ result }: { result: EmbeddedAgentRunResult }) => result,
  buildCliSessionForkRunParams: (_params: unknown, onEntry: (entry: SessionEntry) => void) => ({
    persistCliSessionForkSuccessor: async (sessionId: string) =>
      onEntry({ ...state.entry, cliSessionBindings: { "claude-cli": { sessionId } } }),
  }),
}));
// mock-isolation: Exercise routing and settlement without launching a model subprocess.
vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: state.cli }));
// mock-isolation: Exercise routing and settlement without launching an embedded model.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: state.embedded }));
// mock-isolation: Runtime selection is real; plugin loading is outside this fixture's contract.
vi.mock("../../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));
// mock-isolation: The synthetic CLI has no provider credentials to forward.
vi.mock("../../agents/cli-execution-auth.js", () => ({
  cliBackendAcceptsAuthProfileForwarding: () => false,
}));
// mock-isolation: Control session-read failures without starting a database worker.
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: state.readSessionEntry,
  readSessionEntryReadOnlyInWorker: async (_target: unknown, assertCurrent: () => void) => {
    assertCurrent();
    return state.entry;
  },
}));
// mock-isolation: Keep transcript storage outside this browser admission/routing composition.
vi.mock("../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: async (params: {
    cfg: OpenClawConfig;
    agentRuntime: {
      runEmbeddedAgent: (params: RunEmbeddedAgentInternalParams) => Promise<EmbeddedAgentRunResult>;
    };
    abortSignal?: AbortSignal;
    onRunStarted?: (params: { runId: string; sessionId: string; timeoutMs: number }) => unknown;
  }) => {
    params.onRunStarted?.({
      runId: "talk-routing-test",
      sessionId: "session-talk",
      timeoutMs: 10000,
    });
    return params.agentRuntime.runEmbeddedAgent({
      config: params.cfg,
      prompt: "Generated voice consult",
      agentId: "main",
      sessionId: "session-talk",
      sessionKey: "agent:main:talk",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-talk",
        sessionKey: "agent:main:talk",
        storePath: "/tmp/talk-routing-test",
      },
      workspaceDir: "/tmp/talk-routing-workspace",
      agentDir: "/tmp/talk-routing-agent",
      runId: "talk-routing-test",
      timeoutMs: 10000,
      senderId: "viewer",
      senderIsOwner: false,
      toolsAllow: state.toolsAllow,
      abortSignal: params.abortSignal,
    });
  },
}));

const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-fixture", fallbacks: ["fallback/fixture"] },
      models: { "anthropic/claude-fixture": { agentRuntime: { id: "claude-cli" } } },
    },
  },
};
const result = (text: string): EmbeddedAgentRunResult => ({
  payloads: [{ text }],
  meta: { durationMs: 1 },
});
const createRunner = (ownerConnId?: string, selectedConfig = config) => {
  setRuntimeConfigSnapshot(selectedConfig);
  return createTalkClientAgentConsultRunner({
    config: selectedConfig,
    ownerConnId,
    context: { logGateway: createMockSubsystemLogger("gateway/test") },
    sessionTarget: {
      agentId: "main",
      sessionKey: "agent:main:talk",
      canonicalKey: "agent:main:talk",
      storePath: "/tmp/talk-routing-test",
      assertCurrent: () => undefined,
    },
    getVoiceSessionId: () => "voice-routing-test",
    initialItems: [],
    registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true })),
  });
};
const run = (signal?: AbortSignal) => createRunner().runPrompt({ prompt: "Answer", signal });

const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
let unsubscribe: () => void;
beforeEach(() => {
  resetFallbackSkipCacheForTest();
  state.cli.mockReset().mockResolvedValue(result("CLI answer"));
  state.embedded.mockReset().mockResolvedValue(result("Fallback answer"));
  state.toolsAllow = undefined;
  state.locked = false;
  state.entry = { sessionId: "session-talk", updatedAt: 1 };
  state.clearBinding.mockReset().mockResolvedValue(undefined);
  state.readSessionEntry.mockReset().mockImplementation(async () => ({
    ...state.entry,
    modelSelectionLocked: state.locked,
  }));
  events.length = 0;
  unsubscribe = onAgentEvent((event) => {
    if (event.runId === "talk-routing-test") {
      events.push(event);
    }
  });
});
afterEach(() => {
  unsubscribe();
  clearRuntimeConfigSnapshot();
});

describe("browser Talk configured model routing", () => {
  it.each([
    { provider: "anthropic", model: "hook-selected", cli: true },
    { provider: "fallback", model: "hook-selected", cli: false },
  ])("honors a model hook before selecting the runtime: %j", async ({ provider, model, cli }) => {
    const selectedConfig = structuredClone(config);
    selectedConfig.agents!.defaults!.models!["anthropic/hook-selected"] = {
      agentRuntime: { id: "claude-cli" },
    };
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "talk-routing-test",
      hookName: "before_model_resolve",
      source: "test",
      handler: () => ({ providerOverride: provider, modelOverride: model }),
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    try {
      await createRunner(undefined, selectedConfig).runPrompt({ prompt: "Use hook routing" });
      const selected = cli ? state.cli : state.embedded;
      const other = cli ? state.embedded : state.cli;
      expect(selected).toHaveBeenCalledOnce();
      expect(other).not.toHaveBeenCalled();
      expect(selected.mock.calls[0]![0]).toMatchObject({
        provider: cli ? "claude-cli" : provider,
        ...(cli ? { modelProvider: provider } : {}),
        model,
      });
    } finally {
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
    }
  });
  it.each([{ toolsAllow: undefined }, { toolsAllow: ["read"] }, { toolsAllow: [] }])(
    "uses the model CLI without direct API auth and retains cap %j",
    async ({ toolsAllow }) => {
      state.toolsAllow = toolsAllow;
      await expect(run()).resolves.toMatchObject({ payloads: [{ text: "CLI answer" }] });
      expect(state.embedded).not.toHaveBeenCalled();
      expect(state.cli).toHaveBeenCalledOnce();
      const candidate = state.cli.mock.calls[0]![0];
      expect(candidate.provider).toBe("claude-cli");
      expect(candidate.modelProvider).toBe("anthropic");
      expect(candidate.toolsAllow).toEqual(toolsAllow);
      expect(candidate.senderId).toBe("viewer");
      expect(candidate.senderIsOwner).toBe(false);
      expect(await candidate.userTurnTranscriptRecorder?.resolveMessage()).toMatchObject({
        display: false,
        excludeFromContext: true,
      });
      expect(
        events.filter(
          (event) =>
            event.stream === "lifecycle" && ["end", "error"].includes(String(event.data.phase)),
        ),
      ).toHaveLength(1);
    },
  );

  it("falls back within the same admitted turn and returns the winner's provenance", async () => {
    state.cli.mockRejectedValueOnce(
      new FailoverError("429 rate limit exceeded", {
        provider: "anthropic",
        model: "claude-fixture",
        reason: "rate_limit",
      }),
    );
    await expect(run()).resolves.toMatchObject({
      payloads: [{ text: "Fallback answer" }],
      meta: { executionTrace: { fallbackUsed: true, winnerProvider: "fallback" } },
    });
    expect(state.cli).toHaveBeenCalledOnce();
    expect(state.embedded).toHaveBeenCalledOnce();
    const primary = state.cli.mock.calls[0]![0];
    const fallback = state.embedded.mock.calls[0]![0];
    expect(fallback.preparedRunAdmission).toBe(primary.preparedRunAdmission);
    expect(fallback.userTurnTranscriptRecorder).toBe(primary.userTurnTranscriptRecorder);
    expect(fallback.abortSignal).toBe(primary.abortSignal);
    expect(fallback.runId).toBe(primary.runId);
    expect(fallback.modelRoutingProvenance).toMatchObject({
      stage: "fallback",
      fallbackReason: "rate_limit",
    });
    expect(
      events.filter(
        (event) =>
          event.stream === "lifecycle" && ["end", "error"].includes(String(event.data.phase)),
      ),
    ).toHaveLength(1);
  });

  it("selects a CLI runtime when it is the fallback candidate", async () => {
    state.embedded.mockRejectedValueOnce(new FailoverError("overloaded", { reason: "overloaded" }));
    const selectedConfig: OpenClawConfig = {
      agents: {
        defaults: {
          ...config.agents?.defaults,
          model: { primary: "fallback/fixture", fallbacks: ["anthropic/claude-fixture"] },
        },
      },
    };
    const runner = createRunner(undefined, selectedConfig);
    await expect(runner.runPrompt({ prompt: "Answer" })).resolves.toMatchObject({
      payloads: [{ text: "CLI answer" }],
    });
    expect(state.embedded).toHaveBeenCalledOnce();
    expect(state.cli).toHaveBeenCalledOnce();
    expect(state.cli.mock.calls[0]?.[0].modelRoutingProvenance).toMatchObject({
      stage: "fallback",
      fallbackReason: "overloaded",
    });
  });

  it.each([false, true])(
    "retains an adopted completion claim across CLI dispatch (fallback=%s)",
    async (fallback) => {
      if (fallback) {
        state.cli.mockRejectedValueOnce(
          new FailoverError("429 rate limit exceeded", { reason: "rate_limit" }),
        );
      }
      const runner = createRunner();
      runner.runPrompt.adoptCompletionClaims();
      await expect(runner.runPrompt({ prompt: "Answer" })).resolves.toMatchObject({
        payloads: [{ text: fallback ? "Fallback answer" : "CLI answer" }],
      });
      expect(state.embedded).toHaveBeenCalledTimes(fallback ? 1 : 0);
      expect(runner.runPrompt.claimAppend()).toBe(true);
      expect(runner.runPrompt.claimAppend()).toBe(false);
    },
  );

  it("does not start a fallback after cancellation of the primary", async () => {
    const controller = new AbortController();
    state.cli.mockImplementationOnce(async () => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw new FailoverError("429 rate limit exceeded", { reason: "rate_limit" });
    });
    await expect(run(controller.signal)).rejects.toThrow();
    expect(state.embedded).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "fork-aborted", clear: true },
    { failure: "resume-aborted", clear: false },
    { failure: "expired", clear: true },
  ])("cleans only invalid CLI continuity after $failure", async ({ failure, clear }) => {
    state.entry.cliSessionBindings = { "claude-cli": { sessionId: "original-cli" } };
    state.cli.mockImplementationOnce(async (params) => {
      if (failure === "fork-aborted") {
        await params.persistCliSessionForkSuccessor?.("successor-cli");
      }
      if (failure === "expired") {
        throw new FailoverError("session expired", { reason: "session_expired" });
      }
      throw new DOMException("CLI interrupted", "AbortError");
    });
    await run().catch(() => {});
    if (clear) {
      expect(state.clearBinding).toHaveBeenCalledOnce();
      expect(state.clearBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedCliSessionId: failure === "fork-aborted" ? "successor-cli" : "original-cli",
          expectedSessionId: "session-talk",
          assertCommitAllowed: expect.any(Function),
        }),
      );
    } else {
      expect(state.clearBinding).not.toHaveBeenCalled();
    }
  });

  it.each(["session-read failure", "model-locked session"] as const)(
    "settles a %s before either runtime executes",
    async (failure) => {
      const error =
        failure === "session-read failure"
          ? new Error("session read unavailable")
          : new ModelSelectionLockedError();
      if (failure === "session-read failure") {
        state.readSessionEntry.mockRejectedValueOnce(error);
      } else {
        state.locked = true;
      }
      const runner = createRunner();
      runner.runPrompt.adoptCompletionClaims();
      const pending = runner.runPrompt({ prompt: "Answer" });
      try {
        if (failure === "session-read failure") {
          await expect(pending).rejects.toBe(error);
        } else {
          await expect(pending).rejects.toBeInstanceOf(ModelSelectionLockedError);
        }
        expect(events.filter((event) => event.stream === "lifecycle")).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              phase: "error",
              error: expect.stringContaining(error.message),
              executionSettled: true,
            }),
          }),
        ]);
        expect(state.cli).not.toHaveBeenCalled();
        expect(state.embedded).not.toHaveBeenCalled();
        expect(state.clearBinding).not.toHaveBeenCalled();
        expect(getActiveEmbeddedRunSnapshot("session-talk")).toBeUndefined();
        expect(runner.runPrompt.claimFailureAppend()).toBe(true);
        expect(runner.runPrompt.claimFailureAppend()).toBe(false);
      } finally {
        runner.runPrompt.claimFailureAppend();
      }
    },
  );

  it("settles cancellation during preflight without starting a runtime", async () => {
    const started = Promise.withResolvers<void>();
    const read = Promise.withResolvers<SessionEntry>();
    state.readSessionEntry.mockImplementationOnce(() => {
      started.resolve();
      return read.promise;
    });
    const controller = new AbortController();
    const pending = run(controller.signal);
    try {
      await awaitGateBeforeSettlement(started.promise, pending, "session read did not start");
      controller.abort(new DOMException("preflight cancelled", "AbortError"));
      read.resolve(state.entry);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      read.resolve(state.entry);
      await pending.catch(() => {});
    }
    expect(events.filter((event) => event.stream === "lifecycle")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "error",
          aborted: true,
          executionSettled: true,
        }),
      }),
    ]);
    expect(state.cli).not.toHaveBeenCalled();
    expect(state.embedded).not.toHaveBeenCalled();
    expect(state.clearBinding).not.toHaveBeenCalled();
    expect(getActiveEmbeddedRunSnapshot("session-talk")).toBeUndefined();
  });
});
