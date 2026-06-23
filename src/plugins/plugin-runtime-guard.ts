import type { PluginActionDescriptor } from "./plugin-adapter.types";
import { decidePluginActionPolicy, type PluginActionCapability } from "./plugin-capability-policy";

/**
 * PLUGIN-RUNTIME-002: Runtime guard decision for a plugin action.
 *
 * Wraps `decidePluginActionPolicy` into a runtime-friendly shape.
 * - `allow`: action may proceed without approval.
 * - `approval_required`: action must wait for user approval.
 * - `deny`: action is unconditionally blocked.
 */
export type PluginRuntimeGuardDecision =
  | { ok: true; decision: "allow" }
  | {
      ok: false;
      decision: "approval_required";
      reason: string;
      descriptor: PluginActionDescriptor;
    }
  | {
      ok: false;
      decision: "deny";
      reason: string;
      descriptor: PluginActionDescriptor;
    };

/**
 * PLUGIN-RUNTIME-BLOCK-003: Guard enforcement mode.
 * - `enforce`: blocked actions are not executed.
 * - `log_only`: blocked actions are logged but still executed.
 */
export type PluginRuntimeGuardMode = "enforce" | "log_only";

// ─── Tool name → capability mapping patterns ────────────────────
// PLUGIN-RUNTIME-BLOCK-003 §7: MCP tool name heuristic classification.
// These patterns classify tool names into plugin action capabilities
// at the `callTool(serverName, toolName, args)` chokepoint.

const TOOL_READ_PATTERN =
  /^(read|get|list|search|find|fetch|query|lookup|check|peek|view|show|browse|select|info|stat|describe|dump|export|print|resolve|retrieve|status|ping|health|version|navigate|open)/i;

// Order matters: more specific (destructive/financial/send) checked before generic write.
// camelCase variants included alongside snake/kebab for real-world MCP tool names.

const TOOL_DESTRUCTIVE_PATTERN =
  /^(drop|truncate|format|shutdown|reboot|destroy|terminate|kill|ban|block|purgeAll|purge_all|purge-all|wipeAll|wipe_all|wipe-all|deleteAll|delete_all|delete-all|eject|nuke|reset|resetAll|reset_all)/i;

const TOOL_FINANCIAL_PATTERN =
  /^(buy|sell|trade|order|pay|charge|transfer|placeOrder|place_order|place-order|cancelOrder|cancel_order|cancel-order|deposit|withdraw|invest|subscribe_paid|subscribePaid|purchase|purchaseItem)/i;

const TOOL_SEND_PATTERN =
  /^(send|email|mail|message|notify|alert|broadcast|dispatch|postMessage|post_message|post-message|reply|comment|share|tweet|publish)/i;

const TOOL_DELETE_PATTERN =
  /^(delete|remove|wipe|clear|unset|unlink|unsubscribe|unfollow|erase|purge|pop|shift)/i;

// Generic write: CRUD and system action verbs. Checked after send/delete.
const TOOL_WRITE_PATTERN =
  /^(create|update|set|add|put|post|patch|write|save|store|insert|upsert|edit|modify|change|rename|copy|move|merge|upload|import|register|subscribe|follow|like|watch|toggle|enable|disable|start|stop|restart)/i;

/**
 * PLUGIN-RUNTIME-BLOCK-003: Map an MCP tool name to plugin action capabilities.
 *
 * Uses heuristic name-prefix matching. Returns a minimal set of capabilities
 * for policy enforcement. The default for unrecognized patterns is `["write"]`
 * (conservative — assume write if unsure).
 *
 * Safety: never throws, never returns an empty array.
 */
export function decideToolCallCapability(toolName: string): PluginActionCapability[] {
  try {
    if (!toolName || typeof toolName !== "string") {
      return ["write"];
    }
    if (TOOL_DESTRUCTIVE_PATTERN.test(toolName)) return ["destructive"];
    if (TOOL_FINANCIAL_PATTERN.test(toolName)) return ["financial_execution"];
    if (TOOL_SEND_PATTERN.test(toolName)) return ["send", "write"];
    if (TOOL_DELETE_PATTERN.test(toolName)) return ["delete", "write"];
    if (TOOL_WRITE_PATTERN.test(toolName)) return ["write"];
    if (TOOL_READ_PATTERN.test(toolName)) return ["read"];
    // Word-boundary probe check: tools containing "probe" are read-only probes
    if (/probe/i.test(toolName)) return ["read"];
    // Default: conservative — assume write
    return ["write"];
  } catch {
    return ["write"];
  }
}

