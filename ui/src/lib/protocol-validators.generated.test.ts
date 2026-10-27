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
import {
  MessageReactionSummarySchema,
  SessionReactionEventSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-reactions.js";
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
  isSessionParticipantIdentity,
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
const goalIdentity = { sessionKey: "s", goalId: "g", operationId: "o", issuedAtMs: 1 };
const reaction = {
  sessionKey: "s",
  agentId: "main",
  sessionId: "session-1",
  messageId: "message-1",
  emoji: "👍",
  action: "added",
  actor: { type: "human", id: "user-1" },
  reactions: [],
};
const voice = { changeId: "c", voiceSessionId: "v", sessionKey: "s", voice: "a" };
const restriction = {
  code: "AGENT_RUNTIME_RESTRICTED",
  runtimeId: "native",
  runtimeLabel: "Native",
  reason: "permission-mode",
};
const observer = { sessionKey: "s", revision: 1, updatedAt: 0, health: "on-track" };
const progress = { sessionKey: "s", revision: 1, updatedAt: 0 };
const replay = { sessionKey: "s", updatedAtMs: 1, truncated: false };
const createFields = SessionsCreateParamsSchema.properties;

type Fixture = { name: keyof typeof checks; schema: TSchema; valid: unknown; invalid: unknown };
const board = {
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
};
const recovery = {
  action: "use-native-permissions",
  sessionId: "session-1",
  expectedPermissionMode: "guarded",
  expectedSandboxMode: "off",
  expectedNativeRuntimeConsent: null,
};
const duplicateDecisions = {
  ...approval,
  presentation: { ...approval.presentation, allowedDecisions: ["allow-once", "allow-once"] },
};
const historySchema = Type.Object(
  {
    stateRevision: Type.Required(ChatHistoryParamsSchema).properties.knownState,
    pendingInputs: Type.Optional(ChatPendingInputsPageSchema),
    sessionInfo: Type.Optional(SessionRowSchema),
  },
  { additionalProperties: false },
);
const history = {
  stateRevision: { pendingInputs: "inputs-1", sessionInfo: "session-1" },
  pendingInputs: { items: [], total: 0 },
  sessionInfo: { key: "s", kind: "direct", sessionId: "session-1" },
};
const invalidOwner = { key: "s", kind: "direct", owner: { actor: { type: "unknown" } } };

describe("standalone browser protocol validation", () => {
  it("keeps bounded display positions and strips unrelated persisted fields", () => {
    const expected = {
      source: "🦞".repeat(128),
      rawSeq: 3,
      activity: { afterRawSeq: 2, scopeId: "🦞".repeat(1024), startOrder: 0 },
    };
    expect(
      readTranscriptDisplayPosition({
        ...expected,
        unknown: true,
        activity: { ...expected.activity, unknown: true },
      }),
    ).toEqual(expected);
    for (const invalid of [
      { source: "🦞".repeat(129), rawSeq: 0 },
      { source: "s", rawSeq: Number.MAX_SAFE_INTEGER + 1 },
      { source: "s", rawSeq: 0, activity: { afterRawSeq: 0, scopeId: "a", startOrder: 0 } },
      { source: "s", rawSeq: 1, activity: { afterRawSeq: null, scopeId: "", startOrder: 0 } },
    ]) {
      expect(readTranscriptDisplayPosition(invalid)).toBeUndefined();
    }
  });

  it.each`
    name                                       | schema                                                        | valid                                                                                       | invalid
    ${"isBoardSnapshot"}                       | ${BoardSnapshotSchema}                                        | ${board}                                                                                    | ${{ ...board, tabs: [], widgets: [{}] }}
    ${"isSessionParticipantIdentity"}          | ${SessionParticipantIdentitySchema}                           | ${{ type: "remote", pluginId: "slack", domain: "workspace", idKind: "user", id: "user-1" }} | ${{ type: "profile", id: "profile-1", displayName: "Extra field" }}
    ${"isSessionReactionEvent"}                | ${SessionReactionEventSchema}                                 | ${reaction}                                                                                 | ${{ ...reaction, reactions: [{ emoji: "👍", count: 0, identities: [] }] }}
    ${"isMessageReactionSummary"}              | ${MessageReactionSummarySchema}                               | ${{ emoji: "👍", count: 1, identities: [{ id: "peer" }] }}                                  | ${{ emoji: "👍", count: 0, identities: [] }}
    ${"isTalkVoiceChangeEvent"}                | ${TalkVoiceChangeEventSchema}                                 | ${{ ...voice, phase: "requested" }}                                                         | ${{ ...voice, phase: "ready" }}
    ${"isAgentActivityItem"}                   | ${AgentActivityItemSchema}                                    | ${activity}                                                                                 | ${{ ...activity, startedAt: Infinity }}
    ${"isAgentRuntimeRestrictionErrorDetails"} | ${AgentRuntimeRestrictionErrorDetailsSchema}                  | ${{ ...restriction, recovery }}                                                             | ${{ ...restriction, recovery: { action: "use-native-permissions", sessionId: "session-1" } }}
    ${"isSessionObserverDigest"}               | ${SessionObserverDigestSchema}                                | ${{ ...observer, headline: "😀".repeat(120) }}                                              | ${{ ...observer, headline: "😀".repeat(121) }}
    ${"isSessionNarrationEvent"}               | ${SessionNarrationEventSchema}                                | ${{ sessionKey: "s", runId: "r", text: "" }}                                                | ${{ sessionKey: "s", runId: "r", text: "", extra: true }}
    ${"isSessionApprovalEvent"}                | ${SessionApprovalEventSchema}                                 | ${{ sessionKey: "s", updatedAtMs: 1, phase: "pending", approval }}                          | ${{ sessionKey: "s", updatedAtMs: 1, phase: "terminal", approval }}
    ${"isSessionApprovalReplay"}               | ${SessionApprovalReplaySchema}                                | ${{ ...replay, approvals: [approval] }}                                                     | ${{ ...replay, approvals: [duplicateDecisions] }}
    ${"isSessionsGoalUpdateParams"}            | ${SessionsGoalUpdateParamsSchema}                             | ${{ ...goalIdentity, action: "edit", objective: "Ship" }}                                   | ${{ ...goalIdentity, action: "pause", objective: "Ship" }}
    ${"isSessionsGoalClearParams"}             | ${SessionsGoalClearParamsSchema}                              | ${goalIdentity}                                                                             | ${{ ...goalIdentity, issuedAtMs: -1 }}
    ${"isSessionWorktreeSource"}               | ${createFields.worktreeSource}                                | ${"empty"}                                                                                  | ${"repository"}
    ${"isSessionDeviceFolder"}                 | ${createFields.deviceFolder}                                  | ${{ deviceId: "device-1", path: "/work" }}                                                  | ${{ deviceId: "device-1", path: "" }}
    ${"isSessionRepository"}                   | ${createFields.repository}                                    | ${{ url: "https://example.test/repo.git" }}                                                 | ${{ url: "https://example.test/repo.git", unexpected: 1 }}
    ${"isSessionFastMode"}                     | ${createFields.fastMode}                                      | ${"ultrafast"}                                                                              | ${"fast"}
    ${"isSessionTitleSource"}                  | ${createFields.titleSource}                                   | ${"😀".repeat(1000)}                                                                        | ${"😀".repeat(1001)}
    ${"isSessionPermissionMode"}               | ${SessionPermissionModeSchema}                                | ${"guarded"}                                                                                | ${"unrestricted"}
    ${"isSessionToolOverrides"}                | ${SessionToolOverridesSchema}                                 | ${{ mcpToolsDeny: { server: ["tool"] } }}                                                   | ${{ mcpToolsDeny: { server: [123] } }}
    ${"isChatHistoryState"}                    | ${historySchema}                                              | ${history}                                                                                  | ${{ stateRevision: { sessionInfo: "session-1" }, sessionInfo: invalidOwner }}
    ${"isChatTranscriptMetadata"}              | ${Type.Pick(SessionRowSchema, CHAT_TRANSCRIPT_METADATA_KEYS)} | ${{ key: "s", kind: "direct", contextTokens: 32768, owner: { actor: { type: "human" } } }}  | ${invalidOwner}
    ${"isProgressCard"}                        | ${ProgressCardSchema}                                         | ${{ ...progress, steps: [{ step: "Ship", status: "pending" }] }}                            | ${{ ...progress, steps: [{ step: "Ship", status: "unknown" }] }}
  `(
    "preserves canonical $name acceptance and rejection",
    ({ name, schema, valid, invalid }: Fixture) => {
      const check = checks[name];
      expect(Value.Check(schema, valid)).toBe(true);
      expect(check(valid)).toBe(true);
      expect(Value.Check(schema, invalid)).toBe(false);
      expect(check(invalid)).toBe(false);
      for (const value of [undefined, null, [], {}, 0, false, "", { ...activity, extra: true }]) {
        expect(check(value)).toBe(Value.Check(schema, value));
      }
    },
  );

  it("retains bounded delegation receipts while cleaning unknown nested fields", () => {
    const value = {
      ...activity,
      delegation: [
        {
          runId: "child",
          childSessionKey: "agent:main:subagent:child",
          status: "done",
          runtimeMs: 42,
          secret: "discard",
        },
      ],
    };
    const canonical = structuredClone(value);
    checks.cleanAgentActivityItem(value);
    expect(value).toEqual(Value.Clean(AgentActivityItemSchema, canonical));
    expect(checks.isAgentActivityItem(value)).toBe(true);
    expect(
      checks.isAgentActivityItem({
        ...value,
        delegation: [{ ...value.delegation[0], runtimeMs: -1 }],
      }),
    ).toBe(false);
  });

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
