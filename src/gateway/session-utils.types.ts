import type { ChatType } from "../channels/chat-type.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "../config/sessions/types.js";
import type {
  GatewayAgentRow as SharedGatewayAgentRow,
  SessionsListResultBase,
  SessionsPatchResultBase,
} from "../shared/session-types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

export type GatewaySessionRow = {
  key: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: SessionEntry["subagentRole"];
  subagentControlScope?: SessionEntry["subagentControlScope"];
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  parentSessionKey?: string;
  childSessions?: string[];
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: SessionEntry["lastThreadId"];
  compactionCheckpointCount?: number;
  latestCompactionCheckpoint?: SessionCompactionCheckpoint;
  // PR-8 / #67721: surface mode-state on the session row so the UI
  // mode chip can render the current selection rather than always
  // defaulting to Ask. Backend writes these via `sessions.patch`;
  // gateway includes them on `sessions.list` payloads.
  execHost?: SessionEntry["execHost"];
  execSecurity?: SessionEntry["execSecurity"];
  execAsk?: SessionEntry["execAsk"];
  planMode?: SessionEntry["planMode"];
  pendingInteraction?: SessionEntry["pendingInteraction"];
  /**
   * Codex P2 review #68939 (2026-04-19): mirror of
   * `SessionEntry.pendingQuestionApprovalId` for the UI's /plan
   * answer flow. Read-only on the wire — the persister writes it
   * when an `ask_user_question` approval event fires; the patch
   * handler clears it after a successful answer.
   */
  pendingQuestionApprovalId?: SessionEntry["pendingQuestionApprovalId"];
};

export type GatewayAgentRow = SharedGatewayAgentRow;

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = SessionsListResultBase<GatewaySessionsDefaults, GatewaySessionRow>;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};
