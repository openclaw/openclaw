// C1 regression: a bracket [[CONTINUE_DELEGATE: ... | post-compaction]] staged
// on a turn where auto-compaction ALSO fires must survive to the next compaction
// seam. dispatchPostCompactionDelegates runs before staging, and the staged
// delegate must remain queued in the custody-backed post-compaction store until
// the next seam consumes it.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommandMaintenanceFollowup,
  prepareCommandForegroundRun,
} from "../../agents/command/maintenance.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { waitForSessionMaintenance } from "../../agents/session-maintenance/coordinator.js";
import {
  prepareSessionMaintenanceRequest,
  scheduleSessionMaintenance,
} from "../../agents/session-maintenance/run.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import {
  drainSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { testing as sessionControllerTesting } from "../../sessions/session-controller.test-support.js";
import {
  listCustodyRecordsForTest,
  useContinuationCustodyTestState,
} from "../continuation/custody/custody.test-support.js";
import { resetDelegateDispatchHedgesForTests } from "../continuation/delegate-dispatch.js";
import {
  stagedPostCompactionDelegateCount,
  stagePostCompactionDelegate,
} from "../continuation/delegate-store-post-compaction.js";
import { resetContinuationStateForTests } from "../continuation/state.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
}));
const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());
const faults = vi.hoisted(() => ({
  custodyRead: undefined as Error | undefined,
  releaseWarn: vi.fn(),
}));

// mock-isolation: One row fails the staged read; every other call reaches the real custody store.
vi.mock("../continuation/delegate-flow-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../continuation/delegate-flow-store.js")>();
  return {
    ...actual,
    listQueuedPostCompactionFlows: (sessionKey: string) =>
      faults.custodyRead
        ? Promise.reject(faults.custodyRead)
        : actual.listQueuedPostCompactionFlows(sessionKey),
  };
});

// mock-isolation: Only the byte-pressure row measures a transcript, and it is always oversized.
vi.mock("../../agents/compaction-transcript-bytes.js", () => ({
  readCompactionTranscriptBytes: async () => 102_400,
}));

// Release failures log through the continuation/compaction subsystem logger.
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "continuation/compaction"
        ? { ...logger, warn: (message: string) => faults.releaseWarn(message) }
        : logger;
    },
  };
});

// mock-isolation: Turns run through a scripted fallback runner; the real one reads auth profiles and calls providers.
vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    runCandidate: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

// mock-isolation: A scripted entry completes each run; the real entry loads the plugin runtime and agent harness.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", async () => {
  const { createSuccessfulEmbeddedAgentEntryMock } =
    await import("./agent-runner-entry.test-support.js");
  return {
    runEmbeddedAgentEntry: createSuccessfulEmbeddedAgentEntryMock(() => runWithModelFallbackMock),
  };
});

// mock-isolation: Only the summary-error check is needed; the real module loads the harness registry and command queue.
vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

// mock-isolation: Auth is fixed to api-key, so no auth profile or env credential is read.
vi.mock("../../agents/model-auth.js", () => ({
  isMissingProviderAuthError: () => false,
  resolveModelAuthMode: () => "api-key",
}));

// mock-isolation: Embedded runs and compaction are scripted; abort still reaches the real run registry.
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => runEmbeddedAgentMock(params),
  compactEmbeddedAgentSession: (params: unknown) =>
    compactState.compactEmbeddedAgentSessionMock(params),
  queueEmbeddedAgentMessage: vi.fn().mockReturnValue(false),
  abortEmbeddedAgentRun: (sessionId: string) => {
    abortEmbeddedAgentRunMock(sessionId);
    return abortEmbeddedAgentRun(sessionId);
  },
}));

// mock-isolation: CLI agent runs are recorded without spawning a CLI process.
vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

// mock-isolation: Spawn requests are recorded without starting real subagent runs.
vi.mock("../../agents/subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  SUBAGENT_SPAWN_SANDBOX_MODES: ["inherit", "require"],
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

// mock-isolation: Runtime errors are captured, and exit never reaches process.exit.
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
  },
}));

// mock-isolation: Continuation wakes are recorded without running the session-event handoff.
vi.mock("../continuation/continuation-wake.js", () => ({
  requestContinuationWake: vi.fn(),
}));

