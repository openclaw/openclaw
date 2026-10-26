import {
  executeQueuedFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import "./get-reply-run.runtime-mocks.test-support.js";

// Queue admission and channel policy have their own coverage; this seam exercises cron custody through ingress and drain.
vi.mock("./reply-tool-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-tool-authority.js")>()),
  prepareReplyRunToolAuthority: () => ({
    fingerprint: async () => "isolated-channel-owner",
    release: () => {},
  }),
}));
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { buildPrAttributionPrompt } from "../../agents/pr-attribution.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as gatewayModule from "../../agents/tools/gateway.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  getCronManagementChannelRequester,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { reserveSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import * as sessionNativeRuntime from "../../sessions/session-controller.native-runtime.js";
import * as sessionQueries from "../../sessions/session-controller.queries.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { hasControlCommand } from "../command-detection.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import {
  loadAgentRunnerRuntime,
  loadEmbeddedAgentRuntime,
  loadSessionUpdatesRuntime,
} from "./get-reply-run-helpers.js";
import { runPreparedReply } from "./get-reply-run.js";
import { registerPendingRequesterAuthorityCases } from "./get-reply-run.requester-authority.test-support.js";
import { registerSteeringIntentProducerCases } from "./get-reply-run.steering-intent.test-support.js";
import { registerSystemEventAdmissionCases } from "./get-reply-run.system-event-admission.test-support.js";
import {
  activatePreparedRun,
  baseParams,
  cleanupPreparedReplyFixtures,
  createInboundBody,
  jsonContext,
  createInboundTurn,
  createPreparedReplyTurn as turn,
  createSessionBody,
  createSessionTurn,
  createProviderSurface,
  createTelegramGroupSession,
  ownerParams,
  nonReasoningModelState,
  preparedTarget,
  resetPreparedReplySessionStore,
} from "./get-reply-run.test-support.js";
import { buildGroupIntro, buildSourceConversationContext } from "./groups.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import { getExistingFollowupQueue, clearFollowupQueue } from "./queue/state.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue/types.js";
import { bindReplySourceInput } from "./reply-source-binding.js";
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

vi.mock("../../agents/embedded-agent.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.runtime.js")>()),
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),

  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../sessions/session-controller.native-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.native-runtime.js")>()),
  waitForSessionRunEnd: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../sessions/session-controller.queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.queries.js")>()),
  isSessionRunActive: vi.fn().mockReturnValue(false),
  resolveActiveSessionRunId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../agents/harness/hook-helpers.js", () => ({
  runAgentHarnessBeforeMessageWriteHook: vi.fn((params: { message: unknown }) => params.message),
}));

// Harness selection and built-in execution are owned by their focused suites. These tests keep
// the real visible-reply policy resolver while supplying its default delivery metadata.
const preparedReplyMockState = vi.hoisted(() => ({ unexpectedCalls: [] as string[] }));
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

// mock-isolation: ingress cases provide config policy without loading active channel or subagent state.
vi.mock("../../agents/agent-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: (params: {
    config?: { tools?: { allow?: string[]; deny?: string[] } };
  }) => ({
    globalPolicy: params.config?.tools
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

// Keep the facade contract for real directive normalization; isolate only
// the three catalog/selection operations that this run-orchestration suite owns.
vi.mock("../../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-selection.js")>()),
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

vi.mock("../../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveSessionFilePathCore: vi.fn().mockReturnValue("/tmp/session.jsonl"),
    resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
    resolveSessionStorePathCore: vi.fn().mockReturnValue("/tmp/session-store"),
  };
});

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

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: async (...args: unknown[]) => loadSessionEntryMock(...args),
}));

vi.mock("../../config/sessions/ambient-transcript-watermark.js", () => ({
  updateAmbientTranscriptWatermark: updateAmbientTranscriptWatermarkMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/command-queue.js")>()),
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

vi.mock("./groups.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./groups.js")>()),
  buildSourceConversationContext: vi.fn().mockReturnValue(""),
  buildGroupIntro: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-meta.js")>()),
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
  formatActiveGoalContext: vi.fn().mockReturnValue(undefined),
  refreshActiveGoalContext: (context: unknown) => context,
  resolveInboundUserContextPromptJoiner: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "steer" }),
}));

