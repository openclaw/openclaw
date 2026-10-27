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
  const eventOptions = withSystemEventOwner(
    {
      sessionKey,
      contextKey: `notification:${key}`,
      deliveryContext: expectedTarget.deliveryContext,
    },
    agentId,
  );
  const occurrence = enqueueSystemEventEntry(summary, eventOptions);
  if (occurrence) {
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
      });
      source?.pending.push(receipt.settled);
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        throw new Error(accepted.error);
      }
      void receipt.settled.then((outcome) => {
        if (outcome.status !== "completed") {
          ctx.logGateway.warn(`notification event not delivered node=${nodeId}: ${outcome.status}`);
        }
      });
    } catch (error) {
      consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
      throw error;
    }
  }
  return undefined;
}
