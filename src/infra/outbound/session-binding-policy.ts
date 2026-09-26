import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import { PLUGIN_BINDING_SESSION_PREFIX } from "../../plugins/conversation-binding-session-key.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../../utils/message-channel-constants.js";
import { SessionBindingError } from "./session-binding-errors.js";
import type { SessionBindingBindInput, SessionBindingRecord } from "./session-binding.types.js";

type BindingTarget = Pick<
  SessionBindingBindInput,
  "targetSessionKey" | "targetKind" | "metadata"
> & {
  conversation: Pick<SessionBindingBindInput["conversation"], "channel">;
};

function isChatChannelBinding(target: BindingTarget): boolean {
  const channel = normalizeOptionalLowercaseString(target.conversation.channel);
  // Operator UI/Team sessions and internal wake sources are not external chat channels.
  return Boolean(
    channel &&
    channel !== INTERNAL_MESSAGE_CHANNEL &&
    channel !== "tui" &&
    !isInternalNonDeliveryChannel(channel),
  );
}

/** Persisted binding facts remain sufficient after a worker/run/session has been pruned. */
export function isDelegatedChannelBindingTarget(target: BindingTarget): boolean {
  if (!isChatChannelBinding(target)) {
    return false;
  }
  return (
    target.targetKind === "subagent" ||
    isSubagentSessionKey(target.targetSessionKey) ||
    (isAcpSessionKey(target.targetSessionKey) &&
      normalizeOptionalLowercaseString(target.metadata?.boundBy) === "system")
  );
}

/** Parent links alone also describe user-owned ACP sessions and ordinary UI threads. */
function isDelegatedSessionBindingEntry(entry: SessionEntry | undefined): boolean {
  const depth =
    typeof entry?.spawnDepth === "string"
      ? parseStrictNonNegativeInteger(entry.spawnDepth)
      : entry?.spawnDepth;
  return (
    (typeof depth === "number" && Number.isInteger(depth) && depth > 0) ||
    entry?.subagentRole === "leaf" ||
    entry?.subagentRole === "orchestrator" ||
    entry?.createdVia === "spawn" ||
    Boolean(normalizeOptionalString(entry?.spawnedBy))
  );
}

/** Session aliases and visible dashboard children require durable provenance, not run history. */
export async function isDelegatedChannelBindingTargetAsync(
  target: BindingTarget,
  assertCurrent: () => void,
  config?: OpenClawConfig,
): Promise<boolean> {
  if (!isChatChannelBinding(target)) {
    return false;
  }
  if (isDelegatedChannelBindingTarget(target)) {
    return true;
  }
  if (
    isPluginOwnedBindingMetadata(target.metadata) &&
    target.targetSessionKey.trim().startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`)
  ) {
    // Plugin-owned opaque targets are not session-store aliases. Agent-scoped targets
    // must still prove that they are not delegated sessions, regardless of metadata.
    return false;
  }
  const [
    { getRuntimeConfig },
    { resolveSessionStorePathCore },
    { withSessionEntryReadOnlyInWorker },
    { resolveDefaultAgentId },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/session-entry-read-runtime.js"),
    import("../../agents/agent-scope-config.js"),
  ]);
  assertCurrent();
  const cfg = config ?? getRuntimeConfig();
  const agentId =
    parseAgentSessionKey(target.targetSessionKey)?.agentId ??
    normalizeOptionalString(target.metadata?.agentId) ??
    resolveDefaultAgentId(cfg);
  return withSessionEntryReadOnlyInWorker(
    {
      agentId,
      sessionKey: target.targetSessionKey.trim(),
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      projection: "list",
    },
    assertCurrent,
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return isDelegatedSessionBindingEntry(read.value);
    },
  );
}

export function bindingPolicyIdentity(binding: SessionBindingRecord | null): string | null {
  return (
    binding &&
    JSON.stringify([
      binding.bindingId,
      binding.boundAt,
      binding.targetSessionKey,
      binding.targetKind,
      binding.status,
      binding.conversation,
      binding.metadata?.agentId,
      binding.metadata?.boundBy,
      binding.metadata?.pluginBindingOwner,
      binding.metadata?.pluginId,
      binding.metadata?.pluginRoot,
    ])
  );
}

export function assertBindingPolicyIdentity(
  previous: string | null,
  current: SessionBindingRecord | null,
) {
  if (bindingPolicyIdentity(current) !== previous) {
    throw new SessionBindingError(
      "BINDING_ADAPTER_UNAVAILABLE",
      "Conversation binding changed during target inspection. Retry the message.",
    );
  }
}

export function routableBinding(binding: SessionBindingRecord | null): SessionBindingRecord | null {
  return binding && !isDelegatedChannelBindingTarget(binding) ? binding : null;
}

export async function routableBindingAsync(
  binding: SessionBindingRecord | null,
  assertCurrent: () => void,
): Promise<SessionBindingRecord | null> {
  const result =
    binding && !(await isDelegatedChannelBindingTargetAsync(binding, assertCurrent))
      ? binding
      : null;
  assertCurrent();
  return result;
}

export async function routableBindingsAsync(
  bindings: readonly (SessionBindingRecord | null)[],
  assertCurrent: () => void,
): Promise<Array<SessionBindingRecord | null>> {
  const targets = new Map<string, Promise<boolean>>();
  const results = await Promise.all(
    bindings.map(async (binding) => {
      if (!binding || isDelegatedChannelBindingTarget(binding)) {
        return null;
      }
      const key = JSON.stringify([
        binding.conversation.channel,
        binding.targetSessionKey.trim(),
        binding.metadata,
      ]);
      let delegated = targets.get(key);
      if (!delegated) {
        delegated = isDelegatedChannelBindingTargetAsync(binding, assertCurrent);
        targets.set(key, delegated);
      }
      return (await delegated) ? null : binding;
    }),
  );
  assertCurrent();
  return results;
}
