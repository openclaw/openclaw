import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AgentRuntimeRestrictionErrorDetailsSchema } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import { isSessionParticipantIdentity } from "../../../packages/gateway-protocol/src/compiled/sender-identity.js";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
} from "../../../packages/gateway-protocol/src/schema/approvals.js";
import { BoardSnapshotSchema } from "../../../packages/gateway-protocol/src/schema/board.js";
import {
  AgentActivityItemSchema,
  ChatHistoryParamsSchema,
  ChatPendingInputsPageSchema,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { ProgressCardSchema } from "../../../packages/gateway-protocol/src/schema/progress-card.js";
import { SessionParticipantIdentitySchema } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { SessionsCreateParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-create.js";
import {
  SessionsGoalClearParamsSchema,
  SessionsGoalUpdateParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { SessionReactionEventSchema } from "../../../packages/gateway-protocol/src/schema/sessions-reactions.js";
import {
  SessionPermissionModeSchema,
  SessionRowSchema,
  SessionToolOverridesSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SessionNarrationEventSchema,
  SessionObserverDigestSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { TalkVoiceChangeEventSchema } from "../../../packages/gateway-protocol/src/schema/talk-voice.js";
import { readTranscriptDisplayPosition } from "../../../src/chat/transcript-display-position.js";
import { CHAT_TRANSCRIPT_METADATA_KEYS } from "../pages/chat/chat-transcript-metadata.ts";
import * as activityChecks from "./protocol-validators.generated/activity.js";
import * as approvalChecks from "./protocol-validators.generated/approvals.js";
import * as boardChecks from "./protocol-validators.generated/board.js";
import * as historyStateChecks from "./protocol-validators.generated/history-state.js";
import * as sessionInputChecks from "./protocol-validators.generated/session-input.js";
import * as transcriptChecks from "./protocol-validators.generated/transcript.js";

const checks = {
  ...activityChecks,
  ...approvalChecks,
  ...boardChecks,
  ...sessionInputChecks,
  ...transcriptChecks,
  ...historyStateChecks,
};

const activity = { itemId: "tool-1", phase: "start", kind: "tool", title: "Read file" };
const approval = {
  id: "approval:1",
  urlPath: "/approve/approval%3A1",
  createdAtMs: 1,
  expiresAtMs: 2,
  status: "pending",
  presentation: {
    kind: "exec",
    commandText: "git status",
    commandPreview: "git status",
    warningText: null,
    host: "gateway",
    nodeId: null,
    agentId: "main",
    allowedDecisions: ["allow-once", "deny"],
  },
};
const goalIdentity = {
  sessionKey: "agent:main:work",
  goalId: "goal-1",
  operationId: "operation-1",
  issuedAtMs: 1,
};
const fixtures: Array<{
  name: string;
  schema: TSchema;
  check: (value: unknown) => boolean;
  valid: unknown;
  invalid: unknown;
}> = [
  {
    name: "board snapshot",
    schema: BoardSnapshotSchema,
    check: checks.isBoardSnapshot,
    valid: {
      sessionKey: "agent:main:dashboard",
      revision: 1,
      tabs: [{ tabId: "overview", title: "Overview", position: 0, chatDock: "right" }],
      widgets: [
        {
          name: "chart",
          tabId: "overview",
          contentKind: "html",
          sizeW: 12,
          sizeH: 8,
          position: 0,
          grantState: "none",
          revision: 1,
        },
      ],
    },
    invalid: { sessionKey: "agent:main:dashboard", revision: 1, tabs: [], widgets: [{}] },
  },
  {
    name: "sender identity",
    schema: SessionParticipantIdentitySchema,
    check: isSessionParticipantIdentity,
    valid: { type: "remote", pluginId: "slack", domain: "workspace", idKind: "user", id: "user-1" },
    invalid: { type: "profile", id: "profile-1", displayName: "Extra field" },
  },
  {
    name: "session reaction",
    schema: SessionReactionEventSchema,
    check: checks.isSessionReactionEvent,
    valid: {
      sessionKey: "s",
      agentId: "main",
      sessionId: "session-1",
      messageId: "message-1",
      emoji: "👍",
      action: "added",
      actor: { type: "human", id: "user-1" },
      reactions: [],
    },
    invalid: {
      sessionKey: "s",
      agentId: "main",
      sessionId: "session-1",
      messageId: "message-1",
      emoji: "👍",
      action: "added",
      actor: { type: "human", id: "user-1" },
      reactions: [{ emoji: "👍", count: 0, identities: [] }],
    },
  },
  {
    name: "talk voice change",
    schema: TalkVoiceChangeEventSchema,
    check: checks.isTalkVoiceChangeEvent,
    valid: {
      changeId: "change-1",
      voiceSessionId: "voice-1",
      sessionKey: "s",
      voice: "voice-a",
      phase: "requested",
    },
    invalid: {
      changeId: "change-1",
      voiceSessionId: "voice-1",
      sessionKey: "s",
      voice: "voice-a",
      phase: "ready",
    },
  },
  {
    name: "activity",
    schema: AgentActivityItemSchema,
    check: checks.isAgentActivityItem,
    valid: activity,
    invalid: { ...activity, startedAt: Infinity },
  },
  {
    name: "agent runtime restriction",
    schema: AgentRuntimeRestrictionErrorDetailsSchema,
    check: checks.isAgentRuntimeRestrictionErrorDetails,
    valid: {
      code: "AGENT_RUNTIME_RESTRICTED",
      runtimeId: "native",
      runtimeLabel: "Native",
      reason: "permission-mode",
      recovery: {
        action: "use-native-permissions",
        sessionId: "session-1",
        expectedPermissionMode: "guarded",
        expectedSandboxMode: "off",
        expectedNativeRuntimeConsent: null,
      },
    },
    invalid: {
      code: "AGENT_RUNTIME_RESTRICTED",
      runtimeId: "native",
      runtimeLabel: "Native",
      reason: "permission-mode",
      recovery: { action: "use-native-permissions", sessionId: "session-1" },
    },
  },
  {
    name: "observer",
    schema: SessionObserverDigestSchema,
    check: checks.isSessionObserverDigest,
    valid: {
      sessionKey: "s",
      revision: 1,
      updatedAt: 0,
      headline: "😀".repeat(120),
      health: "on-track",
    },
    invalid: {
      sessionKey: "s",
      revision: 1,
      updatedAt: 0,
      headline: "😀".repeat(121),
      health: "on-track",
    },
  },
  {
    name: "narration",
    schema: SessionNarrationEventSchema,
    check: checks.isSessionNarrationEvent,
    valid: { sessionKey: "s", runId: "r", text: "" },
    invalid: { sessionKey: "s", runId: "r", text: "", extra: true },
  },
  {
    name: "approval event",
    schema: SessionApprovalEventSchema,
    check: checks.isSessionApprovalEvent,
    valid: { sessionKey: "s", updatedAtMs: 1, phase: "pending", approval },
    invalid: { sessionKey: "s", updatedAtMs: 1, phase: "terminal", approval },
  },
  {
    name: "approval replay",
    schema: SessionApprovalReplaySchema,
    check: checks.isSessionApprovalReplay,
    valid: { sessionKey: "s", updatedAtMs: 1, approvals: [approval], truncated: false },
    invalid: {
      sessionKey: "s",
      updatedAtMs: 1,
      approvals: [
        {
          ...approval,
          presentation: {
            ...approval.presentation,
            allowedDecisions: ["allow-once", "allow-once"],
          },
        },
      ],
      truncated: false,
    },
  },
  {
    name: "goal update",
    schema: SessionsGoalUpdateParamsSchema,
    check: checks.isSessionsGoalUpdateParams,
    valid: { ...goalIdentity, action: "edit", objective: "Ship" },
    invalid: { ...goalIdentity, action: "pause", objective: "Ship" },
  },
  {
    name: "goal clear",
    schema: SessionsGoalClearParamsSchema,
    check: checks.isSessionsGoalClearParams,
    valid: goalIdentity,
    invalid: { ...goalIdentity, issuedAtMs: -1 },
  },
  {
    name: "worktree source",
    schema: SessionsCreateParamsSchema.properties.worktreeSource,
    check: checks.isSessionWorktreeSource,
    valid: "empty",
    invalid: "repository",
  },
  {
    name: "device folder",
    schema: SessionsCreateParamsSchema.properties.deviceFolder,
    check: checks.isSessionDeviceFolder,
    valid: { deviceId: "device-1", path: "/work" },
    invalid: { deviceId: "device-1", path: "" },
  },
  {
    name: "repository",
    schema: SessionsCreateParamsSchema.properties.repository,
    check: checks.isSessionRepository,
    valid: { url: "https://example.test/repo.git" },
    invalid: { url: "https://example.test/repo.git", unexpected: 1 },
  },
  {
    name: "fast mode",
    schema: SessionsCreateParamsSchema.properties.fastMode,
    check: checks.isSessionFastMode,
    valid: "ultrafast",
    invalid: "fast",
  },
  {
    name: "title source",
    schema: SessionsCreateParamsSchema.properties.titleSource,
    check: checks.isSessionTitleSource,
    valid: "😀".repeat(1000),
    invalid: "😀".repeat(1001),
  },
  {
    name: "permission mode",
    schema: SessionPermissionModeSchema,
    check: checks.isSessionPermissionMode,
    valid: "guarded",
    invalid: "unrestricted",
  },
  {
    name: "tool overrides",
    schema: SessionToolOverridesSchema,
    check: checks.isSessionToolOverrides,
    valid: { mcpToolsDeny: { server: ["tool"] } },
    invalid: { mcpToolsDeny: { server: [123] } },
  },
  {
    name: "cached history metadata",
    schema: Type.Object(
      {
        stateRevision: Type.Required(ChatHistoryParamsSchema).properties.knownState,
        pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
        sessionInfo: Type.Optional(SessionRowSchema),
      },
      { additionalProperties: false },
    ),
    check: checks.isChatHistoryState,
    valid: {
      stateRevision: { pendingInputs: "inputs-1", sessionInfo: "session-1" },
      pendingInputs: { items: [], total: 0 },
      sessionInfo: { key: "s", kind: "direct", sessionId: "session-1" },
    },
    invalid: {
      stateRevision: { sessionInfo: "session-1" },
      sessionInfo: { key: "s", kind: "direct", owner: { actor: { type: "unknown" } } },
    },
  },
  {
    name: "transcript metadata",
    schema: Type.Pick(SessionRowSchema, CHAT_TRANSCRIPT_METADATA_KEYS),
    check: checks.isChatTranscriptMetadata,
    valid: { key: "s", kind: "direct", owner: { actor: { type: "human" } } },
    invalid: { key: "s", kind: "direct", owner: { actor: { type: "unknown" } } },
  },
  {
    name: "progress",
    schema: ProgressCardSchema,
    check: checks.isProgressCard,
    valid: {
      sessionKey: "s",
      revision: 1,
      updatedAt: 0,
      steps: [{ step: "Ship", status: "pending" }],
    },
    invalid: {
      sessionKey: "s",
      revision: 1,
      updatedAt: 0,
      steps: [{ step: "Ship", status: "unknown" }],
    },
  },
];

describe("standalone browser protocol validation", () => {
  it("keeps bounded display positions and strips unrelated persisted fields", () => {
    expect(
      readTranscriptDisplayPosition({
        source: "🦞".repeat(128),
        rawSeq: 3,
        unknown: true,
        activity: { afterRawSeq: 2, scopeId: "🦞".repeat(1024), startOrder: 0, unknown: true },
      }),
    ).toEqual({
      source: "🦞".repeat(128),
      rawSeq: 3,
      activity: { afterRawSeq: 2, scopeId: "🦞".repeat(1024), startOrder: 0 },
    });
    for (const invalid of [
      { source: "🦞".repeat(129), rawSeq: 0 },
      { source: "s", rawSeq: Number.MAX_SAFE_INTEGER + 1 },
      { source: "s", rawSeq: 0, activity: { afterRawSeq: 0, scopeId: "a", startOrder: 0 } },
      { source: "s", rawSeq: 1, activity: { afterRawSeq: null, scopeId: "", startOrder: 0 } },
    ]) {
      expect(readTranscriptDisplayPosition(invalid)).toBeUndefined();
    }
  });

  it.each(fixtures)(
    "preserves canonical $name acceptance and rejection",
    ({ schema, check, valid, invalid }) => {
      expect(Value.Check(schema, valid)).toBe(true);
      expect(check(valid)).toBe(true);
      expect(Value.Check(schema, invalid)).toBe(false);
      expect(check(invalid)).toBe(false);
      for (const value of [undefined, null, [], {}, 0, false, "", { ...activity, extra: true }]) {
        expect(check(value)).toBe(Value.Check(schema, value));
      }
    },
  );

  it("cleans activity's unknown own keys while retaining its scalar values", () => {
    const value = { ...activity, extra: { nested: true }, startedAt: Number.NaN };
    Object.defineProperty(value, "hidden", { value: true, configurable: true });
    const canonical = { ...value };
    Object.defineProperty(canonical, "hidden", { value: true, configurable: true });
    expect(checks.cleanAgentActivityItem(value)).toBe(value);
    expect(value).toEqual(Value.Clean(AgentActivityItemSchema, canonical));
    expect(Object.getOwnPropertyNames(value)).toEqual(Object.getOwnPropertyNames(canonical));
    expect(checks.isAgentActivityItem(value)).toBe(false);
    expect(checks.cleanAgentActivityItem(null)).toBeNull();
  });
});
