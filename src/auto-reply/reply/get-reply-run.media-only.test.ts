// Tests media-only get-reply runs and sandboxed media attachment handling.
import "./get-reply-run.runtime-mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { hasControlCommand } from "../command-detection.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import {
  loadAgentRunnerRuntime,
  loadEmbeddedAgentRuntime,
  loadSessionUpdatesRuntime,
} from "./get-reply-run-helpers.js";
import { runPreparedReply } from "./get-reply-run.js";
import { registerPendingRequesterAuthorityCases } from "./get-reply-run.requester-authority.test-support.js";
import { registerSystemEventAdmissionCases } from "./get-reply-run.system-event-admission.test-support.js";
import {
  baseParams,
  createInboundBody,
  createInboundTurn,
  createSessionBody,
  createSessionTurn,
  createProviderSurface,
  ownerParams,
} from "./get-reply-run.test-support.js";
import { buildDirectChatContext, buildGroupChatContext, buildGroupIntro } from "./groups.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, createReplyOperation } from "./reply-run-registry.js";
import { getActiveReplyRunCount } from "./reply-run-registry.registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import {
  createSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { withReplySystemEventContext } from "./system-event-session-key.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/embedded-agent.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedAgentRunStreaming: vi.fn().mockReturnValue(false),
  preemptAndDrainEmbeddedHeartbeatRun: vi.fn().mockResolvedValue("not-heartbeat"),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn().mockReturnValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: vi.fn((params: { message: unknown }) => params.message),
}));

// Harness selection and built-in execution are owned by their focused suites. These tests keep
// the real visible-reply policy resolver while supplying its default delivery metadata.
const preparedReplyMockState = vi.hoisted(() => ({
  unexpectedCalls: [] as string[],
}));
const envMockState = vi.hoisted(() => ({ fastTestRuntime: true }));

vi.mock("../../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/env.js")>()),
  isFastTestRuntimeEnv: () => envMockState.fastTestRuntime,
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("../../config/sessions/restart-recovery-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/restart-recovery-state.js")>()),
  isMainRestartRecoveryCandidate: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-store.js", () => ({
  claimMainSessionRecoveryOwner: vi.fn(),
  releaseMainSessionRecoveryOwner: vi.fn(),
}));

// Provider profile discovery is owned by thinking.test.ts. Keep the real thinking-policy
// projection here while preventing an unrelated active-plugin and public-artifact graph load.
vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

vi.mock("../../agents/agent-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: (params: {
    config: { tools?: { allow?: string[]; deny?: string[] } };
  }) => ({
    globalPolicy: params.config.tools
      ? { allow: params.config.tools.allow, deny: params.config.tools.deny }
      : undefined,
    globalProviderPolicy: undefined,
    agentPolicy: undefined,
    agentProviderPolicy: undefined,
    profile: undefined,
    providerProfile: undefined,
    profileAlsoAllow: undefined,
    providerProfileAlsoAllow: undefined,
  }),
  resolveGroupToolPolicy: () => undefined,
  resolveInheritedToolPolicyForSession: () => undefined,
  resolveSubagentToolPolicyForSession: () => undefined,
}));

vi.mock("../../agents/subagents/spawn/subagent-capabilities.js", () => ({
  isSubagentEnvelopeSession: vi.fn().mockReturnValue(false),
  resolveSubagentCapabilityStore: vi.fn().mockReturnValue(undefined),
}));

const resolveAgentHarnessDeliveryDefaultsMock = vi.hoisted(() =>
  vi.fn(
    (params: {
      provider: string;
      modelId?: string;
      agentHarnessId?: string;
      agentHarnessRuntimeOverride?: string;
    }) => {
      const isSourceProviderCandidate = params.modelId === undefined;
      const isDefaultModelCandidate =
        params.provider === "anthropic" && params.modelId === "claude-opus-4-1";
      if (
        (!isSourceProviderCandidate && !isDefaultModelCandidate) ||
        params.agentHarnessId ||
        params.agentHarnessRuntimeOverride
      ) {
        preparedReplyMockState.unexpectedCalls.push("resolveAgentHarnessDeliveryDefaults");
      }
      return {};
    },
  ),
);
vi.mock("../../agents/harness/selection-decision.js", () => ({
  resolveAgentHarnessDeliveryDefaults: resolveAgentHarnessDeliveryDefaultsMock,
}));

vi.mock("../../agents/model-selection.js", () => ({
  buildModelAliasIndex: vi.fn(
    (params: { cfg: { agents?: { defaults?: { models?: unknown } } } }) => {
      if (params.cfg.agents?.defaults?.models) {
        preparedReplyMockState.unexpectedCalls.push("buildModelAliasIndex");
      }
      return { byAlias: new Map(), byKey: new Map() };
    },
  ),
  resolveDefaultModelForAgent: vi.fn(
    (params: { cfg: { agents?: { defaults?: { model?: unknown } } } }) => {
      if (params.cfg.agents?.defaults?.model) {
        preparedReplyMockState.unexpectedCalls.push("resolveDefaultModelForAgent");
      }
      return { provider: "anthropic", model: "claude-opus-4-1" };
    },
  ),
  resolveModelRefFromString: vi.fn(() => {
    preparedReplyMockState.unexpectedCalls.push("resolveModelRefFromString");
    return undefined;
  }),
}));

const resolveSessionRuntimeOverrideForProviderMock = vi.hoisted(() =>
  vi.fn(
    (params: {
      entry?: {
        agentHarnessId?: string;
        agentRuntimeOverride?: string;
        modelSelectionLocked?: boolean;
      };
    }) => {
      if (
        params.entry?.agentHarnessId ||
        params.entry?.agentRuntimeOverride ||
        params.entry?.modelSelectionLocked
      ) {
        preparedReplyMockState.unexpectedCalls.push("resolveSessionRuntimeOverrideForProvider");
      }
      return undefined;
    },
  ),
);
vi.mock("../../agents/session-runtime-compat.js", () => ({
  resolveSessionRuntimeOverrideForProvider: resolveSessionRuntimeOverrideForProviderMock,
}));

// Provider policy projection belongs to its adapter and provider-local suites. These tests
// exercise prepared reply orchestration and supply their own model/thinking facts.
vi.mock("../../plugins/provider-policy-surface.js", () => ({
  resolveDirectBundledProviderPolicySurface: () => null,
  resolveTrustedExternalProviderPolicySurface: () => null,
}));

vi.mock("../../config/sessions/group.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePathCore: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  resolveSessionStorePathCore: vi.fn().mockReturnValue("/tmp/session-store"),
}));

const loadSessionEntryMock = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/session-sharing-preparation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../gateway/session-sharing-preparation.js")>();
  return {
    ...actual,
    prepareSessionMutationFacts: async (params: { sessionKey: string; agentId: string }) => {
      let active = true;
      const target = {
        agentId: params.agentId,
        canonicalKey: params.sessionKey,
        storeKey: params.sessionKey,
        storeKeys: [params.sessionKey],
        storePath: "/synthetic/requester.sqlite",
      };
      return {
        storageTarget: target,
        bindCreation: vi.fn(),
        readCurrent: () => {
          if (!active) {
            throw new Error("Requester session facts retired");
          }
          const entry = loadSessionEntryMock();
          return { target: entry ? { ...target, entry } : null, membership: new Set() };
        },
        release: () => {
          active = false;
        },
      };
    },
  };
});
const updateAmbientTranscriptWatermarkMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: vi.fn().mockReturnValue([]),
  loadSessionEntry: loadSessionEntryMock,
  loadSessionEntryReadOnly: loadSessionEntryMock,
  patchSessionEntryCore: vi.fn(),
  persistSessionTranscriptTurn: vi.fn(),
}));

vi.mock("../../config/sessions/ambient-transcript-watermark.js", () => ({
  updateAmbientTranscriptWatermark: updateAmbientTranscriptWatermarkMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock(import("../../routing/session-key.js"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    normalizeMainKey: () => "main",
    normalizeAgentId: vi.fn((id: string | undefined | null) => id ?? "default"),
  };
});

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

const resolveCurrentTurnImagesMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: resolveCurrentTurnImagesMock,
}));

vi.mock("./get-reply-fast-path.js", () => ({
  shouldUseReplyFastTestRuntime: vi.fn().mockReturnValue(false),
}));

vi.mock("./groups.js", () => ({
  buildDirectChatContext: vi.fn().mockReturnValue(""),
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
  formatActiveGoalContext: vi.fn().mockReturnValue(undefined),
  resolveInboundUserContextPromptJoiner: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "steer" }),
}));

vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../sessions/stored-model-overrides.js", () => ({
  resolveStoredModelOverride: vi.fn(
    (params: {
      sessionEntry?: { providerOverride?: string; modelOverride?: string };
      sessionStore?: Record<string, { providerOverride?: string; modelOverride?: string }>;
    }) => {
      const entries = [params.sessionEntry, ...Object.values(params.sessionStore ?? {})];
      if (entries.some((entry) => entry?.providerOverride || entry?.modelOverride)) {
        preparedReplyMockState.unexpectedCalls.push("resolveStoredModelOverride");
      }
      return null;
    },
  ),
}));

vi.mock("./session-reset-prompt.js", () => ({
  resolveBareResetBootstrapFileAccess: vi.fn().mockReturnValue(false),
  resolveBareSessionResetPromptState: vi.fn().mockResolvedValue({
    bootstrapMode: "none",
    prompt: "A new session was started via /new or /reset.",
    shouldPrependStartupContext: true,
  }),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

const ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE =
  "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

function nonReasoningModelState(): ReplyRunParams["modelState"] {
  return {
    ...createModelSelectionStateFixture({ agentCfg: {}, provider: "openai", model: "chat-latest" }),
    resolveDefaultThinkingLevel: async () => "high",
    resolveThinkingCatalog: async () => [
      { provider: "openai", id: "chat-latest", name: "Chat Latest", reasoning: false },
    ],
    allowedModelCatalog: [{ provider: "openai", id: "chat-latest", name: "Chat Latest" }],
  };
}

function telegramGroupSession(): SessionEntry {
  return {
    sessionId: "session-telegram-group",
    updatedAt: 1,
    systemSent: true,
    chatType: "group",
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "-100123" },
      origin: { provider: "telegram", surface: "telegram", chatType: "group", to: "-100123" },
    }),
  };
}

