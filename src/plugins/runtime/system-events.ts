import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/io.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import * as events from "../../infra/system-events.js";
import { normalizeAgentIdStrict, parseAgentSessionKey } from "../../routing/session-key.js";

/** Published SDK aliases resolve here; the process queues retain only qualified identities. */
function resolveSystemEventSessionKey(sessionKey: string, agentId?: string): string {
  const explicitOwner = agentId === undefined ? undefined : normalizeAgentIdStrict(agentId);
  if (explicitOwner && !explicitOwner.ok) {
    throw new Error("Invalid system event agentId.");
  }
  const normalizedAgentId = explicitOwner?.value;
  if (parseAgentSessionKey(sessionKey)) {
    return resolveSystemEventQueueKey(sessionKey, normalizedAgentId);
  }
  const cfg = getRuntimeConfig();
  const owner = resolveSessionAgentId({ config: cfg, sessionKey, agentId: normalizedAgentId });
  return resolveSystemEventQueueKey(
    canonicalizeMainSessionAlias({ cfg, agentId: owner, sessionKey }),
    owner,
  );
}

export const enqueueSystemEventFromSdk = (
  text: string,
  { agentId, ...options }: Parameters<typeof events.enqueueSystemEvent>[1] & { agentId?: string },
) =>
  events.enqueueSystemEvent(text, {
    ...options,
    sessionKey: resolveSystemEventSessionKey(options.sessionKey, agentId),
  });

export const enqueueSystemEventEntryFromSdk: typeof events.enqueueSystemEventEntry = (
  text,
  options,
) =>
  events.enqueueSystemEventEntry(text, {
    ...options,
    sessionKey: resolveSystemEventSessionKey(options.sessionKey),
  });

export function enqueueRoutedSystemEvent(
  text: string,
  route: { agentId: string; sessionKey: string },
  options: Omit<Parameters<typeof events.enqueueSystemEvent>[1], "sessionKey"> = {},
): boolean {
  if (!route.agentId.trim()) {
    throw new Error("routed system events require route.agentId");
  }
  return enqueueSystemEventFromSdk(text, {
    ...options,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  });
}

export const consumeSelectedSystemEventEntriesFromSdk: typeof events.consumeSelectedSystemEventEntries =
  (key, entries) =>
    events.consumeSelectedSystemEventEntries(resolveSystemEventSessionKey(key), entries);
export const drainSystemEventEntriesFromSdk: typeof events.drainSystemEventEntries = (key) =>
  events.drainSystemEventEntries(resolveSystemEventSessionKey(key));
export const drainSystemEventsFromSdk: typeof events.drainSystemEvents = (key) =>
  events.drainSystemEvents(resolveSystemEventSessionKey(key));
export const hasSystemEventsFromSdk: typeof events.hasSystemEvents = (key) =>
  events.hasSystemEvents(resolveSystemEventSessionKey(key));
export const isSystemEventContextChangedFromSdk: typeof events.isSystemEventContextChanged = (
  key,
  context,
) => events.isSystemEventContextChanged(resolveSystemEventSessionKey(key), context);
export function peekSystemEventEntriesFromSdk(key: string, agentId?: string) {
  return events.peekSystemEventEntries(resolveSystemEventSessionKey(key, agentId));
}
export const peekSystemEventsFromSdk: typeof events.peekSystemEvents = (key) =>
  events.peekSystemEvents(resolveSystemEventSessionKey(key));
export {
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "../../infra/system-events.js";