// mock-isolation: Keep the process-wide followup queue and drain registry outside runner cases.
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
  clearSessionQueues: vi.fn().mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] }),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
}));

// mock-isolation: Secret refs resolve to the given config; no Gateway or secret store is contacted.
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }),
}));

// mock-isolation: Reasoning-tag providers are fixed here; the real check asks provider plugins.
vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
// mock-isolation: Cron jobs come from the test; the real store reads the state database.
vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

// mock-isolation: No ACP sessions exist here; the process-wide ACP session manager is never created.
vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => ({ kind: "none" }),
    cancelSession: async () => {},
  }),
}));

// mock-isolation: An empty registry stands in; the real module registers process-wide maintenance and restores runs.
vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  getSwarmRunByLaunchReplayKey: () => undefined,
  initSubagentRegistry: () => {},
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner-run.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  runCandidate: (provider: string, model: string) => Promise<unknown>;
};

const custodyState = useContinuationCustodyTestState();

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  sessionControllerTesting.resetSessionControllerForTest();
  runEmbeddedAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  runtimeErrorMock.mockClear();
  abortEmbeddedAgentRunMock.mockClear();
  compactState.compactEmbeddedAgentSessionMock.mockReset();
  compactState.compactEmbeddedAgentSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  loadCronStoreMock.mockReset();
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:main:subagent:spawned",
    runId: "run-spawned",
  });
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, runCandidate }: RunWithModelFallbackParams) => ({
      result: await runCandidate(provider, model),
      provider,
      model,
      attempts: [],
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetDelegateDispatchHedgesForTests();
  resetContinuationStateForTests();
  clearRuntimeConfigSnapshot();
  clearMemoryPluginState();
  sessionControllerTesting.resetSessionControllerForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

function createContinuationRun(params: { sessionKey: string; compactionCount: number }) {
  const sessionKey = params.sessionKey;
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:1",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionEntry = {
    sessionId: "session",
    updatedAt: Date.now(),
  } satisfies SessionEntry;
  const config = {
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          minDelayMs: 0,
          maxDelayMs: 5_000,
          defaultDelayMs: 1_000,
          maxChainLength: 4,
          maxDelegatesPerTurn: 4,
        },
      },
    },
  } satisfies Record<string, unknown>;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      messageProvider: "discord",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config,
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    originatingChannel: "discord",
    originatingAccountId: "primary",
    originatingTo: "channel:1",
  } as unknown as FollowupRun;

  runEmbeddedAgentMock.mockResolvedValueOnce({
    payloads: [{ text: "Reply" }],
    meta: {
      finalAssistantVisibleText: "Reply",
      finalAssistantRawText:
        "Reply\n[[CONTINUE_DELEGATE: lifeboat survival task | post-compaction]]",
      agentMeta: {
        usage: { input: 1, output: 1 },
        ...(params.compactionCount > 0 ? { compactionCount: params.compactionCount } : {}),
      },
    },
  });

  return { sessionKey, sessionEntry, config, typing, sessionCtx, resolvedQueue, followupRun };
}

