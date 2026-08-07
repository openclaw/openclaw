/** Resolves effective exec-tool overrides for reply runs. */
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { resolveExecToolConfig } from "../../agents/lazy-exec-tool.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Exec defaults that can be overridden by inline directives or session state. */
export type ReplyExecOverrides = Pick<
  ExecToolDefaults,
  "host" | "mode" | "security" | "ask" | "node" | "nodeCwd"
>;

/**
 * Project canonical `tools.exec` resolution into reply-session overrides (#112376).
 *
 * Reuses `resolveExecToolConfig` so fresh Dashboard/WebChat sessions stay aligned
 * with coding-tool policy precedence. Intentionally omits `nodeCwd`; that key is
 * not part of `ExecToolConfig` / strict schema.
 */
export function resolveConfigExecDefaults(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ReplyExecOverrides | undefined {
  const execConfig = resolveExecToolConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const host = execConfig.host;
  const mode = execConfig.mode;
  const security = execConfig.security;
  const ask = execConfig.ask;
  const node = execConfig.node;
  if (!host && !mode && !security && !ask && !node) {
    return undefined;
  }
  return {
    host,
    ...(mode ? { mode } : {}),
    security,
    ask,
    node,
  };
}

/** Resolves effective exec defaults for a reply run. */
export function resolveReplyExecOverrides(params: {
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  agentExecDefaults?: ReplyExecOverrides;
}): ReplyExecOverrides | undefined {
  const host =
    params.directives.execHost ??
    (params.sessionEntry?.execHost as ReplyExecOverrides["host"]) ??
    params.agentExecDefaults?.host;
  // Inline /exec and session fields currently carry security/ask, not mode.
  // Keep config mode only when neither layer supplies an explicit security/ask
  // override that should clear mode via the shared policy contract.
  const hasSessionOrInlinePolicy =
    params.directives.execSecurity !== undefined ||
    params.directives.execAsk !== undefined ||
    params.sessionEntry?.execSecurity !== undefined ||
    params.sessionEntry?.execAsk !== undefined;
  const mode = hasSessionOrInlinePolicy ? undefined : params.agentExecDefaults?.mode;
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
  // Working directory stays session/runtime-only and is bound to the selected
  // node. Persistent tools.exec must not seed nodeCwd.
  const nodeCwd =
    node && node === params.sessionEntry?.execNode ? params.sessionEntry.execCwd : undefined;
  if (!host && !mode && !security && !ask && !node && !nodeCwd) {
    return undefined;
  }
  return {
    host,
    ...(mode ? { mode } : {}),
    security,
    ask,
    node,
    ...(nodeCwd ? { nodeCwd } : {}),
  };
}
