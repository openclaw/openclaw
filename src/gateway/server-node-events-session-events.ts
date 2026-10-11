import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/io.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import { resolveSystemMainSessionTarget } from "../config/sessions/main-session.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../infra/event-session-routing.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
} from "../infra/system-events.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import {
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  type NodeEventSessionSource,
} from "./server-node-event-source.js";
import { pruneBoundedTimestampMap } from "./server-node-events-common.js";
import { enqueueNodeExecNotice } from "./server-node-events-exec-notice.js";
import type {
  NodeEvent,
  NodeEventConnectionOptions,
  NodeEventContext,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const MAX_NOTIFICATION_EVENT_TEXT_CHARS = 120;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;
const recentExecFinishedRuns = new Map<string, number>();

function shouldDropDuplicateExecFinished(params: {
  sessionKey: string;
  runId: string;
  now: number;
}): boolean {
  const fingerprint = `${params.sessionKey}::${params.runId}`;
  const previousTs = recentExecFinishedRuns.get(fingerprint);
  if (
    typeof previousTs === "number" &&
    params.now - previousTs <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentExecFinishedRuns.set(fingerprint, params.now);
  pruneBoundedTimestampMap(recentExecFinishedRuns, {
    now: params.now,
    ttlMs: EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS,
    maxEntries: MAX_RECENT_EXEC_FINISHED_RUNS,
  });

  return false;
}

function compactNodeEventText(raw: string, maxChars: number) {
  return truncateUtf16WithEllipsis(raw.replace(/\s+/g, " ").trim(), maxChars);
}

function captureNodeEventConfig() {
  const cfg = getRuntimeConfig();
  const publication = getRuntimeConfigSnapshotMetadata();
  return {
    cfg,
    assertCurrent: () => {
      if (getRuntimeConfigSnapshotMetadata() !== publication) {
        throw new Error("Node event configuration changed during preparation");
      }
    },
  };
}

export async function handleNodeSessionEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventConnectionOptions,
  source?: NodeEventSessionSource,
): Promise<NodeEventHandleResult | undefined> {
  switch (evt.event) {
    case "notifications.changed": {
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
        agentId,
        store,
        storeKeys,
      } = source?.loaded ??
      (await resolveGatewaySessionStoreTargetInWorker({
        cfg: config.cfg,
        key: target.sessionKey,
        agentId: target.agentId,
      }));
      config.assertCurrent();
      const entry = resolveCanonicalSessionEntryFromStoreKeys(store, storeKeys);
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
      config.assertCurrent();
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
            contextKey: `notification:${key}`,
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
              ctx.logGateway.warn(
                `notification event not delivered node=${nodeId}: ${outcome.status}`,
              );
            }
          });
        } catch (error) {
          consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
          throw error;
        }
      }
      return undefined;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      const config = captureNodeEventConfig();
      const { cfg } = config;
      const { canonicalKey: sessionKey, agentId } = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key: sessionKeyRaw,
      });
      config.assertCurrent();
      const runId = normalizeOptionalString(obj.runId) ?? "";
      const eventRouting = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
      const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, eventRouting);
      const assertAcceptanceCurrent = () => {
        config.assertCurrent();
        opts?.assertSessionEventCurrent?.();
      };
      const expectedTarget = await captureSessionEventTargetForHost(agentId, eventSessionKey, {
        assertCaptureCurrent: assertAcceptanceCurrent,
      });
      config.assertCurrent();
      if (!(await isNodeEventConnectionCurrent(opts))) {
        return pairingChangedResult(evt.event);
      }
      config.assertCurrent();
      assertAcceptanceCurrent();
      const authorization = ctx.authorizeNodeSystemRunEvent({
        nodeId,
        connId: opts?.connId,
        ...(runId ? { runId } : {}),
        // Match the invocation key; canonicalization above is only for routing.
        sessionKey: sessionKeyRaw,
        event: evt.event,
      });
      if (!authorization) {
        return {
          ok: true,
          event: evt.event,
          handled: false,
          reason: "unmatched_exec_event",
        };
      }
      if (
        cfg.tools?.exec?.notifyOnExit === false ||
        obj.suppressNotifyOnExit === true ||
        evt.event === "exec.denied"
      ) {
        return undefined;
      }
      const command = normalizeOptionalString(obj.command) ?? "";
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = normalizeOptionalString(obj.output) ?? "";

      let text;
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        const compactOutput = compactNodeEventText(output, MAX_EXEC_EVENT_OUTPUT_CHARS);
        const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
        if (!shouldNotify) {
          return undefined;
        }
        if (
          runId &&
          shouldDropDuplicateExecFinished({
            sessionKey,
            runId,
            now: Date.now(),
          })
        ) {
          return undefined;
        }
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (compactOutput) {
          text += `\n${compactOutput}`;
        }
      }

      const receipt = enqueueNodeExecNotice({
        agentId,
        sessionKey: eventSessionKey,
        authorization,
        runId,
        text,
        expectedTarget,
        assertAcceptanceCurrent,
      });
      if (receipt) {
        const accepted = await receipt.accepted;
        if (!accepted.ok) {
          throw new Error(accepted.error);
        }
        void receipt.settled.then((outcome) => {
          if (outcome.status !== "completed") {
            ctx.logGateway.warn(`exec event not delivered node=${nodeId}: ${outcome.status}`);
          }
        });
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