vi.mock("./session-system-events.js", () => ({
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

// mock-isolation: reply orchestration uses fixture model overrides without opening host session stores.
vi.mock("../../sessions/stored-model-overrides.js", () => {
  const resolveStoredModelOverride = vi.fn(
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
  );
  return {
    resolveStoredModelOverride,
    resolveStoredModelOverrideAsync: async (
      params: Parameters<typeof resolveStoredModelOverride>[0],
    ) => resolveStoredModelOverride(params),
  };
});

vi.mock("./session-reset-prompt.js", () => ({
  resolveBareResetBootstrapFileAccess: vi.fn().mockReturnValue(false),
  resolveBareSessionResetPromptState: vi.fn().mockResolvedValue({
    bootstrapMode: "none",
    prompt: "A new session was started via /new or /reset.",
    shouldPrependStartupContext: true,
  }),
}));

vi.mock("./typing-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./typing-mode.js")>()),
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

const ROOM_EVENT_MESSAGE_TOOL_DIRECTIVE =
  "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking. To respond visibly, use message(action=send); your final text here stays private either way.";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

async function embeddedRuntime() {
  return vi.mocked(await import("../../agents/embedded-agent.runtime.js"));
}

async function useQueueMode(mode: "steer" | "collect" | "interrupt" | "followup") {
  const { resolveQueueSettings } = await import("./queue/settings-runtime.js");
  vi.mocked(resolveQueueSettings).mockReturnValueOnce({ mode });
}

function createOperation(
  sessionId: string,
  overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {},
) {
  return createReplyOperation({
    sessionId,
    sessionKey: "session-key",
    resetTriggered: false,
    ...overrides,
  });
}

async function prepareActiveQueue(
  mode: "steer" | "collect" | "interrupt" | "followup",
  overrides?: Partial<Parameters<typeof createReplyOperation>[0]>,
) {
  const operation = overrides
    ? createOperation("active-session", overrides)
    : activatePreparedRun();
  if (overrides) {
    operation.setPhase("running");
  }
  const queueSettings = await import("./queue/settings-runtime.js");
  const runtime = await embeddedRuntime();
  vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({
    mode,
    debounceMs: 500,
    cap: 20,
    dropPolicy: "summarize",
  });
  vi.mocked(sessionQueries.resolveActiveSessionRunId)
    .mockReturnValueOnce("active-session")
    .mockReturnValueOnce("active-session");
  vi.mocked(sessionQueries.isSessionRunActive).mockReturnValueOnce(true);
  return { runtime, operation };
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

function expectTurnText(call: ReturnType<typeof requireRunReplyAgentCall>, text: string) {
  expect(call).toMatchObject({
    commandBody: text,
    transcriptCommandBody: text,
    followupRun: { prompt: text, transcriptPrompt: text },
  });
}

const PR_ATTRIBUTION_OFF = `PR attribution: ⟦openclaw:ctx⟧
${buildPrAttributionPrompt(false)}`;

describe("runPreparedReply media-only handling", () => {
  describe.each(["followup", "collect"] as const)("queued owner authority: %s", (mode) => {
    it.each([
      "owner",
      "owner-overflow",
      "owner-batch",
      "mixed-source-authority",
      "revoked-before-drain",
      "revoked-after-bind",
      "configured-owner",
      "configured-owner-revoked",
      "discord-owner-alias",
      "discord-promoted-before-drain",
      "owner-source-replaced",
      "without-source-factory",
      "maintenance-copy",

      "room-event",
      "foreign-defaults",
      "internal",
      "replay",
      "spawned",
      "non-owner",
    ] as const)(
      "retains the actual channel owner ingress through queued execution: %s",
      async (kind) => {
        resetFollowupTurnTestState();
        const params = ownerParams();
        const key = expectDefined(params.sessionKey, "queued execution session key");
        const promoted = kind === "discord-promoted-before-drain";
        const refreshOwner = promoted || kind === "owner-source-replaced";
        const channel = kind === "discord-owner-alias" || promoted ? "discord" : "telegram";
        const cfg = {
          commands: { ownerAllowFrom: [`${channel}:${promoted ? "other" : "owner-1"}`] },
        };
        setRuntimeConfigSnapshot(cfg);
        let current = !promoted;
        let capturedOpts: ReplyRunParams["opts"];
        let scope: unknown;
        const scopes: unknown[] = [];
        let queuedCapability: NonNullable<ReplyRunParams["opts"]>["cronCreatorAuthorityCapability"];
        let executionError: unknown;
        const queuedSources: FollowupRun[] = [];
        const executedPrompts: string[] = [];
        let completedRuns = 0;
        vi.mocked(runReplyAgent).mockImplementationOnce(async ({ followupRun, opts }) => {
          capturedOpts = opts;
          if (refreshOwner) {
            // The synthetic queued admission below needs the session a real admission initializes.
            await replaceSessionEntry(
              { agentId: "default", sessionKey: key, storePath: resolveSessionStorePathCore() },
              { sessionId: followupRun.run.sessionId, updatedAt: 1 },
            );
          }
          if (kind === "without-source-factory") {
            followupRun.createChannelCronAuthority = undefined;
          }
          if (kind === "maintenance-copy") {
            followupRun.run.senderIsOwner = false;
          }
          const count =
            kind === "owner-overflow"
              ? 3
              : kind === "owner-batch" || kind === "mixed-source-authority"
                ? 2
                : 1;
          for (let index = 0; index < count; index++) {
            const source = {
              ...followupRun,
              // Each synthetic queued ingress owns a fresh source, not the seed turn's claim.
              controllerInput: undefined,
              controllerClaim: undefined,
              turnAdoptionLifecycle: undefined,
              sourceTurnId: `source-${index}`,
              messageId: `source-${index}`,
              ...(kind === "mixed-source-authority" && index === 1
                ? { createChannelCronAuthority: undefined }
                : {}),
            };
            expect(
              enqueueFollowupRun(
                key,
                source,
                {
                  mode,
                  debounceMs: 0,
                  cap: kind === "owner-overflow" ? 1 : 20,
                  dropPolicy: "summarize",
                },
                "none",
                undefined,
                false,
              ),
            ).toBe(true);
            queuedSources.push(source);
          }
          return undefined;
        });
        getFollowupTurnTestState().execute.mockImplementation(async (queued) => {
          executedPrompts.push(queued.commandBody);
          queuedCapability = queued.opts.cronCreatorAuthorityCapability;
          const instance = { runId: queued.opts.runId, instanceId: "isolated-queued-instance" };
          const authority = claimAgentRunDelegatedAuthority(instance);
          const identity: AgentRuntimeIdentity = {
            kind: "agentRuntime",
            agentId: "default",
            sessionKey: "session-key",
            operationalRunInstance: instance,
            delegatedAuthority: { kind: "local", ...authority },
          };
          try {
            await withGatewayToolCallerIdentity(
              { ...identity, approvalAuthority: authority },
              async () => {
                using _ = vi
                  .spyOn(gatewayModule, "callGatewayTool")
                  .mockImplementation(async <T>(method: string) => {
                    const grant = getGatewayToolCallerIdentity()?.cronManagementGrant;
                    return grant
                      ? withCronManagementGrant(grant, identity, method, async () => {
                          getCronManagementAuthority(identity)!();
                          expect(queuedCapability?.requesterOwner?.senderId).toBe("owner-1");
                          expect(getCronManagementChannelRequester(identity)).toEqual(
                            channel === "discord"
                              ? {
                                  version: 1,
                                  channel,
                                  accountId: "default",
                                  senderId: promoted ? "owner-1" : "transport-alias",
                                }
                              : undefined,
                          );
                          return { jobs: [], total: 0, hasMore: false } as T;
                        })
                      : ({ jobs: [], total: 0, hasMore: false } as T);
                  });
                const options = { runId: instance.runId, agentSessionKey: "session-key" };
                const tool = createCronTool(options);
                if (kind === "revoked-after-bind") {
                  current = false;
                  await expect(tool.execute("list", { action: "list" })).rejects.toThrow(
                    "Automation admin grant",
                  );
                  scope = "revoked";
                } else {
                  const { details } = await tool.execute("list", { action: "list" });
                  expect(details).toMatchObject({ scope: expect.any(String) });
                  scope = (details as { scope: string }).scope;
                }
              },
            );
            scopes.push(scope);
            return {
              runId: instance.runId,
              outcome: { kind: "rejected", payload: { text: "done" } },
            };
          } finally {
            releaseAgentRunDelegatedAuthority(authority);
          }
        });
        params.command.senderId = "owner-1";
        params.command.senderIsOwner = kind !== "non-owner" && !promoted;
        const input = turn("list all automations", {
          ...createProviderSurface(channel),
          ChatType: "group",
          SenderId: kind === "discord-owner-alias" ? "transport-alias" : "owner-1",
          InboundEventKind: kind === "room-event" ? "room_event" : undefined,
          ...(kind === "internal"
            ? { InputProvenance: { kind: "inter_session" as const, sourceTool: "sessions_send" } }
            : {}),
        });
        if (kind !== "configured-owner" && kind !== "configured-owner-revoked") {
          bindCommandOwnerAuthority(input.sessionCtx, { isCurrent: () => current });
        }
        try {
          await runPrepared({
            ...params,
            ...input,
            conversation: undefined,
            cfg,
            ...(kind === "spawned"
              ? {
                  sessionEntry: {
                    sessionId: "spawned-session",
                    updatedAt: 1,
                    spawnedBy: "agent:parent:main",
                  },
                }
              : {}),
            opts: {
              runId: "original-ingress",

              suppressNextUserMessagePersistence: kind === "replay",
            },
          });
          if (capturedOpts?.cronCreatorAuthorityCapability) {
            expect(capturedOpts.cronCreatorAuthorityCapability.active).toBe(false);
          }
          if (kind === "owner-overflow") {
            expect(getExistingFollowupQueue(key)?.items).toHaveLength(1);
            expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(1);
            expect(getExistingFollowupQueue(key)?.summaryElisions[0]?.sources).toHaveLength(1);
          }
          if (kind === "revoked-before-drain") {
            current = false;
          }
          if (kind === "configured-owner-revoked") {
            setRuntimeConfigSnapshot({});
          }
          if (refreshOwner) {
            current = false;
            setRuntimeConfigSnapshot({ commands: { ownerAllowFrom: [`${channel}:owner-1`] } });
          }
          scheduleFollowupDrain(key, async (queued) => {
            try {
              await executeQueuedFollowupTurnForTest(queued, {
                runId: `new-queued-execution-${mode}-${kind}-${completedRuns}`,
                admit: refreshOwner,
                opts:
                  kind === "foreign-defaults"
                    ? { ...capturedOpts, runId: "unrelated-run" }
                    : capturedOpts,
              });
              if (refreshOwner) {
                expect(queued.run.senderIsOwner).toBe(!promoted);
              }
            } catch (error) {
              executionError = error;
            } finally {
              completedRuns += 1;
            }
          });
          await Promise.all(
            queuedSources.map(
              (source) => expectDefined(source.controllerInput, "queued source").settlement.promise,
            ),
          );
          await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined(), {
            timeout: 10_000,
          });
          expect(executionError).toBeUndefined();
          if (queuedCapability) {
            expect(queuedCapability.active).toBe(false);
          }
          if (kind === "mixed-source-authority") {
            expect(scopes).toEqual(["gateway", "caller"]);
          }
          if (kind === "owner-overflow") {
            expect(executedPrompts).toEqual([
              "[Queue overflow] Dropped 2 messages due to cap.\nSummary:\n- list all automations",
              "list all automations",
            ]);
            expect(scopes).toEqual(["gateway", "gateway"]);
          }
          if (kind === "owner-batch") {
            expect(scopes).toEqual(mode === "collect" ? ["gateway"] : ["gateway", "gateway"]);
          }
          expect(scope).toBe(
            kind === "owner" ||
              kind === "owner-overflow" ||
              kind === "owner-batch" ||
              kind === "foreign-defaults" ||
              kind === "configured-owner" ||
              kind === "discord-owner-alias" ||
              refreshOwner
              ? "gateway"
              : kind === "revoked-after-bind"
                ? "revoked"
                : "caller",
          );
        } finally {
          clearFollowupQueue(key);
          clearRuntimeConfigSnapshot();
        }
      },
    );
  });

  registerSteeringIntentProducerCases({
    runPrepared,
    requireRunReplyAgentCall,
    activatePreparedRun,
  });

  registerPendingRequesterAuthorityCases({
    runPrepared,
    loadSessionEntryMock,
    requireRunReplyAgentCall,
    turn,
  });
  it.each([
    "owner-alias",
    "non-owner",

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
            using _ = vi
              .spyOn(gatewayModule, "callGatewayTool")
              .mockImplementation(async <T>(method: string) => {
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
              });
            const options = { runId: opts?.runId, agentSessionKey: identity.sessionKey };
            const tool = createCronTool(options);
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

  it("loads workspace skills and runs in the visible child's managed worktree", async () => {
    const params = baseParams({
      sessionKey: "agent:default:dashboard:worktree-session",
      workspaceDir: "/tmp/agent-workspace",
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        spawnedBy: "agent:default:main",
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

  beforeEach(async () => {
    preparedReplyMockState.unexpectedCalls.length = 0;
    loadSessionEntryMock.mockReset();
    vi.clearAllMocks();
    resetPreparedReplySessionStore();
    vi.mocked(buildSourceConversationContext).mockReturnValue("");
    vi.mocked(buildGroupIntro).mockReturnValue("");
    vi.mocked(buildInboundUserContextPrefix).mockReset().mockReturnValue("");
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValue(undefined);
    vi.mocked(hasControlCommand).mockReturnValue(false);
    resolveCurrentTurnImagesMock.mockReset().mockResolvedValue({});
    controllerTesting.resetSessionControllerForTest();
  });

  afterEach(async () => {
    await cleanupPreparedReplyFixtures();
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
      execOverrides: { host: "gateway", security: "full", ask: "always", node: "worker-1" },
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
    "validates %s thinking while preserving the stored preference",
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
        expect(requireRunReplyAgentCall().followupRun.run.thinkLevel).toBe("high");
        expect(sessionEntry.thinkingLevel).toBe("high");
        expect(sessionStore["session-key"]?.thinkingLevel).toBe("high");
      }
    },
  );

  it("projects prepared embedded prompt variants without changing CLI session guidance", async () => {
    vi.mocked(buildInboundMetaSystemPrompt).mockReturnValueOnce("Inbound metadata.");
    vi.mocked(buildSourceConversationContext).mockImplementation(
      ({ sourceReplyDeliveryMode }) => `direct:${sourceReplyDeliveryMode ?? "automatic"}`,
    );
    await runPrepared({
      opts: {
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyDeliveryModeOrigin: "runtime_default",
      } as NonNullable<Parameters<typeof runPreparedReply>[0]["opts"]> &
        SourceReplyDeliveryRuntimeOptions,
      ...turn("hello", {
        ...createProviderSurface("discord"),
        ChatType: "direct",
        GroupSystemPrompt: "Persistent policy.",
      }),
    });

    const call = requireRunReplyAgentCall(-1);
    const followupRun = call.followupRun;
    const run = followupRun.run;
    const initialTurnContext = { start: 0, text: "Inbound metadata.\n\ndirect:message_tool_only" };
    const automaticTurnContext = { start: 0, text: "Inbound metadata.\n\ndirect:automatic" };
    const staticPrompt = "direct:message_tool_only\n\nPersistent policy.";
    const persistentSuffix = "\n\nPersistent policy.\n\npost-compaction refresh";
    const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(run);
    expect(run.extraSystemPrompt).toBe(`${initialTurnContext.text}\n\nPersistent policy.`);
    expect(run.extraSystemPromptTurnContext).toEqual(initialTurnContext);
    expect(run.extraSystemPromptStatic).toBe(staticPrompt);
    run.extraSystemPrompt += "\n\npost-compaction refresh";
    sourceReplyDeliveryRuntime?.applyMode(run, "automatic");
    expect(run.extraSystemPrompt).toBe(`${initialTurnContext.text}${persistentSuffix}`);
    expect(run.extraSystemPromptTurnContext).toEqual(initialTurnContext);
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "automatic");
    expect(sourceReplyDeliveryRuntime?.currentMode).toBe("automatic");
    expect(run.extraSystemPrompt).toBe(`${automaticTurnContext.text}${persistentSuffix}`);
    expect(run.extraSystemPromptTurnContext).toEqual(automaticTurnContext);
    expect(run.extraSystemPromptStatic).toBe(staticPrompt);
    sourceReplyDeliveryRuntime?.applyPreparedMode(run, "message_tool_only");
    expect(run.extraSystemPrompt).toBe(`${initialTurnContext.text}${persistentSuffix}`);
    expect(run.extraSystemPromptTurnContext).toEqual(initialTurnContext);
    expect(run.cliSessionBindingFacts).toEqual({
      extraSystemPromptStatic: staticPrompt,
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
      ...turn(
        "@bot please answer here",
        { OriginatingChannel: "telegram", OriginatingTo: "-100123", ChatType: "group" },
        {
          BodyStripped: "please answer here",
          Provider: "telegram",
          InboundEventKind: "user_request",
        },
        { CommandBody: "please answer here" },
      ),
    });

    const call = requireRunReplyAgentCall(-1);
    expectTurnText(call, "please answer here");
    expect(call.followupRun.currentInboundContext?.text).toBe(
      [
        PR_ATTRIBUTION_OFF,
        "Current message:\nchat_id=-100123\ninbound_event_kind: user_request",
        MESSAGE_TOOL_ONLY_DELIVERY_HINT,
      ].join("\n\n"),
    );
    const persistedUserMessage = call.followupRun.userTurnTranscriptRecorder?.message;
    if (!persistedUserMessage) {
      throw new Error("persisted user turn message missing");
    }
    expect(persistedUserMessage).toMatchObject({ role: "user", content: "please answer here" });
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

  it("uses the thread starter when history is absent", async () => {
    const params = baseParams({ isNewSession: false });
    for (const context of [params.ctx, params.sessionCtx]) {
      context.ThreadStarterBody = "starter message";
      context.ThreadHistoryBody = undefined;
    }
    await expect(runPreparedReply(params)).resolves.toEqual({ text: "ok" });
    const { followupRun } = requireRunReplyAgentCall();
    const context = followupRun.currentInboundContext;
    expect(context?.text).toContain("[Thread starter - for context]");
    expect(context?.text).toContain("starter message");
    expect(context?.fragments).toContainEqual({
      kind: "conversation-data",
      text: "[Thread starter - for context]\nstarter message",
    });
    expect(followupRun.prompt).toBe("[User sent media without caption]");
    expect(followupRun.transcriptPrompt).not.toContain("starter message");
  });

  it.each([
    ["disabled text command", "discord", "text-slash", false, true],
    ["suppressed Gateway command", "webchat", "normal", true, true],
    ["unauthorized text command", "discord", "text-slash", true, false],
    ["legacy unauthorized command", "slack", undefined, true, false],
    ["unauthorized native command", "discord", "native", false, false],
  ] as const)(
    "%s preserves the command interpretation boundary",
    async (_name, channel, kind, enabled, allowed) => {
      const source = kind === "text-slash" ? "text" : kind === "native" ? "native" : undefined;
      const body = kind === "normal" ? "/new" : "/model openai/gpt-5.5";
      const onDeliberateSilentTerminalReply = vi.fn();
      vi.mocked(hasControlCommand).mockReturnValue(true);
      const params = baseParams({
        ctx: {
          ...createInboundTurn(body, channel, "direct"),
          CommandAuthorized: false,
          ...(kind === "normal" ? { CommandInterpretationSuppressed: true } : {}),
          ...(source === "native" || source === "text" ? { CommandSource: source } : {}),
          ...(kind === "normal"
            ? { CommandTurn: { kind, source: "message", authorized: false, body } }
            : source
              ? {
                  CommandTurn: {
                    ...(source === "native"
                      ? { kind: "native" as const, source }
                      : { kind: "text-slash" as const, source }),
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
        isNewSession: kind === "normal",
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

  it("rejects blank pending inbound history", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      jsonContext("Chat history since last reply:", [
        { sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "" },
      ]),
    );

    const result = await runPrepared({
      ...turn(
        "",
        { ChatType: "group", WasMentioned: true },
        {
          Provider: "feishu",
          OriginatingChannel: "feishu",
          OriginatingTo: "chat-1",
          InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "\u0000  " }],
        },
      ),
    });

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("allows webchat pure-image turns when image content is carried outside MediaPath", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      jsonContext("Conversation info:", { provider: "webchat", chat_id: "webchat:local" }),
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
        images: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] as never,
      },
    });

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
    const call = requireRunReplyAgentCall();
    expect(call?.followupRun.currentInboundContext?.text).toContain("webchat:local");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

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

  it("projects partially hydrated current images into the runner and transcript layout", async () => {
    const secondImageData = Buffer.from("second image bytes");
    const media = () => [
      { path: "/tmp/described-image.png", contentType: "image/png", workspaceDir: "/tmp" },
      { path: "/tmp/undescribed-image.png", contentType: "image/png", workspaceDir: "/tmp" },
    ];
    const image = {
      type: "image" as const,
      data: secondImageData.toString("base64"),
      mimeType: "image/png",
    };
    resolveCurrentTurnImagesMock.mockResolvedValueOnce({
      images: [image],
      imageOrder: ["inline"],
      imageSourceIndexes: [1],
    });

    const result = await runPrepared({
      ...turn(
        "describe this\n\n[Image]\nDescription:\na tiny dot image",
        { OriginatingChannel: "webchat", OriginatingTo: "webchat:local", ChatType: "direct" },
        { Provider: "webchat", media: media() },
        {
          media: media(),
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
    expect(call.followupRun.images).toEqual([image]);
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

  it.each([false, true])(
    "keeps duplicate-path image positions after admission wait=%s",
    async (wait) => {
      const sharedPath = "/tmp/shared-media-index.png";
      const sessionId = "prepared-media-index-session";
      const queueSettings = await import("./queue/settings-runtime.js");
      vi.mocked(queueSettings.resolveQueueSettings)
        .mockReturnValueOnce({ mode: "interrupt" })
        .mockReturnValueOnce({ mode: "interrupt" });
      const previousRun = wait
        ? createOperation(sessionId, { target: preparedTarget(sessionId) })
        : undefined;
      previousRun?.setPhase("running");
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
        sessionCtx: {
          ...createSessionTurn("inspect both images", "webchat", "direct"),
          SessionKey: "session-key",
          AgentId: "default",
        },
      });
      try {
        if (previousRun) {
          await vi.waitFor(() => expect(previousRun.abortSignal.aborted).toBe(true));
          previousRun.complete();
        }
        await expect(running).resolves.toEqual({ text: "ok" });
      } finally {
        previousRun?.complete();
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
      // A failed pre-read skips this run only; the recorded image remains retryable.
      const recorded = followupRun.userTurnTranscriptRecorder?.message;
      expect(recorded).toHaveProperty("__openclaw.mediaImageLayout.slots", [
        { kind: "inline", factIndex: 1 },
        { kind: "offloaded", factIndex: 2 },
      ]);
      expect(recorded).not.toHaveProperty("__openclaw.mediaImageLayout.suppressedFactIndexes");
      expect(recorded).not.toHaveProperty(["__openclaw", "media", 2, "hydrationSuppressed"]);
    },
  );

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

  it("does not leave an active reply operation after auth preparation fails", async () => {
    const { resolveSessionAuthSelection } =
      await import("../../agents/auth-profiles/session-override.js");
    const sessionId = "reply-operation-auth-failure";
    const activeBefore = sessionQueries.listActiveReplyRunSessionKeys().length;
    vi.mocked(resolveSessionAuthSelection).mockRejectedValueOnce(new Error("auth failed"));

    await expect(
      runPrepared({
        sessionId,
      }),
    ).rejects.toThrow("auth failed");

    expect(sessionQueries.listActiveReplyRunSessionKeys().length).toBe(activeBefore);
  });

  it("routes a channel-configured interrupt through session-work admission", async () => {
    const runtime = await embeddedRuntime();
    const storePath = "/tmp/channel-interrupt-sessions.json";
    let embeddedRunActive = true;
    await useQueueMode("interrupt");
    vi.mocked(sessionQueries.resolveActiveSessionRunId).mockImplementation(() =>
      embeddedRunActive ? "session-embedded-only" : undefined,
    );
    vi.mocked(sessionQueries.isSessionRunActive).mockImplementation(() => embeddedRunActive);
    let releaseActiveAdmission = () => {};
    const activeAdmission = await beginSessionEffect({
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
        runPrepared({ isNewSession: false, sessionId: "session-embedded-only", storePath }),
      ).resolves.toEqual({ text: "ok" });
    } finally {
      activeAdmission.release();
      vi.mocked(sessionQueries.resolveActiveSessionRunId).mockReturnValue(undefined);
      vi.mocked(sessionQueries.isSessionRunActive).mockReturnValue(false);
    }

    expect(runtime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(sessionNativeRuntime.waitForSessionRunEnd).not.toHaveBeenCalled();
    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it("refreshes goal context after interrupt admission waits", async () => {
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
    const cfg = {
      session: {},
      channels: {},
      agents: { defaults: {} },
    };
    await useQueueMode("interrupt");
    vi.mocked(inboundMeta.formatActiveGoalContext).mockImplementation((entry) =>
      entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : undefined,
    );
    vi.mocked(inboundMeta.buildInboundUserContextPrefix).mockImplementation(
      (_ctx, _envelope, entry) =>
        entry?.goal?.status === "active" ? "Active goal: Finish the interrupted work" : "",
    );
    const sessionStore = { "session-key": activeEntry };
    const target = captureSessionTarget({
      storeScope: "/tmp/openclaw-session-store.json",
      sessionKey: "session-key",
      incarnation: "session-goal-interrupt",
      agentId: "default",
    });
    const activeRun = createOperation("session-goal-interrupt", { target });
    activeRun.setPhase("running");
    activeRun.attachBackend({
      kind: "embedded",
      cancel: () => {
        sessionStore["session-key"] = completeEntry;
        activeRun.complete();
      },
    });
    const source = reserveSessionControllerSource("session-key", {
      policy: { mode: "interrupt" },
      target,
    });

    const runPromise = runPrepared({
      cfg,
      isNewSession: false,
      sessionId: "session-goal-interrupt",
      sessionEntry: activeEntry,
      sessionStore,
      storePath: "/tmp/openclaw-session-store.json",
      opts: bindReplySourceInput({}, source),
    });
    await expect(runPromise).resolves.toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall(-1);
    expect(call.followupRun.currentInboundContext?.text ?? "").not.toContain("Active goal:");
    activeRun.complete();
  });

  it.each([false, true])(
    "interrupts other operations but preserves its own reset admission (owned: %s)",
    async (owned) => {
      const queueSettings = await import("./queue/settings-runtime.js");
      const runtime = await embeddedRuntime();
      vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "followup" });
      const sessionId = owned ? "session-reset-owner" : "session-active";
      vi.mocked(sessionQueries.resolveActiveSessionRunId).mockReturnValue(sessionId);
      const operation = createOperation(sessionId, { target: preparedTarget(sessionId) });
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
          sessionCtx: {
            ...baseParams().sessionCtx,
            SessionKey: "session-key",
            AgentId: "default",
          },
          ...(owned ? { opts: { replyOperation: operation } } : {}),
        });

        expect(result).toEqual({ text: "ok" });
        expect(runtime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
        const call = requireRunReplyAgentCall();
        if (owned) {
          expect(call.replyOperation).toBe(operation);
          expect(operation.abortSignal.aborted).toBe(false);
        } else {
          expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
          expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
          expect(call).toMatchObject({
            shouldSteer: false,
            shouldFollowup: false,
            resetTriggered: true,
          });
        }
      } finally {
        operation.complete();
        vi.mocked(sessionQueries.resolveActiveSessionRunId).mockReset().mockReturnValue(undefined);
      }
    },
  );

  it.each([
    ["message thread id", { MessageThreadId: "501.000" }],
    ["transport thread id", { TransportThreadId: "501.000" }],
  ] as const)(
    "queues same-session Slack DM turns instead of steering across Slack threads using %s",
    async (_label, threadContext) => {
      const { operation: activeRun } = await prepareActiveQueue("steer", {
        routeThreadId: "500.000",
      });

      try {
        await runPrepared({
          isNewSession: false,
          ...turn("second top-level DM", {
            ...createProviderSurface("slack"),
            ChatType: "direct",
            OriginatingChannel: "slack",
            OriginatingTo: "user:U1",
            ...threadContext,
          }),
        });
      } finally {
        activeRun.complete();
      }

      expect(requireRunReplyAgentCall(-1)).toMatchObject({
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
        followupRun: { originatingThreadId: "501.000" },
      });
    },
  );

  it("does not queue a run behind its provided pre-dispatch reply operation", async () => {
    const operation = createOperation("session-pre-dispatch-owner");
    vi.mocked(sessionQueries.resolveActiveSessionRunId).mockReturnValue(
      "session-pre-dispatch-owner",
    );
    vi.mocked(sessionQueries.isSessionRunActive).mockReturnValue(true);

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-pre-dispatch-owner",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall(-1);
      expect(call.replyOperation).toBe(operation);
      expect(vi.mocked(sessionQueries.isSessionRunActive)).not.toHaveBeenCalled();
    } finally {
      operation.complete();
      vi.mocked(sessionQueries.resolveActiveSessionRunId).mockReset().mockReturnValue(undefined);
      vi.mocked(sessionQueries.isSessionRunActive).mockReset().mockReturnValue(false);
    }
  });

  it("rebinds a queued pre-dispatch reply operation after session rollover", async () => {
    const operation = createOperation("session-before-rollover");

    try {
      await expect(
        runPrepared({
          isNewSession: true,
          sessionId: "session-after-rollover",
          opts: { replyOperation: operation } as never,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall(-1);
      expect(operation.sessionId).toBe("session-after-rollover");
      expect(call.replyOperation).toBe(operation);
      expect(call.followupRun.run.sessionId).toBe("session-after-rollover");
    } finally {
      operation.complete();
    }
  });

  it("rebinds a provisional pre-dispatch operation to a discovered existing session", async () => {
    const operation = createOperation("provisional-session");
    const sessionStore: Record<string, SessionEntry> = {
      "session-key": {
        sessionId: "existing-session",
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
    await useQueueMode("interrupt");
    const routeSessionKey = "agent:main:slack:channel:c123";
    const dispatchSessionKey = `${routeSessionKey}:thread:123.456`;
    const cfg = { session: {}, channels: {}, agents: { defaults: {} } };
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    enqueueSystemEvent("Slack reaction added: :eyes:", { sessionKey: routeSessionKey });
    enqueueSystemEvent("Slack message in #claw-test from Alice", {
      sessionKey: dispatchSessionKey,
    });
    const previousTarget = captureSessionTarget({
      storeScope: storePath,
      sessionKey: dispatchSessionKey,
      incarnation: "session-before-wait",
      agentId: "main",
    });
    const previousRun = createReplyOperation({
      sessionId: "session-before-wait",
      sessionKey: dispatchSessionKey,
      resetTriggered: false,
      target: previousTarget,
    });
    previousRun.setPhase("running");
    previousRun.attachBackend({ kind: "embedded", cancel: resolveCancelled });
    const source = reserveSessionControllerSource(dispatchSessionKey, {
      policy: { mode: "interrupt" },
      target: previousTarget,
    });

    try {
      const runPromise = runPrepared({
        agentId: "main",
        cfg,
        isNewSession: false,
        sessionId: "session-before-wait",
        sessionKey: dispatchSessionKey,
        storePath,
        opts: bindReplySourceInput(
          withReplySystemEventContext({}, { sessionKey: routeSessionKey }),
          source,
        ),
        provider: "",
        model: "",
        resolvedThinkLevel: "off",
      });

      const assertion = expect(runPromise).resolves.toEqual({
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      });
      await cancelled;
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(routeSessionKey).map((event) => event.text)).toEqual([
        "Slack reaction added: :eyes:",
      ]);
      expect(peekSystemEventEntries(dispatchSessionKey).map((event) => event.text)).toEqual([
        "Slack message in #claw-test from Alice",
      ]);
    } finally {
      previousRun.complete();
    }
  });
  it("runs bare mention replies when the reply target is the current-turn context", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      jsonContext("Reply target of current user message:", {
        sender_label: "Bot",
        body: "quoted status body",
      }),
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
    expectTurnText(call, "#35676 Keśava: No wtf");
    expect(call.followupRun).toMatchObject({
      currentInboundEventKind: "room_event",
      currentInboundAudio: true,
      run: { sourceReplyDeliveryMode: "message_tool_only", terminalReplyExpectation: "optional" },
    });
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
        requesterOrigin: {
          sessionKey: "session-key",
          messageProvider: "telegram",
          chatType: "group",
          senderName: "Keśava",
          senderId: undefined,
          operatorProfileId: undefined,
        },
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
    const { runtime: embeddedAgentRuntime } = await prepareActiveQueue(mode);
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
      expect(sessionNativeRuntime.waitForSessionRunEnd).not.toHaveBeenCalled();
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

  it.each(["background-task", "exec-event"])(
    "keeps event metadata private and preserves %s provenance",
    async (sourceTool) => {
      const eventPrompt = "Check the completed background task.";
      const syntheticConversationInfo =
        'Conversation info:\n```json\n{"chat_id":"discord:channel-123"}\n```';
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(syntheticConversationInfo);

      await runPrepared({
        opts: { internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() } },
        ...turn(
          eventPrompt,
          {
            InternalTurnSource: "event",
            ChatType: "direct",
            OriginatingChannel: "discord",
            OriginatingTo: "discord:channel-123",
          },
          {},
          {
            InputProvenance: { kind: "internal_system", sourceTool },
          },
        ),
      });

      const call = requireRunReplyAgentCall(-1);
      expect(call?.commandBody).toContain(eventPrompt);
      expect(call?.followupRun.prompt).toContain(eventPrompt);
      expect(call?.followupRun.prompt).not.toContain(syntheticConversationInfo);
      expect(buildInboundUserContextPrefix).not.toHaveBeenCalled();
      expect(call?.sessionCtx).toMatchObject({
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel-123",
      });
      expect(call?.transcriptCommandBody).toBe(eventPrompt);
      expect(call?.followupRun.transcriptPrompt).toBe(eventPrompt);
      expect(call?.followupRun.userTurnTranscriptRecorder?.message).toMatchObject({
        provenance: { kind: "internal_system", sourceTool },
      });
    },
  );

  it.each([
    ["discord", "channel-1", "slack", "C999", undefined, false],
    ["telegram", "-100111", "telegram", "-100111", 42, true],
  ] as const)(
    "uses stored %s/%s facts only for a matching live %s/%s route",
    async (baseChannel, baseTo, liveChannel, liveTo, threadId, usesBaseSession) => {
      vi.mocked(buildSourceConversationContext).mockImplementation(({ sessionCtx }) =>
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
        opts: {},
        defaultActivation: "mention",
        isNewSession: false,
        systemSent: true,
        sessionStore: { [baseSessionKey]: baseSessionEntry },
        ctx: {
          ...createInboundBody("scheduled wake"),
          ...route,
          SessionKey: `${baseSessionKey}:cron`,
        },
        sessionCtx: { ...createSessionBody("scheduled wake"), ...route },
        sessionEntry: {
          sessionId: "isolated-session",
          updatedAt: 1,
          systemSent: true,
        },
      });
      const expectedGroupChannel = usesBaseSession ? "#ops" : undefined;
      const call = requireRunReplyAgentCall(-1);
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
    { stableMode: "message_tool_only", expectedPrompt: "group:telegram:group:message_tool_only" },
  ] as const)(
    "keeps CLI binding facts stable across room-event, primary, and cron assembly for $stableMode",
    async ({ stableMode, expectedPrompt }) => {
      vi.mocked(buildSourceConversationContext).mockImplementation(
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
      const sessionEntry = createTelegramGroupSession();
      const stableOptions: ReplyRunParams["opts"] = {
        sourceReplyDeliveryMode: stableMode,
        sessionPromptSourceReplyDeliveryMode: stableMode,
      };
      const sequence: Array<readonly ["room_event" | "primary" | "cron", ReplyRunParams["opts"]]> =
        [
          ["room_event", { ...stableOptions, sourceReplyDeliveryMode: "message_tool_only" }],
          ["primary", stableOptions],
          ["cron", { ...stableOptions }],
        ];
      // Scheduled wakes must derive the same stable session policy.
      for (const [kind, opts] of sequence) {
        const isWake = kind === "cron";
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
      const cron = requireRunReplyAgentCall(2).followupRun.run;
      expect(roomEvent.run.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(primary.sourceReplyDeliveryMode).toBe(stableMode);
      expect(cron.sourceReplyDeliveryMode).toBe(stableMode);
      expect(roomEvent.run.extraSystemPrompt).toBe(expectedPrompt);
      expect(roomEvent.currentInboundContext?.text).toContain(
        "You were not explicitly tagged or mentioned in this room event",
      );
      for (const prepared of [roomEvent.run, primary, cron]) {
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
        vi.mocked(buildSourceConversationContext).mockReturnValue("direct-context");
        resolveAgentHarnessDeliveryDefaultsMock.mockClear();
      } else {
        vi.mocked(buildSourceConversationContext).mockImplementation(
          ({ sourceReplyDeliveryMode }) =>
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
        opts: {},
        isNewSession: false,
        systemSent: true,
        sessionEntry: originless
          ? { sessionId: "session-internal", updatedAt: 1, systemSent: true, chatType: "direct" }
          : createTelegramGroupSession(),
        ...turn(
          "scheduled wake",
          {
            InternalTurnSource: "event",
            InputProvenance: { kind: "internal_system", sourceTool: "background-task" },
          },
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
    vi.mocked(buildSourceConversationContext).mockReturnValue("group:telegram:group:automatic");
    vi.mocked(buildGroupIntro).mockReturnValue("intro:mention");
    const sessionEntry = createTelegramGroupSession();

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
    for (const liveChatType of [undefined, "direct"] as const) {
      vi.mocked(runReplyAgent).mockClear();
      const route = {
        InternalTurnSource: "cron" as const,
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
        opts: {},
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
    expect(followupRun.prompt).toBe(
      [PR_ATTRIBUTION_OFF, "A new session was started via /new or /reset."].join("\n\n"),
    );
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
        kind === "session-internal" ? "alice" : "carol",
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

  it("records default thinking origin when the directive clears the level", async () => {
    const params = ownerParams();
    params.directives = {
      ...params.directives,
      hasThinkDirective: true,
      thinkLevel: undefined,
      clearThinkLevel: true,
    };
    params.resolvedThinkLevel = undefined;
    await runPreparedReply(params);
    expect(requireRunReplyAgentCall().followupRun.run.thinkLevelOverride).toBe("default");
  });

  registerSystemEventAdmissionCases({ runPrepared, requireRunReplyAgentCall });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
