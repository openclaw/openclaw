// Host-enforced registration scopes shared by hook presence checks and dispatch.
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import { parseAgentSessionKey } from "@openclaw/session-url-contract/session-key-normalization";
import {
  isPluginHookReplyDispatchKind,
  type PluginHookAgentTrigger,
} from "./hook-registration-scopes.js";
import type { PluginHookRegistration } from "./hook-types.js";

/** Outbound send hooks that may be limited to the agents whose replies they govern. */
export type PluginHookAgentScopedSendHookName = "reply_payload_sending" | "message_sending";

export const isPluginHookAgentScopedSendHookName = (
  hookName: unknown,
): hookName is PluginHookAgentScopedSendHookName =>
  hookName === "reply_payload_sending" || hookName === "message_sending";

/**
 * Canonical agent ids for `eligibleAgentIds`. Omitted, empty, or malformed lists stay
 * unrestricted, matching the other registration scopes.
 */
export function normalizeHookEligibleAgentIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const entries: unknown[] = Array.from(value);
  if (!entries.every((entry) => typeof entry === "string" && isValidAgentId(entry))) {
    return undefined;
  }
  return [...new Set(entries.map((entry) => String(entry).trim().toLowerCase()))];
}

function readContextAgentId(ctx: unknown): string | undefined {
  const sessionKey =
    typeof ctx === "object" && ctx !== null && "sessionKey" in ctx ? ctx.sessionKey : undefined;
  return typeof sessionKey === "string" ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
}

/**
 * A scoped send hook is skipped only when the context proves another agent owns the
 * reply. Missing or non-agent session keys stay eligible, so callers cannot under-report.
 */
function isHookAgentEligible(hook: PluginHookRegistration, ctx: unknown): boolean {
  if (hook.eligibleAgentIds === undefined) {
    return true;
  }
  const agentId = readContextAgentId(ctx)?.toLowerCase();
  return agentId === undefined || hook.eligibleAgentIds.includes(agentId);
}

export function isHookContextEligible(hook: PluginHookRegistration, ctx?: unknown): boolean {
  if (isPluginHookAgentScopedSendHookName(hook.hookName)) {
    return isHookAgentEligible(hook, ctx);
  }
  if (hook.hookName === "reply_dispatch" && hook.eligibleDispatchKinds !== undefined) {
    const kind =
      typeof ctx === "object" && ctx !== null && "dispatchKind" in ctx
        ? ctx.dispatchKind
        : undefined;
    // Unknown callers cannot prove exclusion from a hook, including during recovery checks.
    return !isPluginHookReplyDispatchKind(kind) || hook.eligibleDispatchKinds.includes(kind);
  }
  if (hook.hookName !== "before_agent_reply" || hook.eligibleTriggers === undefined) {
    return true;
  }
  const trigger =
    typeof ctx === "object" && ctx !== null && "trigger" in ctx
      ? (ctx as { trigger?: unknown }).trigger
      : undefined;
  return (
    typeof trigger === "string" && hook.eligibleTriggers.includes(trigger as PluginHookAgentTrigger)
  );
}

/** Dispatch context for registration scopes; only scoped send hooks read it today. */
export const resolveHookDispatchScopeContext = (hookName: string, ctx: unknown): unknown =>
  isPluginHookAgentScopedSendHookName(hookName) ? ctx : undefined;
