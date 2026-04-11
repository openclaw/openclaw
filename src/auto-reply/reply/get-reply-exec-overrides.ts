import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

export type ReplyExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;

export function resolveReplyExecOverrides(params: {
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  agentExecDefaults?: ReplyExecOverrides;
  senderIsOwner?: boolean;
}): ReplyExecOverrides | undefined {
  // Non-owner senders (channel auto-reply) cannot override exec via directives
  // or session entries, which could be injected via prompt injection.
  // Only operator-configured agent defaults are honored.
  if (params.senderIsOwner === false) {
    if (!params.agentExecDefaults) {
      return { security: "deny", ask: "always" };
    }
    return params.agentExecDefaults;
  }

  const host =
    params.directives.execHost ??
    (params.sessionEntry?.execHost as ReplyExecOverrides["host"]) ??
    params.agentExecDefaults?.host;
  const security =
    params.directives.execSecurity ??
    (params.sessionEntry?.execSecurity as ReplyExecOverrides["security"]) ??
    params.agentExecDefaults?.security;
  const ask =
    params.directives.execAsk ??
    (params.sessionEntry?.execAsk as ReplyExecOverrides["ask"]) ??
    params.agentExecDefaults?.ask;
  const node =
    params.directives.execNode ?? params.sessionEntry?.execNode ?? params.agentExecDefaults?.node;
  if (!host && !security && !ask && !node) {
    return undefined;
  }
  return { host, security, ask, node };
}
