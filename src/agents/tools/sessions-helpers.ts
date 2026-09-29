import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type, type Static } from "typebox";
import type { SessionRow } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SessionCreatedActorSchema,
  SessionRowSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseRawSessionConversationRef } from "../../sessions/session-key-utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-access.js";
export {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";
export {
  resolveCurrentSessionClientAlias,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  resolveVisibleSessionReference,
  isExpectedSessionLookupMiss,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";

/** Coarse session kind used by session list/status tools. */
export const SESSION_LIST_KINDS = ["main", "group", "cron", "hook", "node", "other"] as const;
type SessionKind = (typeof SESSION_LIST_KINDS)[number];

const SESSION_KIND_BY_CLASSIFICATION: Readonly<Record<string, SessionKind>> = {
  main: "main",
  global: "main",
  group: "group",
  channel: "group",
  cron: "cron",
  hook: "hook",
  node: "node",
};

const SessionInventoryActorSchema = Type.Omit(SessionCreatedActorSchema, ["avatarUrl"]);

/** Focused model-facing row contract derived from the Gateway protocol projection. */
export const SessionListRowSchema = Type.Object(
  {
    ...Type.Pick(SessionRowSchema, [
      "key",
      "sessionId",
      "label",
      "worktree",
      "repositoryWorkspaceId",
      "repository",
      "execCwd",
      "spawnedCwd",
      "spawnedWorkspaceDir",
      "projectId",
      "workspaceDir",
      "displayName",
      "derivedTitle",
      "lastMessagePreview",
      "parentSessionKey",
      "model",
      "contextTokens",
      "totalTokens",
      "status",
      "childSessions",
    ]).properties,
    agentId: Type.String(),
    kind: stringEnum(SESSION_LIST_KINDS),
    channel: Type.String(),
    archived: Type.Boolean(),
    pinned: Type.Boolean(),
    createdActor: Type.Optional(SessionInventoryActorSchema),
    owner: Type.Optional(
      Type.Object({ actor: SessionInventoryActorSchema }, { additionalProperties: false }),
    ),
    group: Type.Optional(
      Type.String({
        description: 'Custom sidebar group membership; unrelated to kind "group" (group chats).',
      }),
    ),
    updatedAt: Type.Optional(Type.Number()),
    stateVersion: Type.Optional(Type.Number()),
    abortedLastRun: Type.Optional(Type.Boolean()),
    messages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);

/** Full Gateway session row consumed by session orchestration internals. */
export type GatewaySessionListRow = Omit<
  SessionRow,
  "classification" | "contextTokens" | "totalTokens"
> & {
  classification: NonNullable<SessionRow["classification"]>;
  contextTokens?: number | null;
  totalTokens?: number | null;
  origin?: {
    provider?: string;
    accountId?: string;
  };
  category?: string;
  deliveryContext?: DeliveryContext;
  abortedLastRun?: boolean;
  lastChannel?: string;
};

/** Focused model-facing row returned by sessions_list. */
export type SessionListRow = Static<typeof SessionListRowSchema>;

/** Resolves config plus sandbox visibility context for a session tool call. */
export function resolveSessionToolContext(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  sessionReadScopeKey?: string;
  requesterAgentIdOverride?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  const cfg = opts?.config ?? getRuntimeConfig();
  return {
    cfg,
    a2aPolicy: createAgentToAgentPolicy(cfg),
    // Only read-tool constructors accept this host-bound scope. The temporary
    // auxiliary run keeps its execution identity but can read just the observed session.
    sessionVisibility: opts?.sessionReadScopeKey
      ? ("self" as const)
      : resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: opts?.sandboxed === true }),
    ...resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: opts?.sessionReadScopeKey ?? opts?.agentSessionKey,
      requesterAgentId: opts?.requesterAgentIdOverride ?? opts?.agentId,
      sandboxed: opts?.sandboxed,
    }),
  };
}

/** Projects the Gateway's authoritative classification into the tool's coarse kinds. */
export function classifySessionListKind(params: {
  classification: NonNullable<GatewaySessionListRow["classification"]>;
  peerKind?: GatewaySessionListRow["peerKind"];
}): SessionKind {
  if (params.classification === "thread") {
    return params.peerKind === "group" || params.peerKind === "channel" ? "group" : "other";
  }
  return SESSION_KIND_BY_CLASSIFICATION[params.classification] ?? "other";
}

/** Derives the best channel label for a session row. */
export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeOptionalString(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeOptionalString(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  return parseRawSessionConversationRef(params.key)?.channel ?? "unknown";
}