/**
 * PLUGIN-RUNTIME-BLOCK-003: Build a controlled "blocked by policy" result text.
 */
export function formatBlockedResult(
  decision: PluginRuntimeGuardDecision,
  descriptor: PluginActionDescriptor,
): string {
  if (decision.decision === "allow") {
    return "";
  }
  const caps = descriptor.capabilities?.join(", ") ?? "unknown";
  if (decision.decision === "approval_required") {
    return `Action blocked by plugin policy: approval required. Capability: ${caps}. No external action was executed.`;
  }
  // deny
  return `Action denied by plugin policy. Capability: ${caps}. No external action was executed.`;
}

// ─── Simple LRU cache ────────────────────────────────────────────
// Caches capability decisions by tool name to avoid repeated pattern matching.
// Size-limited; never throws.

const CAPABILITY_CACHE_MAX = 256;
const capabilityCache = new Map<string, PluginActionCapability[]>();

function getCachedCapability(toolName: string): PluginActionCapability[] | undefined {
  return capabilityCache.get(toolName);
}

function setCachedCapability(toolName: string, caps: PluginActionCapability[]): void {
  if (capabilityCache.size >= CAPABILITY_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order)
    const firstKey = capabilityCache.keys().next();
    if (firstKey.value !== undefined) {
      capabilityCache.delete(firstKey.value);
    }
  }
  capabilityCache.set(toolName, caps);
}

/**
 * PLUGIN-RUNTIME-BLOCK-003: Cached version of `decideToolCallCapability`.
 * Same semantics, but avoids repeated pattern matching for frequently-called tools.
 */
export function decideToolCallCapabilityCached(toolName: string): PluginActionCapability[] {
  const cached = getCachedCapability(toolName);
  if (cached !== undefined) {
    return cached;
  }
  const caps = decideToolCallCapability(toolName);
  setCachedCapability(toolName, caps);
  return caps;
}

// ─── Test helpers ──────────────────────────────────────────────────

/** Clear the capability decision cache. Exported for testing only. */
export function __clearCapabilityCache(): void {
  capabilityCache.clear();
}

// ─── Core guard functions ─────────────────────────────────────────

/**
 * Guard a single plugin action at runtime.
 *
 * Converts a `PluginActionDescriptor` into `decidePluginActionPolicy` input
 * and returns a runtime-friendly decision.
 *
 * Safety properties:
 * - Empty capabilities → deny.
 * - Null/undefined capabilities array → deny.
 * - Unknown capability values → treated as read-only (allow).
 * - Never throws.
 */
export function guardPluginActionRuntime(
  descriptor: PluginActionDescriptor,
): PluginRuntimeGuardDecision {
  try {
    if (!descriptor.capabilities || descriptor.capabilities.length === 0) {
      return {
        ok: false,
        decision: "deny",
        reason: "No capabilities declared",
        descriptor,
      };
    }

    const policy = decidePluginActionPolicy({
      pluginId: descriptor.id,
      actionId: descriptor.name,
      capabilities: descriptor.capabilities,
    });

    switch (policy.kind) {
      case "allow":
        return { ok: true, decision: "allow" };
      case "approval_required":
        return { ok: false, decision: "approval_required", reason: policy.reason, descriptor };
      case "deny":
        return { ok: false, decision: "deny", reason: policy.reason, descriptor };
    }
  } catch (err) {
    // PLUGIN-RUNTIME-002 §7(4): guard must never crash the agent/gateway
    return {
      ok: false,
      decision: "deny",
      reason: `Runtime guard internal error: ${(err as Error).message ?? err}`,
      descriptor,
    };
  }
}

/**
 * Guard multiple plugin actions at runtime.
 *
 * Returns the first non-allow decision, or `allow` if all pass.
 * Does not throw.
 */
export function guardPluginActionsRuntime(
  descriptors: readonly PluginActionDescriptor[],
): PluginRuntimeGuardDecision {
  for (const descriptor of descriptors) {
    const decision = guardPluginActionRuntime(descriptor);
    if (!decision.ok) {
      return decision;
    }
  }
  return { ok: true, decision: "allow" };
}