async function prepareActiveQueue(mode: "steer" | "collect" | "interrupt" | "followup") {
  const queueSettings = await import("./queue/settings-runtime.js");
  const runtime = await import("../../agents/embedded-agent.runtime.js");
  vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
    mode,
    debounceMs: 500,
    cap: 20,
    dropPolicy: "summarize",
  });
  vi.mocked(runtime.resolveActiveEmbeddedRunSessionId)
    .mockReturnValueOnce("active-session")
    .mockReturnValueOnce("active-session");
  vi.mocked(runtime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
  vi.mocked(runtime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);
  return runtime;
}

function turn(
  body: string,
  common: ReplyRunParams["ctx"],
  session: Partial<ReplyRunParams["sessionCtx"]> = {},
  inbound: Partial<ReplyRunParams["ctx"]> = {},
) {
  return {
    ctx: { ...createInboundBody(body), ...common, ...inbound },
    sessionCtx: { ...createSessionBody(body), ...common, ...session },
  };
}

function runPrepared(overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {}) {
  return runPreparedReply(baseParams(overrides));
}

async function useActualSystemEventDrain() {
  const actual = await vi.importActual<typeof import("./session-system-events.js")>(
    "./session-system-events.js",
  );
  vi.mocked(drainFormattedSystemEvents).mockImplementation(actual.drainFormattedSystemEvents);
}

function requireRunReplyAgentCall(index = 0) {
  return expectDefined(
    vi.mocked(runReplyAgent).mock.calls.at(index)?.[0],
    `runReplyAgent call ${index}`,
  );
}

