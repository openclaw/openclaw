import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type, type Static } from "typebox";
import {
  SessionCreatedActorSchema,
  SessionRowSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionRow } from "../../gateway/session-utils.types.js";
import { parseRawSessionConversationRef } from "../../sessions/session-key-utils.js";
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

export type GatewaySessionListRow = Omit<
  GatewaySessionRow,
  "classification" | "contextTokens" | "totalTokens" | "updatedAt"
> & {
  classification: NonNullable<GatewaySessionRow["classification"]>;
  contextTokens?: number | null;
  totalTokens?: number | null;
  updatedAt?: number;
};

export type SessionListRow = Static<typeof SessionListRowSchema>;

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

export function classifySessionListKind(params: {
  classification: NonNullable<GatewaySessionListRow["classification"]>;
  peerKind?: GatewaySessionListRow["peerKind"];
}): SessionKind {
  if (params.classification === "thread") {
    return params.peerKind === "group" || params.peerKind === "channel" ? "group" : "other";
  }
  return SESSION_KIND_BY_CLASSIFICATION[params.classification] ?? "other";
}

export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  return (
    normalizeOptionalString(params.channel) ??
    normalizeOptionalString(params.lastChannel) ??
    parseRawSessionConversationRef(params.key)?.channel ??
    "unknown"
  );
}
