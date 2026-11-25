import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { resolveSystemMainSessionTarget } from "../config/sessions/main-session.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
} from "../infra/system-events.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import {
  captureNodeEventConfig,
  compactNodeEventText,
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  type NodeEventSessionSource,
} from "./server-node-event-source.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
// Newest pending posted update per session, route and notification. An older update that
// settles as cancelled before it started lost its place to that newer one.
const latestPostedUpdates = new Map<string, string | undefined>();

export async function handleNodeNotificationEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
  source?: NodeEventSessionSource,
): Promise<NodeEventHandleResult | undefined> {
  const obj = parseNodeEventPayload(evt.payloadJSON);
  if (!obj) {
    return undefined;
  }
  const change = normalizeLowercaseStringOrEmpty(obj.change);
  if (change !== "posted" && change !== "removed") {
    return undefined;
  }
  const key = normalizeOptionalString(obj.key);
  if (!key) {
    return undefined;
  }
  const requestedSessionKey = normalizeOptionalString(obj.sessionKey);
  const config = captureNodeEventConfig();
  let target: { sessionKey: string; agentId?: string };
  try {
    target = requestedSessionKey
      ? { sessionKey: requestedSessionKey }
      : resolveSystemMainSessionTarget(config.cfg);
  } catch (error) {
    ctx.logGateway.warn(
      `notification event not delivered node=${nodeId}: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
  const {
    canonicalKey: sessionKey,
    entry,
    agentId,
  } = source?.loaded ??
  (await loadGatewaySessionEntryReadOnlyInWorker({
    cfg: config.cfg,
    key: target.sessionKey,
    agentId: target.agentId,
    excludeInternalEffects: true,
  }));
  config.assertCurrent();
  if (resolveAgentHarnessSessionContextError(sessionKey, entry)) {
    return undefined;
  }
  const packageName = normalizeOptionalString(obj.packageName);
  const title = compactNodeEventText(
    normalizeOptionalString(obj.title) ?? "",
    MAX_NOTIFICATION_EVENT_TEXT_CHARS,
  );
  const text = compactNodeEventText(
    normalizeOptionalString(obj.text) ?? "",
    MAX_NOTIFICATION_EVENT_TEXT_CHARS,
  );

  let summary = `Notification ${change} (node=${nodeId} key=${key}`;
  if (packageName) {
    summary += ` package=${packageName}`;
  }
  summary += ")";
  if (change === "posted") {
    const messageParts = [title, text].filter(Boolean);
    if (messageParts.length > 0) {
      summary += `: ${messageParts.join(" - ")}`;
    }
  }

  const assertAcceptanceCurrent = () => {
    config.assertCurrent();
    source?.assertCurrent();
    opts?.assertSessionEventCurrent?.();
  };
  const expectedTarget = await captureSessionEventTargetForHost(agentId, sessionKey, {
    assertCaptureCurrent: assertAcceptanceCurrent,
    assertCurrent: source?.assertCurrent,
  });
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  assertAcceptanceCurrent();
  const posted = change === "posted";
  // Android notification keys are unique per device only, so the node is part of the identity:
  // one phone's update never replaces another phone's pending event. The queue lowercases context
  // keys, and Android keys are case-sensitive, so both parts are hex-encoded.
  const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
  const eventOptions = withSystemEventOwner(
    {
      sessionKey,
      // Removals keep their own context, so a posted update never replaces a pending removal.
      contextKey: posted ? `notification:${hex(nodeId)}:${hex(key)}` : `notification:${key}`,
      deliveryContext: expectedTarget.deliveryContext,
      // A posted update replaces the still-pending update of the same notification and phone.
      replace: posted,
    },
    agentId,
  );
  const occurrence = enqueueSystemEventEntry(summary, eventOptions);
  if (occurrence) {
    const latestKey = [
      sessionKey,
      occurrence.contextKey,
      JSON.stringify(occurrence.deliveryContext ?? null),
    ].join("\u0000");
    if (posted) {
      latestPostedUpdates.set(latestKey, occurrence.id);
    }
    const replaced = () => posted && latestPostedUpdates.get(latestKey) !== occurrence.id;
    const forget = () => {
      if (posted && !replaced()) {
        latestPostedUpdates.delete(latestKey);
      }
    };
    try {
      const receipt = enqueueSessionEventForHost(summary, {
        agentId,
        sessionKey,
        source: "device",
        contextKey: eventOptions.contextKey,
        expectedTarget,
        occurrences: [occurrence],
        createIfMissing: true,
        assertAcceptanceCurrent,
        // Most notifications need no answer; the producer permits silence, provenance does not.
        replyExpectation: "optional",
      });
      source?.pending.push(receipt.settled);
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        // Replacement cancels the pending claim without an error cause; the newer update carries
        // on. Any refusal with a cause still fails this event.
        if (!accepted.cause && replaced()) {
          return undefined;
        }
        throw new Error(accepted.error);
      }
      void receipt.settled.then((outcome) => {
        const quiet =
          outcome.status === "completed" ||
          (outcome.status === "cancelled" && !outcome.executionStarted && replaced());
        forget();
        if (!quiet) {
          ctx.logGateway.warn(`notification event not delivered node=${nodeId}: ${outcome.status}`);
        }
      });
    } catch (error) {
      forget();
      consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
      throw error;
    }
  }
  return undefined;
}