describe("runPreparedReply media-only handling", () => {
  registerPendingRequesterAuthorityCases({ runPrepared, loadSessionEntryMock });
  it.each([
    "owner-alias",
    "non-owner",
    "heartbeat",
    "room-event",
    "spawned",
    "inter-session",
    "replay",
    "revoked-before-bind",
    "revoked",
  ] as const)(
    "admits configured Discord owner management through the reply ingress and real automation tool: %s",
    async (kind) => {
      const runId = "discord-owner-management";
      const cfg = { commands: { ownerAllowFrom: ["discord:owner-1"] } };
      const admitted = kind === "owner-alias" || kind === "revoked";
      setRuntimeConfigSnapshot(cfg);
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const identity: AgentRuntimeIdentity = {
        kind: "agentRuntime",
        agentId: "default",
        sessionKey: "agent:default:discord:channel:123",
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      };
      const calls: string[] = [];
      vi.mocked(runReplyAgent).mockImplementationOnce(async ({ opts }) => {
        await withGatewayToolCallerIdentity(
          { ...identity, approvalAuthority: authority },
          async () => {
            if (kind === "revoked-before-bind") {
              setRuntimeConfigSnapshot({});
            }
            const tool = createCronTool(
              { runId: opts?.runId, agentSessionKey: identity.sessionKey },
              {
                callGatewayTool: async <T>(method: string) => {
                  const grant = getGatewayToolCallerIdentity()?.cronManagementGrant;
                  if (!admitted) {
                    expect(grant).toBeUndefined();
                    calls.push("restricted");
                    return { jobs: [], total: 0, hasMore: false } as T;
                  }
                  expect(grant, "configured owner must receive a management grant").toBeDefined();
                  return await withCronManagementGrant(grant!, identity, method, async () => {
                    const assertActive = getCronManagementAuthority(identity)!;
                    assertActive();
                    await Promise.resolve();
                    if (kind === "revoked") {
                      setRuntimeConfigSnapshot({});
                    }
                    assertActive();
                    calls.push(method);
                    return { jobs: [], total: 0, hasMore: false } as T;
                  });
                },
              },
            );
            if (kind === "revoked") {
              await expect(tool.execute("list", { action: "list" })).rejects.toThrow(
                "Automation admin grant",
              );
            } else {
              await tool.execute("list", { action: "list" });
            }
          },
        );
        return undefined;
      });
      try {
        const params = ownerParams();
        params.command.senderId = "owner-1";
        params.command.senderIsOwner = kind !== "non-owner";
        await runPrepared({
          ...params,
          conversation: undefined,
          cfg,
          ...turn("list automations", {
            ...createProviderSurface("discord"),
            ChatType: "group",
            SenderId: kind === "owner-alias" ? "transport-alias" : "owner-1",
            InputProvenance:
              kind === "inter-session"
                ? { kind: "inter_session", sourceTool: "sessions_send" }
                : undefined,
            InboundEventKind: kind === "room-event" ? "room_event" : undefined,
          }),
          sessionEntry:
            kind === "spawned"
              ? { sessionId: "spawned-session", updatedAt: 1, spawnedBy: "agent:parent:main" }
              : undefined,
          opts: {
            runId,
            isHeartbeat: kind === "heartbeat",
            suppressNextUserMessagePersistence: kind === "replay",
          },
        });
        expect(calls).toEqual(kind === "revoked" ? [] : admitted ? ["cron.list"] : ["restricted"]);
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
        clearRuntimeConfigSnapshot();
      }
    },
  );
  beforeAll(async () => {
    // Preload the runtime seams directly so test setup does not need a synthetic
    // reply turn with registry and session side effects.
    await Promise.all([
      loadEmbeddedAgentRuntime(),
      loadAgentRunnerRuntime(),
      loadSessionUpdatesRuntime(),
    ]);
  });

  it.each([
    { name: "dashboard", spawnedBy: undefined },
    { name: "visible child", spawnedBy: "agent:default:main" },
  ])("loads workspace skills and runs in the $name managed worktree", async ({ spawnedBy }) => {
    const params = baseParams({
      sessionKey: "agent:default:dashboard:worktree-session",
      workspaceDir: "/tmp/agent-workspace",
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        spawnedBy,
        spawnedCwd: "/tmp/session-worktree",
        worktree: {
          id: "worktree-1",
          branch: "openclaw/worktree-1",
          repoRoot: "/tmp/project",
          canonicalWorkspaceDir: "/tmp/project/packages/app",
        },
      },
    });
    envMockState.fastTestRuntime = false;
    try {
      await runPreparedReply(params);
      const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
      expect(ensureSkillSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: "/tmp/agent-workspace",
          executionWorkspaceDir: "/tmp/session-worktree",
        }),
      );
    } finally {
      envMockState.fastTestRuntime = true;
    }
    expect(requireRunReplyAgentCall().followupRun.run.workspaceDir).toBe("/tmp/session-worktree");
  });

  it.each([
    { name: "initial", storedCwd: undefined, expected: "/tmp/session-repo" },
    { name: "replaced", storedCwd: "/tmp/current-repo", expected: "/tmp/current-repo" },
    { name: "cleared", storedCwd: null, expected: "/tmp/agent-repo" },
  ])("uses the $name admitted session cwd for execution", async ({ storedCwd, expected }) => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      spawnedCwd: "/tmp/session-repo",
      spawnedBy: "agent:default:main",
    };
    await runPrepared({
      cfg: {
        agents: {
          defaults: { cwd: "/tmp/default-repo" },
          entries: { default: { cwd: "/tmp/agent-repo" } },
        },
      },
      sessionEntry,
      sessionStore:
        storedCwd !== undefined
          ? { "session-key": { ...sessionEntry, spawnedCwd: storedCwd ?? undefined } }
          : undefined,
    });

    expect(requireRunReplyAgentCall().followupRun.run.cwd).toBe(expected);
  });

  beforeEach(async () => {
    preparedReplyMockState.unexpectedCalls.length = 0;
    loadSessionEntryMock.mockReset();
    updateAmbientTranscriptWatermarkMock.mockClear();
    vi.clearAllMocks();
    vi.mocked(buildDirectChatContext).mockReturnValue("");
    vi.mocked(buildGroupIntro).mockReturnValue("");
    vi.mocked(buildGroupChatContext).mockReturnValue("");
    vi.mocked(buildInboundUserContextPrefix).mockReset().mockReturnValue("");
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValue(undefined);
    vi.mocked(hasControlCommand).mockReturnValue(false);
    resolveCurrentTurnImagesMock.mockReset().mockResolvedValue({});
    replyRunTesting.resetReplyRunRegistry();
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetSystemEventsForTest();
    expect(preparedReplyMockState.unexpectedCalls).toEqual([]);
  });

  it("passes approved elevated defaults to the runner", async () => {
    await runPrepared({
      resolvedElevatedLevel: "on",
      elevatedEnabled: true,
      elevatedAllowed: true,
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.run.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
      fullAccessAvailable: true,
    });
  });

  it("includes current exec overrides in the queued runner prompt", async () => {
    await runPrepared({
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "always",
        node: "worker-1",
      },
      resolvedElevatedLevel: "off",
    });

    const prompt = requireRunReplyAgentCall().followupRun.run.extraSystemPromptStatic;
    expect(prompt).toContain(
      "Current session exec defaults: host=gateway security=full ask=always node=worker-1.",
    );
    expect(prompt).toContain("Current elevated level: off.");
    expect(prompt).toContain("Do not assume a prior denial still applies");
  });

  it.each(["explicit", "stored"] as const)(
    "rejects unsupported %s thinking or applies a turn-local fallback without changing storage",
    async (source) => {
      const sessionEntry: SessionEntry = {
        sessionId: "session-thinking",
        sessionFile: "/tmp/session-thinking.jsonl",
        thinkingLevel: "high",
        updatedAt: 1,
      };
      const sessionStore = { "session-key": sessionEntry };
      const result = await runPrepared({
        provider: "openai",
        model: "chat-latest",
        modelState: nonReasoningModelState(),
        ...(source === "explicit"
          ? { resolvedThinkLevel: "xhigh", opts: { thinkingLevelOverride: "xhigh" } }
          : {
              resolvedThinkLevel: "high",
              sessionEntry,
              sessionStore,
              storePath: "/tmp/openclaw-sessions.json",
            }),
      });
      if (source === "explicit") {
        expect(Array.isArray(result) ? undefined : result?.text).toContain(
          'Thinking level "xhigh" is not supported',
        );
        expect(runReplyAgent).not.toHaveBeenCalled();
      } else {
        expect(requireRunReplyAgentCall().followupRun.run.thinkLevel).toBe("off");
        expect(sessionEntry.thinkingLevel).toBe("high");
        expect(sessionStore["session-key"]?.thinkingLevel).toBe("high");
      }
    },
  );

  it("projects prepared embedded prompt variants without changing CLI session guidance", async () => {
    vi.mocked(buildDirectChatContext).mockImplementation(
      ({ sourceReplyDeliveryMode }) => `direct:${sourceReplyDeliveryMode ?? "automatic"}`,
    );
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyDeliveryModeOrigin: "runtime_default",
      } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> &
        SourceReplyDeliveryRuntimeOptions,
      ...turn("hello", { ...createProviderSurface("discord"), ChatType: "direct" }),
    });

    const call = requireRunReplyAgentCall(-1);
    const followupRun = call.followupRun;
    const run = followupRun.run;
    const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(run);
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only");
    expect(run.extraSystemPromptStatic).toBe("direct:message_tool_only");
    run.extraSystemPrompt += "\n\npost-compaction refresh";
    sourceReplyDeliveryRuntime?.applyMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only\n\npost-compaction refresh");
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "automatic");
    expect(sourceReplyDeliveryRuntime?.currentMode).toBe("automatic");
    expect(run.extraSystemPrompt).toBe("direct:automatic\n\npost-compaction refresh");
    expect(run.extraSystemPromptStatic).toBe("direct:message_tool_only");
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "message_tool_only");
    expect(run.extraSystemPrompt).toBe("direct:message_tool_only\n\npost-compaction refresh");
    expect(run.cliSessionBindingFacts).toEqual({
      extraSystemPromptStatic: "direct:message_tool_only",
      sourceReplyDeliveryMode: "message_tool_only",
    });
  });

  it("replaces only the bound delivery prompt component", () => {
    const repeatedPrefix = "same guidance\n\nindependent context\n\n";
    const run = { extraSystemPrompt: `${repeatedPrefix}same guidance\n\nlater context` };
    const runtime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [run],
      promptComponentByMode: {
        automatic: "automatic guidance",
        message_tool_only: "same guidance",
      },
      promptComponentOffset: repeatedPrefix.length,
    });

    runtime.applyPreparedMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe(`${repeatedPrefix}automatic guidance\n\nlater context`);

    const absent = { extraSystemPrompt: "independent context only" };
    createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [absent],
      promptComponentByMode: {
        automatic: "automatic guidance",
        message_tool_only: "missing guidance",
      },
      promptComponentOffset: undefined,
    }).applyPreparedMode(absent, "automatic");
    expect(absent.extraSystemPrompt).toBe("independent context only");

    const empty = { extraSystemPrompt: "independent context only" };
    createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [empty],
      promptComponentByMode: { automatic: "", message_tool_only: "" },
      promptComponentOffset: undefined,
    }).applyPreparedMode(empty, "automatic");
    expect(empty.extraSystemPrompt).toBe("independent context only");
  });

  it("keeps addressed message-tool delivery hints out of persisted transcript rows", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      "Current message:\nchat_id=-100123\ninbound_event_kind: user_request",
    );

    await runPrepared({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      ctx: {
        Body: "@bot please answer here",
        RawBody: "@bot please answer here",
        CommandBody: "please answer here",
        OriginatingChannel: "telegram",
        OriginatingTo: "-100123",
        ChatType: "group",
      },
      sessionCtx: {
        Body: "@bot please answer here",
        BodyStripped: "please answer here",
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "-100123",
        ChatType: "group",
        InboundEventKind: "user_request",
      },
    });

    const call = requireRunReplyAgentCall(-1);
    expect(call.commandBody).toBe("please answer here");
    expect(call.transcriptCommandBody).toBe("please answer here");
    expect(call.followupRun.prompt).toBe("please answer here");
    expect(call.followupRun.transcriptPrompt).toBe("please answer here");
    expect(call.followupRun.currentInboundContext?.text).toBe(
      [
        "Current message:\nchat_id=-100123\ninbound_event_kind: user_request",
        MESSAGE_TOOL_ONLY_DELIVERY_HINT,
      ].join("\n\n"),
    );
    const persistedUserMessage = call.followupRun.userTurnTranscriptRecorder?.message;
    if (!persistedUserMessage) {
      throw new Error("persisted user turn message missing");
    }
    expect(persistedUserMessage).toMatchObject({
      role: "user",
      content: "please answer here",
    });
    expect(persistedUserMessage.content).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it("persists pure media turns without the model-facing placeholder", async () => {
    const params = baseParams();
    params.ctx.ThreadHistoryBody = undefined;
    params.ctx.media = [{ path: "/tmp/input.png" }];
    params.sessionCtx.ThreadHistoryBody = undefined;

    await runPreparedReply(params);

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.prompt).toContain("[User sent media without caption]");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "",
      __openclaw: { media: [expect.objectContaining({ path: "/tmp/input.png" })] },
    });
  });

  it("prefers a one-turn queue override over the stored session mode", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockImplementationOnce((params) => ({
      mode: params.inlineMode ?? params.sessionEntry?.queueMode ?? "steer",
    }));
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce("active-session");
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValueOnce(true);
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunStreaming).mockReturnValueOnce(true);

    await runPrepared({
      sessionEntry: {
        sessionId: "active-session",
        updatedAt: Date.now(),
        queueMode: "followup",
      },
      opts: { queueModeOverride: "steer" },
    });

    expect(queueSettings.resolveQueueSettings).toHaveBeenCalledWith(
      expect.objectContaining({ inlineMode: "steer" }),
    );
    expect(requireRunReplyAgentCall(-1)).toMatchObject({
      shouldSteer: true,
      resolvedQueue: { mode: "steer" },
    });
  });

  it.each([undefined, "Earlier message in this thread"])(
    "uses thread history %s before falling back to the starter",
    async (history) => {
      const params = baseParams({ isNewSession: false });
      for (const context of [params.ctx, params.sessionCtx]) {
        context.ThreadStarterBody = "starter message";
        context.ThreadHistoryBody = history;
      }
      await expect(runPreparedReply(params)).resolves.toEqual({ text: "ok" });
      const { followupRun } = requireRunReplyAgentCall();
      const context = followupRun.currentInboundContext;
      const label = history ? "Thread history" : "Thread starter";
      const body = history ?? "starter message";
      expect(context?.text).toContain(`[${label} - for context]`);
      expect(context?.text).toContain(body);
      expect(context?.fragments).toContainEqual({
        kind: "conversation-data",
        text: `[${label} - for context]\n${body}`,
      });
      expect(followupRun.prompt).toBe("[User sent media without caption]");
      expect(followupRun.transcriptPrompt).not.toContain(body);
      if (history) {
        expect(context?.text).not.toContain("[Thread starter - for context]");
        expect(JSON.stringify(context?.fragments)).not.toContain("[Thread starter - for context]");
      }
    },
  );

  it.each([
    ["disabled text command", "discord", "text-slash", false, true],
    ["suppressed Gateway command", "webchat", "normal", true, true],
    ["unauthorized text command", "discord", "text-slash", true, false],
    ["legacy unauthorized command", "slack", undefined, true, false],
    ["unauthorized native command", "discord", "native", false, false],
  ] as const)(
    "%s preserves the command interpretation boundary",
    async (_name, channel, kind, enabled, allowed) => {
      const suppressed = kind === "normal";
      const source = kind === "text-slash" ? "text" : kind === "native" ? "native" : undefined;
      const body = suppressed ? "/new" : "/model openai/gpt-5.5";
      const onDeliberateSilentTerminalReply = vi.fn();
      vi.mocked(hasControlCommand).mockReturnValue(true);
      const params = baseParams({
        ctx: {
          ...createInboundTurn(body, channel, "direct"),
          CommandAuthorized: false,
          ...(suppressed ? { CommandInterpretationSuppressed: true } : {}),
          ...(source === "native" || source === "text" ? { CommandSource: source } : {}),
          ...(kind === "normal"
            ? { CommandTurn: { kind, source: "message", authorized: false, body } }
            : kind === "native"
              ? {
                  CommandTurn: {
                    kind,
                    source: "native",
                    authorized: false,
                    commandName: "model",
                    body,
                  },
                }
              : kind === "text-slash"
                ? {
                    CommandTurn: {
                      kind,
                      source: "text",
                      authorized: false,
                      commandName: "model",
                      body,
                    },
                  }
                : {}),
        },
        sessionCtx: createSessionTurn(body, channel, "direct"),
        commandAuthorized: false,
        command: {
          ...baseParams().command,
          surface: channel,
          channel,
          isAuthorizedSender: false,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        allowTextCommands: enabled,
        isNewSession: suppressed,
        opts: { onDeliberateSilentTerminalReply },
      });
      const result = await runPreparedReply(params);
      if (allowed) {
        expect(result).toEqual({ text: "ok" });
        expect(requireRunReplyAgentCall().followupRun.prompt).toBe(body);
        expect(onDeliberateSilentTerminalReply).not.toHaveBeenCalled();
      } else {
        expect(result).toBeUndefined();
        expect(runReplyAgent).not.toHaveBeenCalled();
        expect(onDeliberateSilentTerminalReply).toHaveBeenCalledOnce();
        expect(params.typing.cleanup).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { name: "ordinary code", directive: "", authorized: true, enabled: true },
    { name: "authorized directive", directive: "/think high\r\n", authorized: true, enabled: true },
    {
      name: "unauthorized directive",
      directive: "/think high\r\n",
      authorized: false,
      enabled: true,
    },
  ])(
    "preserves prompt bytes through routing and preparation: $name",
    async ({ directive, authorized, enabled }) => {
      const code =
        "Run  this:\r\n```python\r\n    if True:\r\n        print('a  b')\r\n\t\t# tabs  stay\r\n```";
      const body = `${directive}${code}`;
      const params = baseParams({
        ctx: createInboundTurn(body, "slack", "direct"),
        sessionCtx: createSessionTurn(body, "slack", "direct"),
        isNewSession: false,
        commandAuthorized: authorized,
        allowTextCommands: enabled,
      });
      params.command = { ...params.command, isAuthorizedSender: authorized };
      const inbound = finalizeInboundContext(params.ctx);
      const routed = resolveReplyDirectiveRouting({
        commandText: inbound.commandText,
        agentText: inbound.agentText,
        modelAliases: [],
        canInterpretTextDirectives: authorized && enabled,
        isAuthorizedSender: authorized,
        isGroup: false,
        wasMentioned: false,
        ctx: inbound,
        cfg: params.cfg,
        agentId: params.agentId,
        resetTriggered: false,
      });
      params.directives = routed.directives;
      params.sessionCtx.agentText = routed.cleanedBody;
      await runPreparedReply(params);

      const expected = (authorized && enabled ? code : body).replaceAll("\r\n", "\n");
      const call = requireRunReplyAgentCall();
      expect(call.commandBody).toBe(expected);
      expect(call.followupRun.prompt).toBe(expected);
    },
  );

  it.each([
    { body: "what changed?", contextBody: "what changed?", admitted: true },
    { body: "\u0000  ", contextBody: "", admitted: false },
  ])(
    "admits pending inbound history only when nonblank: $admitted",
    async ({ body, contextBody, admitted }) => {
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
        [
          "Chat history since last reply:",
          "```json",
          JSON.stringify(
            [{ sender: "Alice", timestamp_ms: 1_700_000_000_000, body: contextBody }],
            null,
            2,
          ),
          "```",
        ].join("\n"),
      );

      const result = await runPrepared({
        ...turn(
          "",
          { ChatType: "group", WasMentioned: true },
          {
            Provider: "feishu",
            OriginatingChannel: "feishu",
            OriginatingTo: "chat-1",
            InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body }],
          },
        ),
      });

      if (admitted) {
        expect(result).toEqual({ text: "ok" });
        expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
        const call = requireRunReplyAgentCall();
        expect(call.followupRun.prompt).toBe("");
        expect(call.followupRun.currentInboundContext?.text).toContain(
          "Chat history since last reply",
        );
        expect(call.followupRun.currentInboundContext?.text).toContain("what changed?");
        expect(call.followupRun.prompt).not.toContain("[User sent media without caption]");
      } else {
        expect(result).toEqual({
          text: "I didn't receive any text in your message. Please resend or add a caption.",
        });
        expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      }
    },
  );

  it("allows webchat pure-image turns when image content is carried outside MediaPath", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info:",
        "```json",
        JSON.stringify({ provider: "webchat", chat_id: "webchat:local" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ...turn(
        "",
        {},
        {
          Provider: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "webchat:local",
          ChatType: "direct",
        },
      ),
      opts: {
        images: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAAA",
          },
        ] as never,
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.currentInboundContext?.text).toContain("webchat:local");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it.each([undefined, true])(
    "persists direct-turn sender attribution only for external contacts (self: %s)",
    async (senderIsSelf) => {
      await runPrepared({
        ...turn(
          "hello",
          { OriginatingChannel: "telegram", OriginatingTo: "chat-1", ChatType: "direct" },
          { Provider: "telegram", SenderId: "user-42", SenderName: "Ada", SenderUsername: "ada" },
          { InboundAccessAuthorized: true, ...(senderIsSelf ? { SenderIsSelf: true } : {}) },
        ),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          chatType: "direct",
        },
      });

      const message = requireRunReplyAgentCall().followupRun.userTurnTranscriptRecorder?.message;
      if (senderIsSelf) {
        expect(message).not.toHaveProperty("__openclaw.senderId");
        expect(message).not.toHaveProperty("__openclaw.senderName");
        expect(message).not.toHaveProperty("__openclaw.senderUsername");
      } else {
        expect(message).toMatchObject({
          __openclaw: { senderId: "user-42", senderName: "Ada", senderUsername: "ada" },
        });
      }
    },
  );

  it("normalizes second-based inbound timestamps before preparing user turns", async () => {
    await runPrepared({
      ...turn(
        "timestamped followup",
        { OriginatingChannel: "whatsapp", OriginatingTo: "+15550001", ChatType: "direct" },
        { Provider: "whatsapp" },
        { Timestamp: 1_710_000_000 },
      ),
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "timestamped followup",
      timestamp: 1_710_000_000_000,
    });
  });

  it("does not copy prior session media onto text-only followups", async () => {
    await runPrepared({
      ctx: {
        ...createInboundBody("follow up without media"),
        OriginatingChannel: "telegram",
        OriginatingTo: "42",
        ChatType: "direct",
      },
      sessionCtx: {
        ...createSessionBody("follow up without media"),
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "42",
        ChatType: "direct",
        media: [{ path: "/tmp/previous-image.png", contentType: "image/png" }],
      },
    });

    const call = requireRunReplyAgentCall();
    expect(call.followupRun.media).toEqual([]);
    expect(call.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "follow up without media",
    });
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPath");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty("MediaPaths");
    expect(call.followupRun.userTurnTranscriptRecorder?.message).not.toHaveProperty([
      "__openclaw",
      "media",
      0,
    ]);
  });

  it("projects partially hydrated current images into the runner and transcript layout", async () => {
    const imagePath = "/tmp/described-image.png";
    const secondImageData = Buffer.from("second image bytes");
    const secondImagePath = "/tmp/undescribed-image.png";
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [
        {
          type: "image",
          data: secondImageData.toString("base64"),
          mimeType: "image/png",
        },
      ],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
    });

    const result = await runPrepared({
      ...turn(
        "describe this\n\n[Image]\nDescription:\na tiny dot image",
        { OriginatingChannel: "webchat", OriginatingTo: "webchat:local", ChatType: "direct" },
        {
          Provider: "webchat",
          media: [
            { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
            { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
          ],
        },
        {
          media: [
            { path: imagePath, contentType: "image/png", workspaceDir: "/tmp" },
            { path: secondImagePath, contentType: "image/png", workspaceDir: "/tmp" },
          ],
          MediaUnderstanding: [
            {
              kind: "image.description",
              attachmentIndex: 0,
              provider: "openai",
              model: "gpt-4o",
              text: "a tiny dot image",
            },
          ],
        },
      ),
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call.followupRun.images).toEqual([
      {
        type: "image",
        data: secondImageData.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(
      (
        call.followupRun.userTurnTranscriptRecorder?.message as unknown as Record<string, unknown>
      )?.["__openclaw"],
    ).toMatchObject({
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 1 }],
        suppressedFactIndexes: [0],
      },
    });
    expect(call.followupRun.imageOrder).toEqual(["inline"]);
    expect(call.followupRun.prompt).toContain("a tiny dot image");
  });

  it("keeps duplicate-path image positions after admission waits", async () => {
    const sharedPath = "/tmp/shared-media-index.png";
    const sessionId = "prepared-media-index-session";
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const previousRun = createReplyOperation({
      sessionId,
      sessionKey: "session-key",
      resetTriggered: false,
    });
    previousRun.setPhase("running");
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [{ type: "image", data: "c3ludGhldGlj", mimeType: "image/png" }],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
      unresolvedSourceIndexes: [2],
    });
    const running = runPrepared({
      isNewSession: false,
      sessionId,
      ctx: {
        ...createInboundTurn("inspect both images", "webchat", "direct"),
        media: [
          { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
          { path: sharedPath, contentType: "image/png" },
          { path: sharedPath, contentType: "image/png" },
        ],
      },
      sessionCtx: createSessionTurn("inspect both images", "webchat", "direct"),
    });
    try {
      await vi.waitFor(() => expect(previousRun.abortSignal.aborted).toBe(true));
      previousRun.complete();
      await expect(running).resolves.toEqual({ text: "ok" });
    } finally {
      previousRun.complete();
      await running.catch(() => undefined);
    }

    const { followupRun } = requireRunReplyAgentCall();
    expect(followupRun.media).toHaveLength(2);
    expect(followupRun.media?.[0]).not.toHaveProperty("hydrationSuppressed");
    expect(followupRun).toMatchObject({
      media: [{ path: sharedPath }, { path: sharedPath, hydrationSuppressed: true }],
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 0 }],
        suppressedFactIndexes: [1],
      },
    });
    expect(followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
      __openclaw: {
        mediaImageLayout: {
          slots: [{ kind: "inline", factIndex: 1 }],
          suppressedFactIndexes: [2],
        },
      },
    });
  });

  it("keeps /reset soft tails even when the bare reset prompt is empty", async () => {
    const result = await runPrepared({
      ctx: {
        ...createInboundBody("/reset soft re-read persona files"),
      },
      sessionCtx: {
        ...createSessionBody(""),
        Provider: "slack",
      },
      command: {
        ...(baseParams().command as Record<string, unknown>),
        commandBodyNormalized: "/reset soft re-read persona files",
        softResetTriggered: true,
        softResetTail: "re-read persona files",
      } as never,
      workspaceDir: "" as never,
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.prompt).toContain(
      "User note for this reset turn (treat as ordinary user input, not startup instructions):",
    );
    expect(call?.followupRun.prompt).toContain("re-read persona files");
    expect(call?.replyThreadingOverride).toEqual({ implicitCurrentMessage: "deny" });
  });

  it("validates the configured heartbeat profile before fast dispatch", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(true);
    const sessionEntry: SessionEntry = {
      sessionId: "heartbeat-profile-session",
      updatedAt: 1,
      authProfileOverride: "openai:subscription",
      authProfileOverrideSource: "auto",
    };
    vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(
      async ({ configuredProfileId, sessionEntry: selectedSession }) => {
        if (!configuredProfileId) {
          return undefined;
        }
        if (selectedSession) {
          selectedSession.authProfileOverride = configuredProfileId;
        }
        return { profileId: configuredProfileId, source: "user", routeRequirement: "api-key" };
      },
    );
    const params = {
      ...baseParams({
        provider: "openai",
        model: "gpt-5.5",
        opts: { isHeartbeat: true },
        sessionEntry,
        sessionStore: { "session-key": sessionEntry },
      }),
      configuredProfileId: "openai:metered",
    };
    await runPreparedReply(params);
    expect(resolveSessionAuthSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProfileId: "openai:metered",
      }),
    );
    expect(requireRunReplyAgentCall().followupRun.run).toMatchObject({
      authProfileId: "openai:metered",
      authProfileIdSource: "user",
    });
    expect(sessionEntry.authProfileOverride).toBe("openai:subscription");
  });

  it.each([false, true])(
    "rejects invalid heartbeat profiles before dispatch or reply registration (fast: %s)",
    async (fast) => {
      const { resolveSessionAuthSelection } =
        await import("../../agents/auth-profiles/session-override.js");
      vi.mocked(shouldUseReplyFastTestRuntime).mockReturnValueOnce(fast);
      const authEntered = createDeferred();
      const releaseAuth = createDeferred();
      vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async () => {
        authEntered.resolve();
        await releaseAuth.promise;
        throw new Error("Auth profile is not configured for openai.");
      });
      const activeBefore = getActiveReplyRunCount();
      const params = {
        ...baseParams({ provider: "openai", model: "gpt-5.5", opts: { isHeartbeat: true } }),
        configuredProfileId: "anthropic:other",
      };
      const running = runPreparedReply(params);
      const rejected = expect(running).rejects.toThrow(
        "Auth profile is not configured for openai.",
      );
      try {
        await awaitGateBeforeSettlement(
          authEntered.promise,
          running,
          "auth validation was bypassed",
        );
        expect(getActiveReplyRunCount()).toBe(activeBefore);
        expect(runReplyAgent).not.toHaveBeenCalled();
      } finally {
        releaseAuth.resolve();
        await rejected;
      }
      expect(runReplyAgent).not.toHaveBeenCalled();
      expect(getActiveReplyRunCount()).toBe(activeBefore);
    },
  );

  it("routes a channel-configured interrupt through session-work admission", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const storePath = "/tmp/channel-interrupt-sessions.json";
    let embeddedRunActive = true;
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-embedded-only" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    let releaseActiveAdmission = () => {};
    const activeAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-key", "session-embedded-only"],
      assertAllowed: () => {},
      onInterrupt: () => {
        releaseActiveAdmission();
      },
    });
    releaseActiveAdmission = () => {
      embeddedRunActive = false;
      activeAdmission.release();
    };

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-embedded-only",
          storePath,
        }),
      ).resolves.toEqual({ text: "ok" });
    } finally {
      activeAdmission.release();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReturnValue(false);
    }

    expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("queues interrupt-mode turns behind admitted recovery after heartbeat preemption", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const storePath = "/tmp/recovery-admission-sessions.json";
    const recoveryAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-key", "session-recovery-starting"],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-embedded-heartbeat",
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
      "drained",
    );

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-recovery-starting",
          storePath,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall();
      expect(call.isActive).toBe(true);
      expect(call.shouldSteer).toBe(false);
      expect(call.shouldFollowup).toBe(true);
    } finally {
      recoveryAdmission.release();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "not-heartbeat",
      );
    }
  });
  it("drains an embedded heartbeat hidden by the visible pre-dispatch operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-heartbeat",
      sessionKey: "session-key",
      turnKind: "visible",
      resetTriggered: false,
    });
    let embeddedRunActive = true;
    let releaseDrain: (() => void) | undefined;
    const drainBarrier = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "steer" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-pre-dispatch-heartbeat" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
      async () => {
        await drainBarrier;
        embeddedRunActive = false;
        return "drained";
      },
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockImplementation(async () => {
      await drainBarrier;
      embeddedRunActive = false;
      return true;
    });

    try {
      const runPromise = runPrepared({
        isNewSession: false,
        sessionId: "session-pre-dispatch-heartbeat",
        opts: { replyOperation: operation } as never,
        ...turn("answer this now", {
          ...createProviderSurface("telegram"),
          ChatType: "direct",
          OriginatingChannel: "telegram",
          OriginatingTo: "user:1",
        }),
      });

      await vi.waitFor(
        () => {
          expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledWith(
            "session-pre-dispatch-heartbeat",
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          );
        },
        { timeout: 1_000 },
      );
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();

      releaseDrain?.();
      await expect(runPromise).resolves.toEqual({ text: "ok" });
    } finally {
      releaseDrain?.();
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun)
        .mockReset()
        .mockResolvedValue("not-heartbeat");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd)
        .mockReset()
        .mockResolvedValue(true);
    }

    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("refreshes goal context after interrupt admission waits", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const inboundMeta = await import("./inbound-meta.js");
    const activeEntry: SessionEntry = {
      sessionId: "session-goal-interrupt",
      updatedAt: 1,
      goal: {
        schemaVersion: 1,
        id: "goal-interrupt",
        objective: "Finish the interrupted work",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokenStartFresh: true,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
    const completeEntry: SessionEntry = {
      ...activeEntry,
      goal: { ...activeEntry.goal!, status: "complete" },
    };
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(inboundMeta.formatActiveGoalContext).mockImplementation((entry) =>
      entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : undefined,
    );
    vi.mocked(inboundMeta.buildInboundUserContextPrefix).mockImplementation(
      (_ctx, _envelope, entry) =>
        entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : "",
    );
    loadSessionEntryMock.mockReturnValue(completeEntry);
    const activeRun = createReplyOperation({
      sessionId: "session-goal-interrupt",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    activeRun.setPhase("running");

    const runPromise = runPrepared({
      cfg: {
        session: {},
        channels: {},
        agents: { defaults: {} },
        skills: { workshop: { autonomous: { mode: "off" } } },
      },
      isNewSession: false,
      sessionId: "session-goal-interrupt",
      sessionEntry: activeEntry,
      sessionStore: { "session-key": activeEntry },
      storePath: "/tmp/openclaw-session-store.json",
    });
    while (!activeRun.abortSignal.aborted) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    activeRun.complete();

    await expect(runPromise).resolves.toEqual({ text: "ok" });
    expect(loadSessionEntryMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "session-key",
      readConsistency: "latest",
    });
    const call = requireRunReplyAgentCall(-1);
    expect(call.followupRun.currentInboundContext?.text ?? "").not.toContain("Active goal:");
  });

  it.each([false, true])(
    "interrupts other operations but preserves its own reset admission (owned: %s)",
    async (owned) => {
      const queueSettings = await import("./queue/settings-runtime.js");
      const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
      const commandQueue = await import("../../process/command-queue.js");
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
      vi.mocked(commandQueue.getQueueSize).mockReturnValueOnce(0);
      const sessionId = owned ? "session-reset-owner" : "session-active";
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(sessionId);
      const operation = createReplyOperation({
        sessionId,
        sessionKey: "session-key",
        resetTriggered: false,
      });
      if (!owned) {
        operation.attachBackend({
          kind: "embedded",
          cancel: () => operation.complete(),
        });
      }

      try {
        const result = await runPrepared({
          resetTriggered: true,
          isNewSession: true,
          sessionId: owned ? sessionId : "session-reset-new",
          ...(owned ? { opts: { replyOperation: operation } } : {}),
        });

        expect(result).toEqual({ text: "ok" });
        expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
        const call = requireRunReplyAgentCall();
        if (owned) {
          expect(call.replyOperation).toBe(operation);
          expect(commandQueue.clearCommandLane).not.toHaveBeenCalled();
        } else {
          expect(commandQueue.clearCommandLane).toHaveBeenCalledWith(
            "session:session-key",
            expect.any(Function),
          );
          expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
          expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
          expect(call.shouldSteer).toBe(false);
          expect(call.shouldFollowup).toBe(false);
          expect(call.resetTriggered).toBe(true);
        }
      } finally {
        operation.complete();
        vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
          .mockReset()
          .mockReturnValue(undefined);
      }
    },
  );
  it("does not enable steering for active heartbeat runs", async () => {
    await prepareActiveQueue("followup");

    await runPrepared({
      opts: { isHeartbeat: true },
    });

    const call = vi.mocked(runReplyAgent).mock.calls.at(-1)?.[0];
    expect(call?.shouldSteer).toBe(false);
    expect(call?.shouldFollowup).toBe(true);
    expect(call?.isActive).toBe(true);
    expect(call?.followupRun.run.terminalReplyExpectation).toBe("optional");
  });

  it("queues same-session Slack DM turns instead of steering across transport threads", async () => {
    await prepareActiveQueue("steer");
    const activeRun = createReplyOperation({
      sessionId: "active-session",
      sessionKey: "session-key",
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    activeRun.setPhase("running");

    try {
      await runPrepared({
        isNewSession: false,
        ctx: {
          ...createInboundTurn("second top-level DM", "slack", "direct"),
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          TransportThreadId: "501.000",
        },
        sessionCtx: {
          ...createSessionTurn("second top-level DM", "slack", "direct"),
          OriginatingChannel: "slack",
          OriginatingTo: "user:U1",
          TransportThreadId: "501.000",
        },
      });
    } finally {
      activeRun.complete();
    }

    const call = requireRunReplyAgentCall(-1);
    expect(call.shouldSteer).toBe(false);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    expect(call.followupRun.originatingThreadId).toBe("501.000");
  });

  it("waits for ownership acquired during async auth preparation before dispatching", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const queueSettings = await import("./queue/settings-runtime.js");
    const authEntered = createDeferred();
    const releaseAuth = createDeferred();
    vi.mocked(resolveSessionAuthSelection).mockImplementationOnce(async () => {
      authEntered.resolve();
      await releaseAuth.promise;
      return undefined;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const running = runPrepared({ isNewSession: false, sessionId: "session-auth-race" });
    let intruder: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await authEntered.promise;
      intruder = createReplyOperation({
        sessionId: "session-auth-race",
        sessionKey: "session-key",
        resetTriggered: false,
      });
      intruder.setPhase("running");
      releaseAuth.resolve();

      await vi.waitFor(() => expect(intruder?.abortSignal.aborted).toBe(true));
      expect(runReplyAgent).not.toHaveBeenCalled();
      intruder.complete();

      await expect(running).resolves.toEqual({ text: "ok" });
      expect(runReplyAgent).toHaveBeenCalledOnce();
    } finally {
      releaseAuth.resolve();
      intruder?.complete();
      await running.catch(() => undefined);
    }
  });

  it("rebinds a provisional pre-dispatch operation to a discovered existing session", async () => {
    const operation = createReplyOperation({
      sessionId: "provisional-session",
      sessionKey: "session-key",
      resetTriggered: false,
    });
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "existing-session",
        sessionFile: "/tmp/existing-session.jsonl",
        updatedAt: 1,
      },
    };

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionEntry: undefined,
          sessionId: undefined,
          sessionStore,
          storePath: "/tmp/sessions.json",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall(-1);
      expect(operation.sessionId).toBe("existing-session");
      expect(call.replyOperation).toBe(operation);
      expect(call.followupRun.run.sessionId).toBe("existing-session");
    } finally {
      operation.complete();
    }
  });

  it("keeps route and dispatch system events queued when busy admission returns", async () => {
    vi.useFakeTimers();
    await useActualSystemEventDrain();
    const queueSettings = await import("./queue/settings-runtime.js");
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    const routeSessionKey = "agent:main:slack:channel:c123";
    const dispatchSessionKey = `${routeSessionKey}:thread:123.456`;
    enqueueSystemEvent("Slack reaction added: :eyes:", { sessionKey: routeSessionKey });
    enqueueSystemEvent("Slack message in #claw-test from Alice", {
      sessionKey: dispatchSessionKey,
    });
    const previousRun = createReplyOperation({
      sessionId: "session-before-wait",
      sessionKey: dispatchSessionKey,
      resetTriggered: false,
    });
    previousRun.setPhase("running");

    const runPromise = runPrepared({
      agentId: "main",
      isNewSession: false,
      sessionId: "session-before-wait",
      sessionKey: dispatchSessionKey,
      opts: withReplySystemEventContext({}, { sessionKey: routeSessionKey }),
      provider: "",
      model: "",
      resolvedThinkLevel: "off",
    });

    await Promise.resolve();
    previousRun.complete();
    const nextRun = createReplyOperation({
      sessionId: "session-after-wait",
      sessionKey: dispatchSessionKey,
      resetTriggered: false,
    });
    nextRun.setPhase("running");

    const assertion = expect(runPromise).resolves.toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(routeSessionKey).map((event) => event.text)).toEqual([
      "Slack reaction added: :eyes:",
    ]);
    expect(peekSystemEventEntries(dispatchSessionKey).map((event) => event.text)).toEqual([
      "Slack message in #claw-test from Alice",
    ]);

    nextRun.complete();
  });
  it("runs bare mention replies when the reply target is the current-turn context", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Reply target of current user message:",
        "```json",
        JSON.stringify({ sender_label: "Bot", body: "quoted status body" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ...turn("", {
        ...createProviderSurface("telegram"),
        ChatType: "group",
        RawBody: "@bot",
        CommandBody: "@bot",
        ReplyToBody: "quoted status body",
        ReplyToSender: "Bot",
      }),
      command: {
        ...baseParams().command,
        rawBodyNormalized: "@bot",
        commandBodyNormalized: "",
      } as never,
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall(-1);
    expect(call?.transcriptCommandBody).toBe("");
    expect(call?.followupRun.prompt).toBe("");
    expect(call?.followupRun.transcriptPrompt).toBe("");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "Reply target of current user message",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("quoted status body");
  });

  it("runs room events as contextual events instead of direct user prompts", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Conversation info:\nroom metadata",
        "Conversation context (chronological, selected for current message):\n#35675 obviyus ->#35674: Are you fr fr",
      ].join("\n\n"),
    );

    await runPrepared({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
      ...turn(
        "No wtf",
        {
          ...createProviderSurface("telegram"),
          OriginatingChannel: "telegram",
          OriginatingTo: "-100123",
          ChatType: "group",
          InboundEventKind: "room_event",
          WasMentioned: true,
        },
        {
          media: [{ contentType: "audio/ogg" }],
          MessageSid: "35676",
          MessageSidFull: "  ",
          SenderName: "Keśava",
          AmbientTranscriptWatermarkKey: '["telegram","","-100123",""]',
          AmbientTranscriptMessageId: "35676",
          AmbientTranscriptTimestampMs: 1_710_000_000_000,
        },
      ),
      storePath: "/tmp/openclaw-session-store.json",
    });

    const call = requireRunReplyAgentCall(-1);
    expect(call?.commandBody).toBe("#35676 Keśava: No wtf");
    expect(call?.transcriptCommandBody).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.prompt).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.transcriptPrompt).toBe("#35676 Keśava: No wtf");
    expect(call?.followupRun.currentInboundEventKind).toBe("room_event");
    expect(call?.followupRun.currentInboundAudio).toBe(true);
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call.followupRun.run.terminalReplyExpectation).toBe("optional");
    expect(call?.followupRun.run.suppressNextUserMessagePersistence).toBeUndefined();
    expect(call?.followupRun.run.suppressTranscriptOnlyAssistantPersistence).toBe(true);
    expect(call?.followupRun.userTurnTranscriptRecorder?.message).toEqual({
      role: "user",
      content: "#35676 Keśava: No wtf",
      idempotencyKey: buildChannelSourceTurnId({
        provider: "telegram",
        conversationId: "-100123",
        messageId: "35676",
      }),
      timestamp: expect.any(Number),
      __openclaw: {
        senderIsOwner: false,
        senderName: "Keśava",
        transport: {
          channel: "telegram",
          conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/),
          messageId: "35676",
        },
      },
    });
    call?.followupRun.userTurnTranscriptRecorder?.markRuntimePersisted({
      role: "user",
      content: "#35676 Keśava: No wtf",
      timestamp: 1_710_000_000_000,
    });
    expect(updateAmbientTranscriptWatermarkMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "session-key",
      key: '["telegram","","-100123",""]',
      messageId: "35676",
      timestampMs: 1_710_000_000_000,
      expectedSessionId: expect.any(String),
    });
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      "#35675 obviyus ->#35674: Are you fr fr",
    );
    expect(call?.followupRun.currentInboundContext?.text).toContain("[OpenClaw room event]");
    expect(call?.followupRun.currentInboundContext?.text).toContain(
      ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE,
    );
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("visible_reply_contract:");
    expect(call?.followupRun.currentInboundContext?.text).not.toContain("Current event:");
  });

  it.each([
    { kind: "room_event", mode: "steer" },
    { kind: "user_request", mode: "collect" },
    { kind: "room_event", mode: "interrupt" },
  ] as const)("preserves queued $kind ownership in $mode mode", async ({ kind, mode }) => {
    const embeddedAgentRuntime = await prepareActiveQueue(mode);
    const abortController = new AbortController();
    const sourceAbortController = new AbortController();
    const operatorController = new AbortController();
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "guest",
      scopes: ["operator.write"],
      assertCurrent: () => operatorController.signal.throwIfAborted(),
      signal: operatorController.signal,
    });
    const isUserRequest = kind === "user_request";
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      isUserRequest ? "user request context" : "room context",
    );
    await runPrepared({
      ...(mode === "interrupt"
        ? {}
        : {
            opts: {
              abortSignal: abortController.signal,
              ...(isUserRequest
                ? { operatorAuthority }
                : { queuedFollowupAbortSignal: sourceAbortController.signal }),
            },
          }),
      ...turn(
        isUserRequest ? "@bot keep this" : "ambient",
        { ...createProviderSurface("telegram"), ChatType: "group" },
        { InboundEventKind: kind, MessageSid: isUserRequest ? "994" : "993", SenderName: "Alice" },
      ),
    });
    const call = requireRunReplyAgentCall(-1);
    expect(call.shouldFollowup).toBe(true);
    expect(call.isActive).toBe(true);
    if (mode === "interrupt") {
      expect(call.shouldSteer).toBe(false);
      expect(call.resolvedQueue.mode).toBe("interrupt");
      expect(embeddedAgentRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    } else {
      expect(call.followupRun.currentInboundEventKind).toBe(kind);
      expect(call.followupRun.abortSignal).toBe(
        isUserRequest ? undefined : sourceAbortController.signal,
      );
      if (isUserRequest) {
        expect(call.followupRun.operatorAuthority).toBe(operatorAuthority);
        abortController.abort();
        expect(resolveFollowupAbortSignal(call.followupRun)?.aborted).toBe(false);
        operatorController.abort();
        expect(resolveFollowupAbortSignal(call.followupRun)?.aborted).toBe(true);
      }
    }
  });

  it("keeps webchat room events on automatic source delivery", async () => {
    await runPrepared({
      opts: { sourceReplyDeliveryMode: "automatic" },
      ...turn(
        "webchat prompt",
        { ...createProviderSurface("webchat"), ChatType: "direct" },
        {
          InboundEventKind: "room_event",
          MessageSid: "webchat-room-event",
          SenderName: "Operator",
        },
      ),
    });

    const call = requireRunReplyAgentCall(-1);
    expect(call?.followupRun.run.sourceReplyDeliveryMode).toBe("automatic");
    expect(call?.followupRun.currentInboundContext?.text).not.toContain(
      "visible_reply_contract: message_tool_only",
    );
  });

  it.each([
    ["exec", undefined, "exec", "[OpenClaw exec completion]"],
    ["heartbeat", "background-task", "background-task", "[OpenClaw session event]"],
    ["heartbeat", "exec-event", "exec-event", "[OpenClaw exec completion]"],
  ] as const)(
    "keeps %s wake metadata private and preserves %s event provenance",
    async (source, suppliedSourceTool, expectedSourceTool, transcriptPrompt) => {
      const heartbeatPrompt = "Read HEARTBEAT.md and run any due maintenance.";
      const syntheticConversationInfo =
        'Conversation info:\n```json\n{"chat_id":"discord:channel-123"}\n```';
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(syntheticConversationInfo);

      await runPrepared({
        opts: { isHeartbeat: true },
        ...turn(
          heartbeatPrompt,
          {
            InternalTurnSource: source,
            ChatType: "direct",
            OriginatingChannel: "discord",
            OriginatingTo: "discord:channel-123",
          },
          {},
          {
            InputProvenance: suppliedSourceTool
              ? { kind: "internal_system", sourceTool: suppliedSourceTool }
              : undefined,
          },
        ),
      });

      const call = requireRunReplyAgentCall(-1);
      expect(call?.commandBody).toContain(heartbeatPrompt);
      expect(call?.followupRun.prompt).toContain(heartbeatPrompt);
      expect(call?.followupRun.prompt).not.toContain(syntheticConversationInfo);
      expect(buildInboundUserContextPrefix).not.toHaveBeenCalled();
      expect(call?.sessionCtx).toMatchObject({
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel-123",
      });
      const expectedTranscript =
        expectedSourceTool === "exec" || expectedSourceTool === "exec-event"
          ? `${transcriptPrompt}\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available.`
          : transcriptPrompt;
      expect(call?.transcriptCommandBody).toBe(expectedTranscript);
      expect(call?.followupRun.transcriptPrompt).toBe(expectedTranscript);
      expect(call?.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
        provenance: { kind: "internal_system", sourceTool: expectedSourceTool },
      });
    },
  );

  it.each([
    ["discord", "channel-1", "slack", "C999", undefined, false],
    ["telegram", "-100111", "telegram", "-100111", 42, true],
  ] as const)(
    "uses stored %s/%s facts only for a matching live %s/%s route",
    async (baseChannel, baseTo, liveChannel, liveTo, threadId, usesBaseSession) => {
      vi.mocked(buildGroupChatContext).mockImplementation(({ sessionCtx }) =>
        ["group", sessionCtx.Provider, sessionCtx.ChatType, sessionCtx.GroupChannel].join(":"),
      );
      const baseSessionKey = `agent:main:${baseChannel}:guild-1:${baseTo}`;
      const baseSessionEntry: SessionEntry = {
        sessionId: "base-session",
        updatedAt: 1,
        groupActivation: "always",
        chatType: "channel",
        groupId: "guild-1",
        groupChannel: "#ops",
        delivery: normalizeSessionDeliveryState({
          context: { channel: baseChannel, to: baseTo, accountId: "work", threadId },
          origin: {
            provider: baseChannel,
            surface: baseChannel,
            chatType: "channel",
            to: baseTo,
            accountId: "work",
          },
        }),
      };
      const route: ReplyRunParams["ctx"] = {
        OriginatingChannel: liveChannel,
        OriginatingTo: liveTo,
        MessageThreadId: threadId,
        AccountId: "work",
        ChatType: "channel",
        InternalTurnSource: "cron",
      };
      await runPrepared({
        conversation: prepareReplyConversation({ ctx: route, sessionEntry: baseSessionEntry }),
        opts: { isHeartbeat: true },
        defaultActivation: "mention",
        isNewSession: false,
        systemSent: true,
        sessionStore: { [baseSessionKey]: baseSessionEntry },
        ctx: {
          ...createInboundBody("scheduled wake"),
          ...route,
          SessionKey: `${baseSessionKey}:heartbeat`,
        },
        sessionCtx: { ...createSessionBody("scheduled wake"), ...route },
        sessionEntry: {
          sessionId: "isolated-session",
          updatedAt: 1,
          systemSent: true,
          heartbeatIsolatedBaseSessionKey: baseSessionKey,
        },
      });
      const expectedGroupChannel = usesBaseSession ? "#ops" : undefined;
      const call = requireRunReplyAgentCall(-1);
      expect(buildGroupChatContext).toHaveBeenCalledTimes(2);
      expect(vi.mocked(buildGroupChatContext).mock.calls[0]?.[0].sessionCtx).toMatchObject({
        Provider: liveChannel,
        Surface: liveChannel,
        ChatType: "channel",
        GroupChannel: expectedGroupChannel,
      });
      expect(buildGroupIntro).toHaveBeenCalledWith({
        activation: usesBaseSession ? "always" : undefined,
        defaultActivation: "mention",
      });
      expect(vi.mocked(buildInboundMetaSystemPrompt).mock.calls[0]?.[0]).toMatchObject({
        Provider: liveChannel,
        Surface: liveChannel,
        ChatType: "channel",
        AccountId: "work",
      });
      expect(call.followupRun.run.chatType).toBe("channel");
      expect(call.followupRun.run.extraSystemPromptStatic).toBe(
        ["group", liveChannel, "channel", expectedGroupChannel].join(":"),
      );
      expect(call.followupRun.originatingChannel).toBe(liveChannel);
      expect(call.followupRun.originatingTo).toBe(liveTo);
    },
  );

  it.each([
    { stableMode: "automatic", expectedPrompt: "group:telegram:group:automatic" },
    { stableMode: "message_tool_only", expectedPrompt: "group:telegram:group:message_tool_only" },
  ] as const)(
    "keeps CLI binding facts stable across room-event, primary, and heartbeat assembly for $stableMode",
    async ({ stableMode, expectedPrompt }) => {
      vi.mocked(buildGroupChatContext).mockImplementation(
        ({ sessionCtx, sourceReplyDeliveryMode }) =>
          [
            "group",
            sessionCtx.Provider,
            sessionCtx.ChatType,
            sourceReplyDeliveryMode ?? "automatic",
          ].join(":"),
      );
      const cfg: ReplyRunParams["cfg"] = {
        session: {},
        channels: {},
        agents: { defaults: {} },
        ...(stableMode === "message_tool_only"
          ? { messages: { visibleReplies: "message_tool" } }
          : {}),
      };
      const sessionEntry = telegramGroupSession();
      const stableOptions: ReplyRunParams["opts"] = {
        sourceReplyDeliveryMode: stableMode,
        sessionPromptSourceReplyDeliveryMode: stableMode,
      };
      const sequence: Array<
        readonly ["room_event" | "primary" | "cron" | "heartbeat", ReplyRunParams["opts"]]
      > = [
        ["room_event", { ...stableOptions, sourceReplyDeliveryMode: "message_tool_only" }],
        ["primary", stableOptions],
        ["cron", { isHeartbeat: true, ...stableOptions }],
        ["heartbeat", { isHeartbeat: true }],
        ["heartbeat", { isHeartbeat: true, sourceReplyDeliveryMode: "message_tool_only" }],
      ];
      // Direct and response-tool wakes must derive the same session policy (#121485).
      for (const [kind, opts] of sequence) {
        const isWake = kind === "cron" || kind === "heartbeat";
        const messageId = kind === "room_event" ? "msg-1" : "msg-2";
        await runPrepared({
          cfg,
          opts,
          isNewSession: false,
          systemSent: true,
          sessionEntry,
          ...turn(
            isWake ? "scheduled wake" : "@bot check this",
            isWake
              ? { InternalTurnSource: kind }
              : { ...createProviderSurface("telegram"), ChatType: "group", MessageSid: messageId },
            kind === "room_event" ? { InboundEventKind: kind } : {},
            isWake ? { SessionKey: "agent:main:telegram:-100123" } : {},
          ),
        });
      }

      const roomEvent = requireRunReplyAgentCall(0).followupRun;
      const primary = requireRunReplyAgentCall(1).followupRun.run;
      const heartbeat = requireRunReplyAgentCall(2).followupRun.run;
      const directHeartbeat = requireRunReplyAgentCall(3).followupRun.run;
      const responseToolHeartbeat = requireRunReplyAgentCall(4).followupRun.run;
      expect(roomEvent.run.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(primary.sourceReplyDeliveryMode).toBe(stableMode);
      expect(heartbeat.sourceReplyDeliveryMode).toBe(stableMode);
      expect(responseToolHeartbeat.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(roomEvent.run.extraSystemPrompt).toBe(expectedPrompt);
      expect(roomEvent.currentInboundContext?.text).toContain(
        "You were not explicitly tagged or mentioned in this room event",
      );
      for (const prepared of [
        roomEvent.run,
        primary,
        heartbeat,
        directHeartbeat,
        responseToolHeartbeat,
      ]) {
        expect(prepared.extraSystemPromptStatic).toBe(expectedPrompt);
        expect(prepared.cliSessionBindingFacts).toEqual({
          extraSystemPromptStatic: expectedPrompt,
          sourceReplyDeliveryMode: stableMode,
        });
      }
    },
  );

  it.each(["originless", "message-tool-denied"] as const)(
    "resolves automatic synthetic stable facts for %s sessions",
    async (kind) => {
      const originless = kind === "originless";
      if (originless) {
        vi.mocked(buildDirectChatContext).mockReturnValue("direct-context");
        resolveAgentHarnessDeliveryDefaultsMock.mockClear();
      } else {
        vi.mocked(buildGroupChatContext).mockImplementation(({ sourceReplyDeliveryMode }) =>
          ["group", sourceReplyDeliveryMode ?? "automatic"].join(":"),
        );
      }
      await runPrepared({
        cfg: {
          session: {},
          channels: {},
          agents: { defaults: {} },
          ...(!originless
            ? { messages: { visibleReplies: "message_tool" }, tools: { deny: ["message"] } }
            : {}),
        },
        opts: { isHeartbeat: true },
        isNewSession: false,
        systemSent: true,
        sessionEntry: originless
          ? { sessionId: "session-internal", updatedAt: 1, systemSent: true, chatType: "direct" }
          : telegramGroupSession(),
        ...turn(
          "scheduled wake",
          { InternalTurnSource: "heartbeat" },
          originless ? { ChatType: "direct" } : {},
          { SessionKey: originless ? "agent:main:main" : "agent:main:telegram:-100123" },
        ),
      });
      expect(
        requireRunReplyAgentCall().followupRun.run.cliSessionBindingFacts?.sourceReplyDeliveryMode,
      ).toBe("automatic");
      if (originless) {
        expect(
          resolveAgentHarnessDeliveryDefaultsMock.mock.calls.map(([params]) => ({
            provider: params.provider,
            modelId: params.modelId,
          })),
        ).toEqual([{ provider: "anthropic", modelId: "claude-opus-4-1" }]);
      }
    },
  );

  it("keeps group intro in the session-stable CLI prompt after turn one", async () => {
    vi.mocked(buildGroupChatContext).mockReturnValue("group:telegram:group:automatic");
    vi.mocked(buildGroupIntro).mockReturnValue("intro:mention");
    const sessionEntry = telegramGroupSession();

    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "automatic",
        sessionPromptSourceReplyDeliveryMode: "automatic",
      },
      isNewSession: true,
      systemSent: false,
      sessionEntry,
      ...turn("@bot first", { ...createProviderSurface("telegram"), ChatType: "group" }),
    });
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "automatic",
        sessionPromptSourceReplyDeliveryMode: "automatic",
      },
      isNewSession: false,
      systemSent: true,
      sessionEntry,
      ...turn("second", { ...createProviderSurface("telegram"), ChatType: "group" }),
    });

    const firstRun = requireRunReplyAgentCall(0).followupRun.run;
    const secondRun = requireRunReplyAgentCall(1).followupRun.run;
    expect(firstRun.extraSystemPromptStatic).toBe(
      "group:telegram:group:automatic\n\nintro:mention",
    );
    expect(secondRun.extraSystemPromptStatic).toBe(firstRun.extraSystemPromptStatic);
    expect(secondRun.cliSessionBindingFacts).toEqual(firstRun.cliSessionBindingFacts);
  });

  it("keeps inbound sender context in reply-targeted bare /reset model prompt while hiding startup instructions from transcript prompt", async () => {
    const commandText = "/reset";
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      ["Conversation info:", "Sender:", "sender_id", "telegram-user-1"].join("\n"),
    );

    await runPrepared({
      ...turn(
        "",
        {
          ...createProviderSurface("webchat"),
          ChatType: "direct",
          ReplyToBody: "quoted reset target",
          ReplyToSender: "Ada Lovelace",
        },
        { SenderId: "telegram-user-1", SenderName: "Ada Lovelace" },
        createInboundBody(commandText),
      ),
      command: {
        surface: "webchat",
        channel: "webchat",
        isAuthorizedSender: true,
        abortKey: "session-key",
        ownerList: [],
        senderIsOwner: true,
        rawBodyNormalized: commandText,
        commandBodyNormalized: commandText,
      } as never,
    });

    const call = requireRunReplyAgentCall(-1);
    expect(call?.commandBody).toContain("A new session was started via /new or /reset.");
    expect(call?.commandBody).toContain("Conversation info:");
    expect(call?.commandBody).toContain("Sender:");
    expect(call?.commandBody).toContain("telegram-user-1");
    expect(call?.followupRun.prompt).toContain("A new session was started via /new or /reset.");
    expect(call?.followupRun.prompt).toContain("Sender:");
    expect(call?.transcriptCommandBody).toBe("[OpenClaw session reset]");
    expect(call?.followupRun.transcriptPrompt).toBe("[OpenClaw session reset]");
    expect(call?.followupRun.transcriptPrompt).not.toContain("Sender:");
  });

  it("captures the prepared reply policy for queued Slack runs", async () => {
    await runPrepared({
      cfg: {
        session: {},
        channels: { slack: { replyToMode: "all" } },
        agents: { defaults: {} },
      },
      ...turn(
        "",
        {
          ThreadHistoryBody: "Earlier message in this thread",
          Provider: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
          ReplyToMode: "off",
        },
        { media: [{ path: "/tmp/input.png" }], OriginatingChannel: "slack", ReplyToId: "101.001" },
        { OriginatingChannel: undefined },
      ),
    });

    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.originatingReplyToId).toBe("101.001");
    expect(call?.followupRun.originatingReplyToMode).toBe("off");
  });

  it("keeps cross-channel cron reply policy independent of remembered chat type", async () => {
    const source = "cron" as const;
    for (const liveChatType of [undefined, "direct"] as const) {
      vi.mocked(runReplyAgent).mockClear();
      const route = {
        InternalTurnSource: source,
        OriginatingChannel: "slack" as const,
        OriginatingTo: "user:U1",
        ChatType: liveChatType,
      };
      await runPrepared({
        cfg: {
          session: {},
          channels: {
            slack: {
              replyToMode: "all",
              replyToModeByChatType: { channel: "off", direct: "first" },
            },
          },
          agents: { defaults: {} },
        },
        opts: { isHeartbeat: true },
        ctx: { ...createInboundBody("scheduled wake"), ...route },
        sessionCtx: { ...createSessionBody("scheduled wake"), ...route },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          chatType: "channel",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:remembered" },
          }),
        },
      });

      const call = requireRunReplyAgentCall();
      expect(call.followupRun.originatingChannel).toBe("slack");
      expect(call.followupRun.originatingChatType).toBe(liveChatType);
      expect(call.followupRun.run.chatType).toBe(liveChatType);
      expect(call.followupRun.originatingReplyToMode).toBe(liveChatType ? "first" : "all");
    }
  });

  it.each(["live", "absent"] as const)(
    "respects the heartbeat admission selection when it is %s",
    async (selection) => {
      await useActualSystemEventDrain();
      const queueKey = "agent:main:main:heartbeat:heartbeat";
      const runKey = "agent:main:main:heartbeat";
      const generic = expectDefined(
        enqueueSystemEventEntry("Gateway restart completed", {
          sessionKey: queueKey,
          contextKey: "gateway:restart",
        }),
        "selected generic event",
      );
      enqueueSystemEvent("Reminder: dedicated cron work", { sessionKey: queueKey });
      enqueueSystemEvent("Notification queued after selection", { sessionKey: queueKey });
      enqueueSystemEvent("Separate canonical queue notification", { sessionKey: runKey });
      const before = peekSystemEventEntries(queueKey).map((event) => event.text);

      await runPrepared({
        agentId: "main",
        ctx: createInboundBody("Dedicated heartbeat task"),
        opts:
          selection === "absent"
            ? { isHeartbeat: true }
            : withReplySystemEventContext(
                { isHeartbeat: true },
                { sessionKey: queueKey, events: [generic] },
              ),
        provider: "",
        model: "",
        resolvedThinkLevel: "off",
        sessionKey: runKey,
      });

      const followupRun = requireRunReplyAgentCall().followupRun;
      const context = followupRun.currentInboundContext;
      expect(followupRun.prompt).toBe("A new session was started via /new or /reset.");
      expect((context?.text ?? "").includes(generic.text)).toBe(selection === "live");
      expect(
        context?.fragments?.some(
          (fragment) =>
            fragment.kind === "conversation-data" && fragment.text.includes(generic.text),
        ) ?? false,
      ).toBe(selection === "live");
      for (const text of [
        followupRun.prompt,
        context?.text ?? "",
        ...(context?.fragments ?? []).map((fragment) => fragment.text),
      ]) {
        expect(text).not.toContain("Reminder: dedicated cron work");
        expect(text).not.toContain("Gateway replacement notification");
        expect(text).not.toContain("Notification queued after selection");
        expect(text).not.toContain("Separate canonical queue notification");
      }
      expect(followupRun.transcriptPrompt).not.toContain(generic.text);
      expect(peekSystemEventEntries(queueKey).map((event) => event.text)).toEqual(
        selection === "live" ? before.filter((text) => text !== generic.text) : before,
      );
      expect(peekSystemEventEntries(runKey).map((event) => event.text)).toEqual([
        "Separate canonical queue notification",
      ]);
    },
  );

  it("includes route system events in a thread-scoped turn", async () => {
    await useActualSystemEventDrain();
    enqueueSystemEvent("Slack reaction added: :eyes:", {
      sessionKey: "agent:main:slack:channel:c123",
    });
    enqueueSystemEvent("Slack message in #claw-test from Alice", {
      sessionKey: "agent:main:slack:channel:c123:thread:123.456",
    });

    await runPrepared({
      agentId: "main",
      ctx: createInboundBody("report queued reactions"),
      opts: withReplySystemEventContext({}, { sessionKey: "agent:main:slack:channel:c123" }),
      provider: "",
      model: "",
      resolvedThinkLevel: "off",
      sessionKey: "agent:main:slack:channel:c123:thread:123.456",
    });

    const followupRun = requireRunReplyAgentCall().followupRun;
    const context = followupRun.currentInboundContext;
    expect(followupRun.prompt).toBe("A new session was started via /new or /reset.");
    for (const event of [
      "Slack reaction added: :eyes:",
      "Slack message in #claw-test from Alice",
    ]) {
      expect(context?.text).toContain(event);
      expect(context?.fragments).toContainEqual({
        kind: "conversation-data",
        text: expect.stringContaining(event),
      });
      expect(followupRun.transcriptPrompt).not.toContain(event);
    }
    expect(peekSystemEventEntries("agent:main:slack:channel:c123")).toStrictEqual([]);
    expect(peekSystemEventEntries("agent:main:slack:channel:c123:thread:123.456")).toStrictEqual(
      [],
    );
  });

  it.each(["assigned", "session-internal"] as const)(
    "selects the session personal profile, never the incoming participant: %s",
    async (kind) => {
      const params = ownerParams();
      params.sessionEntry = {
        sessionId: "session-owner-profile",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "alice" },
        ...(kind === "assigned"
          ? { owner: { actor: { type: "human" as const, id: "carol" } } }
          : {}),
      };
      prepareSessionParticipantInput(params.ctx, { type: "profile", id: "bob" });
      params.ctx.SenderId = "bob";
      if (kind === "session-internal") {
        params.sessionCtx.InputProvenance = { kind: "internal_system", sourceTool: "fixture" };
      }
      await runPreparedReply(params);
      expect(requireRunReplyAgentCall().followupRun.run.bootstrapUserProfileId).toBe(
        kind === "session-internal" ? undefined : "carol",
      );
    },
  );

  it("preserves first-token think hint with separate system event context", async () => {
    // Event context must not shadow the user's low|medium|high shorthand.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    const code = "Run  this:\r\n    if True:\r\n        print('a  b')";
    await runPrepared({
      ctx: createInboundBody(`low ${code}`),
      sessionCtx: createSessionBody(`low ${code}`),
      resolvedThinkLevel: undefined,
    });

    const call = requireRunReplyAgentCall();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call.followupRun.run.thinkLevel).toBe("low");
    expect(call.followupRun.run.thinkLevelOverride).toBe("low");
    // Removing the think hint preserves every remaining user byte.
    expect(call.commandBody).toBe(code);
    expect(call.commandBody).not.toMatch(/^low\b/);
    expect(call.followupRun.prompt).toBe(`low ${code}`);
    const context = call.followupRun.currentInboundContext;
    expect(context?.text).toContain("System: [t] Node connected.");
    expect(context?.fragments).toContainEqual({
      kind: "conversation-data",
      text: "System: [t] Node connected.",
    });
  });

  it.each([
    { level: "off", clear: false, source: "turn" },
    { level: undefined, clear: true, source: "default" },
  ] as const)(
    "records thinking origin $source for level=$level reset=$clear",
    async ({ level, clear, source }) => {
      const params = ownerParams();
      params.directives = {
        ...params.directives,
        hasThinkDirective: level !== undefined || clear,
        thinkLevel: level,
        clearThinkLevel: clear,
      };
      params.resolvedThinkLevel = level;
      await runPreparedReply(params);
      expect(requireRunReplyAgentCall().followupRun.run.thinkLevelOverride).toBe(
        source === "turn" ? level : source,
      );
    },
  );

  registerSystemEventAdmissionCases({ runPrepared, requireRunReplyAgentCall });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