async function runDelegateTurn(
  run: ReturnType<typeof createContinuationRun>,
  sessionStore: Record<string, SessionEntry>,
  storePath?: string,
) {
  setRuntimeConfigSnapshot(run.followupRun.run.config);
  return await runReplyAgent({
    commandBody: "hello",
    followupRun: run.followupRun,
    queueKey: run.sessionKey,
    resolvedQueue: run.resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: run.typing,
    sessionCtx: run.sessionCtx,
    sessionEntry: run.sessionEntry,
    sessionStore,
    sessionKey: run.sessionKey,
    storePath,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
}

describe("runReplyAgent :: post-compaction delegate survives same-turn auto-compaction (C1)", () => {
  it("persists the staged delegate when auto-compaction fires the same turn", async () => {
    const run = createContinuationRun({ sessionKey: "c1-autocompaction", compactionCount: 1 });
    const sessionStore: Record<string, SessionEntry> = { [run.sessionKey]: run.sessionEntry };

    await runDelegateTurn(run, sessionStore);

    expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(1);
    expect(await listCustodyRecordsForTest({ ownerSessionKey: run.sessionKey })).toMatchObject([
      { kind: "post_compaction", status: "queued" },
    ]);
    expect(sessionStore[run.sessionKey]?.pendingPostCompactionDelegates ?? []).toHaveLength(0);
  });

  it("persists the staged delegate on the normal path with no compaction (baseline)", async () => {
    const run = createContinuationRun({ sessionKey: "c1-baseline", compactionCount: 0 });
    const sessionStore: Record<string, SessionEntry> = { [run.sessionKey]: run.sessionEntry };

    await runDelegateTurn(run, sessionStore);

    expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(1);
    expect(await listCustodyRecordsForTest({ ownerSessionKey: run.sessionKey })).toMatchObject([
      { kind: "post_compaction", status: "queued" },
    ]);
    expect(sessionStore[run.sessionKey]?.pendingPostCompactionDelegates ?? []).toHaveLength(0);
  });
});

describe("runReplyAgent :: pressure warning to post-compaction handoff", () => {
  const WINDOW = 200_000;
  // Upstream interns every report subtree when it shares an actor entry (eee22b41b0).
  const report = {
    systemPrompt: { chars: 0, projectContextChars: 0, nonProjectContextChars: 0 },
    injectedWorkspaceFiles: [],
    skills: { promptChars: 0, entries: [] },
    tools: { entries: [{ name: "continue_delegate" }, { name: "request_compaction" }] },
  } as unknown as SessionEntry["systemPromptReport"];

  afterEach(() => {
    resetSystemEventsForTest();
    faults.custodyRead = undefined;
    faults.releaseWarn.mockReset();
  });

  const crossTrigger = (storePath: string, key: string, totalTokens: number) =>
    patchSessionEntryCore({ storePath, sessionKey: key }, () => ({
      totalTokens,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    }));

  const pressureEvents = (queueKey: string) =>
    peekSystemEvents(queueKey).filter((event) => event.includes("[system:context-pressure]"));

  async function createPressureRun(sessionKey: string, trigger: number) {
    const run = createContinuationRun({ sessionKey, compactionCount: 0 });
    run.config.agents.defaults.continuation = {
      ...run.config.agents.defaults.continuation,
      contextPressureThreshold: 0.8,
    } as typeof run.config.agents.defaults.continuation;
    Object.assign(run.sessionEntry, {
      contextTokens: WINDOW,
      totalTokens: trigger - 20_000,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      systemPromptReport: report,
      compactionCount: 0,
    } satisfies Partial<SessionEntry>);
    const storePath = path.join(custodyState.stateDir(), "agents/main/agent/openclaw-agent.sqlite");
    await replaceSessionEntry({ storePath, sessionKey }, run.sessionEntry);
    const sessionStore = { [sessionKey]: run.sessionEntry };
    return {
      run,
      storePath,
      sessionStore,
      queueKey: resolveSystemEventQueueKey(sessionKey, "main"),
    };
  }

  it.each([
    { branch: "the 0.75 cap", reserveTokensFloor: undefined, trigger: 150_000 },
    { branch: "a memory plan's reserve", reserveTokensFloor: 90_000, trigger: 110_000 },
  ])(
    "warns, stages, compacts at $branch, then hands off",
    async ({ reserveTokensFloor, trigger }) => {
      if (reserveTokensFloor !== undefined) {
        registerMemoryCapability("memory-core", {
          flushPlanResolver: () => ({
            softThresholdTokens: 4_000,
            forceFlushTranscriptBytes: 1_000_000_000,
            reserveTokensFloor,
            prompt: "flush",
            systemPrompt: "flush",
            relativePath: "memory/flush.md",
          }),
        });
      }
      const sessionKey = `agent:main:pressure-${trigger}`;
      const { run, queueKey, sessionStore, storePath } = await createPressureRun(
        sessionKey,
        trigger,
      );

      // Turn one: past the first warning, with the handoff staged in the same turn.
      await runDelegateTurn(run, sessionStore, storePath);

      expect(compactState.compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      const warnings = pressureEvents(queueKey);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${Math.round(trigger / 1000)}k tokens`);
      expect(warnings[0]).toContain("continue_delegate(mode='post-compaction'");
      expect(warnings[0]).not.toContain("request_compaction");
      expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(1);
      expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
      drainSystemEventEntries(queueKey);

      // Turn two: the session crossed the trigger, so preflight maintenance compacts first.
      const crossed = await crossTrigger(storePath, sessionKey, trigger);
      sessionStore[sessionKey] = crossed!;
      compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          firstKeptEntryId: "kept",
          tokensBefore: trigger,
          tokensAfter: 40_000,
        },
      });
      runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "Reply" }],
        meta: {
          finalAssistantVisibleText: "Reply",
          finalAssistantRawText: "Reply",
          agentMeta: { usage: { input: 1, output: 1 } },
        },
      });
      const nextTurn = { ...run.followupRun, controllerInput: undefined };
      await runDelegateTurn(
        { ...run, sessionEntry: crossed!, followupRun: nextTurn },
        sessionStore,
        storePath,
      );

      expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
      const notices = pressureEvents(queueKey);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Post-compaction:");
      expect(stagedPostCompactionDelegateCount(run.sessionKey)).toBe(0);
      expect(await listCustodyRecordsForTest({ ownerSessionKey: run.sessionKey })).toMatchObject([
        {
          kind: "post_compaction",
          status: "succeeded",
          phase: "Durably handed off after compaction",
          handoff: { target: "session_delivery_queue" },
        },
      ]);
      expect(peekSystemEvents(queueKey)).toContainEqual(
        expect.stringContaining("Queued 1 post-compaction delegate(s)"),
      );
    },
  );

  const REFRESH = "Reload the kept file.";
  const ARMED_KEY = "agent:main:preflight";
  const ARMED_QUEUE = resolveSystemEventQueueKey(ARMED_KEY, "main");
  const countEvents = (text: string) =>
    peekSystemEvents(ARMED_QUEUE).filter((event) => event.includes(text)).length;
  const compacted = {
    ok: true,
    compacted: true,
    result: { summary: "compacted", firstKeptEntryId: "kept", tokensBefore: 1, tokensAfter: 1 },
  };
  const skipped = { ok: true, compacted: false, reason: "nothing to compact" };
  const refused = { ok: false, compacted: false, reason: "fixture refused" };

  /** A session past the trigger, with a delegate staged and a refresh its workspace supplies. */
  async function armPreflight(compaction?: object, inRunCompactions = 0, tokens = 150_000) {
    const armed = await createPressureRun(ARMED_KEY, 150_000);
    const { run, sessionStore, storePath } = armed;
    Object.assign(run.config.agents.defaults, {
      compaction: { postCompactionSections: ["Session Startup"], ...compaction },
    });
    const workspaceDir = (run.followupRun.run.workspaceDir = custodyState.stateDir());
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), `## Session Startup\n\n${REFRESH}\n`);
    await stagePostCompactionDelegate(ARMED_KEY, { task: "lifeboat", createdAt: Date.now() });
    const crossed = (await crossTrigger(storePath, ARMED_KEY, tokens))!;
    sessionStore[ARMED_KEY] = crossed;
    runEmbeddedAgentMock.mockReset().mockImplementation(async (attempt) => {
      attempt.onAutoCompactionSucceeded(inRunCompactions);
      const text = "Reply";
      return {
        payloads: [{ text }],
        meta: { finalAssistantVisibleText: text, finalAssistantRawText: text, agentMeta: {} },
      };
    });
    setRuntimeConfigSnapshot(run.followupRun.run.config);
    const turn = () => runDelegateTurn({ ...run, sessionEntry: crossed }, sessionStore, storePath);
    return { ...armed, crossed, turn, workspaceDir };
  }

  /** Counted, because `toContainEqual` would not notice a second release. */
  async function expectCustody(handedOff: boolean, emptyReleases = 0) {
    expect(stagedPostCompactionDelegateCount(ARMED_KEY)).toBe(handedOff ? 0 : 1);
    const records = await listCustodyRecordsForTest({ ownerSessionKey: ARMED_KEY });
    expect(records.map(({ handoff, status }) => ({ status, to: handoff?.target }))).toEqual([
      handedOff ? { status: "succeeded", to: "session_delivery_queue" } : { status: "queued" },
    ]);
    expect(countEvents("Queued 1 post-compaction")).toBe(handedOff ? 1 : 0);
    expect(countEvents("Queued 0 post-compaction")).toBe(emptyReleases);
  }

  // Upstream #200714: a failed preflight compaction fails the turn only when the request cannot
  // fit the context window; one that still fits proceeds. Either way the delegate stays staged.
  it.each([
    { outcome: "a benign skip", result: skipped, reply: "Reply" },
    {
      outcome: "a required compaction's failure",
      result: refused,
      reply: "couldn't shorten it",
      tokens: WINDOW + 10_000,
    },
    { outcome: "a failed compaction whose request still fits", result: refused, reply: "Reply" },
    { outcome: "a context_bounded return", result: refused, reply: "Reply", byteLimit: "32kb" },
  ])("keeps the delegate staged after $outcome", async ({ byteLimit, reply, result, tokens }) => {
    const armed = await armPreflight({ maxActiveTranscriptBytes: byteLimit }, 0, tokens);
    compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce(result);

    const replies = [await armed.turn()].flat();

    expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
    expect(replies.at(-1)?.text).toContain(reply);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(reply === "Reply" ? 1 : 0);
    await expectCustody(false);
  });

  it("keeps the delegate staged when the staged read throws, and the turn proceeds", async () => {
    const armed = await armPreflight();
    faults.custodyRead = new Error("custody store unavailable");
    compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce(compacted);

    expect(await armed.turn()).toMatchObject({ text: "Reply" });

    expect(faults.releaseWarn).toHaveBeenCalledExactlyOnceWith(
      `[continuation:post-compaction-release-failed] session=${ARMED_KEY} seam=maintenance reason=custody store unavailable`,
    );
    await expectCustody(false);
  });

  it.each([0, 1])(
    "hands off once from a reply turn whose prompt carries the refresh (in-run compactions: %i)",
    async (inRunCompactions) => {
      const armed = await armPreflight(undefined, inRunCompactions);
      compactState.compactEmbeddedAgentSessionMock.mockResolvedValueOnce(compacted);

      await armed.turn();

      expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
        extraSystemPrompt: expect.stringContaining(REFRESH),
      });
      // Only the in-run compaction's own post-run release queues an event, and it has nothing left.
      expect(countEvents(REFRESH)).toBe(inRunCompactions);
      await expectCustody(true, inRunCompactions);
    },
  );

  it.each([true, false])(
    "a command queues the refresh and hands off once (preflight compaction: %s)",
    async (preflight) => {
      const { crossed, run, sessionStore, storePath, workspaceDir } = await armPreflight();
      compactState.compactEmbeddedAgentSessionMock.mockResolvedValue(compacted);
      const cfg = run.followupRun.run.config;
      const { sessionId } = crossed;
      const session = { sessionKey: ARMED_KEY, sessionId, sessionStore, storePath, workspaceDir };
      const model = { provider: "anthropic", model: "claude" };
      const command = {
        prepared: { ...session, cfg, runId: "command", sessionAgentId: "main", timeoutMs: 60_000 },
        opts: {},
        sessionEntry: crossed,
        embeddedSessionState: { runContext: {}, skillsSnapshot: {} },
        modelSelection: { ...model, defaultModel: "anthropic/claude-opus-4-6" },
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      } as unknown as Parameters<typeof prepareCommandForegroundRun>[0];

      if (preflight) {
        await (await prepareCommandForegroundRun(command)).admission.finish();
        expect(countEvents(REFRESH)).toBe(1);
        expect(countEvents("Queued 1 post-compaction")).toBe(1);
        await crossTrigger(storePath, ARMED_KEY, 150_000);
      }
      const followupRun = createCommandMaintenanceFollowup({
        ...command,
        ...model,
        sessionEntry: crossed,
        thinkLevel: "low",
        // Upstream now requires the route's catalog; this fixture route has none.
        thinkingCatalog: undefined,
        senderIsOwner: false,
      });
      // Upstream prepares the maintenance source cohort before the synchronous scheduler.
      const request = await prepareSessionMaintenanceRequest({
        prepared: { cfg, sessionKey: ARMED_KEY, storePath, timeoutMs: 60_000 },
        followupRun,
        sessionId,
        lifecycleRevision: crossed.lifecycleRevision,
        lifecycleGeneration: command.lifecycleGeneration,
        startedAt: Date.now(),
      });
      if (!request) {
        throw new Error("session maintenance source unavailable");
      }
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
        () => scheduleSessionMaintenance(request),
      );
      await waitForSessionMaintenance(ARMED_KEY);

      expect(compactState.compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(preflight ? 2 : 1);
      expect(countEvents(REFRESH)).toBe(preflight ? 2 : 1);
      await expectCustody(true, preflight ? 1 : 0);
    },
  );
});
