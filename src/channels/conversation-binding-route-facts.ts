import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../infra/outbound/session-binding.types.js";
import { isPluginOwnedBindingMetadata } from "../plugins/conversation-binding-metadata.js";
import {
  isUnscopedSessionKeySentinel,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";

type BindingSelection =
  | { kind: "none"; ignoredCronSessionKey?: string }
  | { kind: "plugin"; binding: SessionBindingRecord; pluginId: string; pluginRoot: string }
  | { kind: "agent"; binding: SessionBindingRecord; sessionKey: string };

/** The same normalization governs initial projection and later ownership comparison. */
export function resolveConversationBindingSelection(
  binding: SessionBindingRecord | null,
): BindingSelection {
  const sessionKey = binding?.targetSessionKey?.trim();
  if (!binding || !sessionKey) {
    return { kind: "none" };
  }
  if (isCronRunSessionKey(sessionKey)) {
    return { kind: "none", ignoredCronSessionKey: sessionKey };
  }
  const metadata = binding.metadata;
  if (isPluginOwnedBindingMetadata(metadata)) {
    const pluginId = metadata.pluginId.trim();
    if (pluginId) {
      return { kind: "plugin", binding, pluginId, pluginRoot: metadata.pluginRoot };
    }
  }
  return { kind: "agent", binding, sessionKey };
}

export function resolveConversationBindingAgentId(
  binding: SessionBindingRecord,
  fallbackAgentId: string,
): string {
  const sessionKey = binding.targetSessionKey.trim();
  return resolveAgentIdFromSessionKey(
    sessionKey,
    isUnscopedSessionKeySentinel(sessionKey)
      ? (normalizeOptionalString(binding.metadata?.agentId) ?? fallbackAgentId)
      : undefined,
  );
}

type BindingIdentity = Readonly<
  Pick<SessionBindingRecord, "bindingId" | "boundAt" | "targetSessionKey" | "targetKind"> & {
    bindingConversation: Readonly<ConversationRef>;
  }
>;
type ConversationBindingRouteFacts = Readonly<{
  agentId: string;
  fallbackAgentId: string;
  observedAgentId: string;
  previous?: ConversationBindingRouteFacts;
  conversation: Readonly<ConversationRef>;
}> &
  (
    | Readonly<{ kind: "none" | "unavailable" }>
    | (BindingIdentity & Readonly<{ kind: "agent" }>)
    | (BindingIdentity & Readonly<{ kind: "plugin"; pluginId: string; pluginRoot: string }>)
  );

// SDK route production and core context construction can live in separate build entries.
// Enumerable symbol facts survive route/context spreads without entering serialized payloads.
const BINDING_ROUTE_FACTS = Symbol.for("openclaw.conversationBindingRouteFacts");
type Carrier = {
  SessionKey?: string;
  sessionKey?: string;
  routeSessionKey?: string;
  dispatchSessionKey?: string;
  [BINDING_ROUTE_FACTS]?: ConversationBindingRouteFacts;
};

export function withConversationBindingRouteFacts<
  T extends { sessionKey: string; agentId: string },
>(
  route: T,
  selection: BindingSelection | { kind: "unavailable" },
  fallbackAgentId: string,
  conversation: ConversationRef,
) {
  const previous = readConversationBindingRouteFacts(route);
  const sameConversation =
    previous &&
    previous.conversation.channel === conversation.channel &&
    previous.conversation.accountId === conversation.accountId &&
    previous.conversation.conversationId === conversation.conversationId &&
    previous.conversation.parentConversationId === conversation.parentConversationId;
  const scope = {
    agentId: route.agentId,
    observedAgentId:
      selection.kind === "agent"
        ? resolveConversationBindingAgentId(selection.binding, fallbackAgentId)
        : route.agentId,
    previous: sameConversation ? previous.previous : previous,
    fallbackAgentId,
    conversation: Object.freeze({ ...conversation }),
  };
  let facts: ConversationBindingRouteFacts;
  if (selection.kind === "none" || selection.kind === "unavailable") {
    facts = Object.freeze({ ...scope, kind: selection.kind });
  } else {
    const { binding } = selection;
    const identity = {
      ...scope,
      bindingId: binding.bindingId,
      boundAt: binding.boundAt,
      targetSessionKey: binding.targetSessionKey,
      targetKind: binding.targetKind,
      bindingConversation: Object.freeze({ ...binding.conversation }),
    };
    facts =
      selection.kind === "plugin"
        ? Object.freeze({
            ...identity,
            kind: "plugin",
            pluginId: selection.pluginId,
            pluginRoot: selection.pluginRoot,
          })
        : Object.freeze({ ...identity, kind: "agent" });
  }
  return Object.assign(route, { [BINDING_ROUTE_FACTS]: facts });
}

export function readConversationBindingRouteFacts(
  value: Carrier,
): ConversationBindingRouteFacts | undefined {
  return value[BINDING_ROUTE_FACTS];
}

export function copyConversationBindingRouteFacts(
  route: Carrier,
  context: { SessionKey?: string; AgentId?: string },
): void {
  const facts = readConversationBindingRouteFacts(route);
  // Derived thread keys retain the observation, but another agent's broadcast must not.
  const selectedSessionKey = route.dispatchSessionKey ?? route.sessionKey;
  if (facts && selectedSessionKey === context.SessionKey && facts.agentId === context.AgentId) {
    Object.assign(context, { [BINDING_ROUTE_FACTS]: facts });
  }
}

export function matchesConversationBindingRouteFacts(
  expected: ConversationBindingRouteFacts,
  current: SessionBindingRecord | null,
): boolean {
  if (expected.kind === "unavailable") {
    return false;
  }
  const selection = resolveConversationBindingSelection(current);
  if (selection.kind === "none") {
    return expected.kind === "none";
  }
  if (expected.kind === "none" || expected.kind !== selection.kind) {
    return false;
  }
  const binding = selection.binding;
  if (
    binding.bindingId !== expected.bindingId ||
    binding.boundAt !== expected.boundAt ||
    binding.targetSessionKey !== expected.targetSessionKey ||
    binding.targetKind !== expected.targetKind ||
    binding.conversation.channel !== expected.bindingConversation.channel ||
    binding.conversation.accountId !== expected.bindingConversation.accountId ||
    binding.conversation.conversationId !== expected.bindingConversation.conversationId ||
    binding.conversation.parentConversationId !== expected.bindingConversation.parentConversationId
  ) {
    return false;
  }
  return expected.kind === "plugin"
    ? selection.kind === "plugin" &&
        selection.pluginId === expected.pluginId &&
        selection.pluginRoot === expected.pluginRoot
    : selection.kind === "agent" &&
        resolveConversationBindingAgentId(selection.binding, expected.fallbackAgentId) ===
          expected.observedAgentId;
}

/** Configured routing changes the dispatch owner without changing the inspected selection. */
export function projectConfiguredConversationBindingRouteFacts<
  T extends { sessionKey: string; agentId: string },
>(route: T): T {
  const facts = readConversationBindingRouteFacts(route);
  return facts
    ? Object.assign(
        { ...route },
        {
          [BINDING_ROUTE_FACTS]: Object.freeze({ ...facts, agentId: route.agentId }),
        },
      )
    : route;
}

export function readConversationBindingRouteObservations(value: Carrier) {
  const observations: ConversationBindingRouteFacts[] = [];
  for (
    let current = readConversationBindingRouteFacts(value);
    current;
    current = current.previous
  ) {
    observations.unshift(current);
  }
  return observations;
}
