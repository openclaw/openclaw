import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
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
import {
  captureNodeEventConfig,
  compactNodeEventText,
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  pruneBoundedTimestampMap,
} from "./server-node-event-source.js";
import { withNodeExecPathPrependWarning } from "./server-node-events-exec-path.js";
import type {
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
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

/** Consume the registry's captured caller and route, then transfer custody to the receipt. */
export async function handleNodeExecEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: "exec.started" | "exec.finished" | "exec.denied",
  payloadJSON: string | null | undefined,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> {
  const obj = parseNodeEventPayload(payloadJSON);
  if (!obj) {
    return undefined;
  }
  const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
  const config = captureNodeEventConfig();
  const { cfg } = config;
  const { canonicalKey: sessionKey, agentId } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: sessionKeyRaw,
  });
  const runId = normalizeOptionalString(obj.runId) ?? "";
  const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
  const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, policy);
  const assertAcceptanceCurrent = () => {
    config.assertCurrent();
    opts?.assertSessionEventCurrent?.();
  };
  assertAcceptanceCurrent();
  const auth = ctx.authorizeNodeSystemRunEvent({
    nodeId,
    connId: opts?.connId,
    ...(runId ? { runId } : {}),
    sessionKey: sessionKeyRaw,
    event,
  });
  if (!auth) {
    return {
      ok: true,
      event,
      handled: false,
      reason: "unmatched_exec_event",
    };
  }
  const authorization = typeof auth === "object" ? auth : undefined;
  const release = authorization?.release;
  if (
    cfg.tools?.exec?.notifyOnExit === false ||
    obj.suppressNotifyOnExit === true ||
    event === "exec.denied"
  ) {
    release?.();
    return undefined;
  }
  const command = normalizeOptionalString(obj.command) ?? "";
  const exitCode =
    typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode) ? obj.exitCode : undefined;
  const timedOut = obj.timedOut === true;
  const output = normalizeOptionalString(obj.output) ?? "";

  let text;
  if (event === "exec.started") {
    text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
    if (command) {
      text += `: ${command}`;
    }
  } else {
    const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
    const compactOutput = compactNodeEventText(output, MAX_EXEC_EVENT_OUTPUT_CHARS);
    const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
    if (!shouldNotify) {
      release?.();
      return undefined;
    }
    text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
    if (compactOutput) {
      text += `\n${compactOutput}`;
    }
    text = withNodeExecPathPrependWarning(text, cfg, agentId);
  }

  const notify = async () => {
    let releaseOnExit = release;
    try {
      const expectedTarget =
        authorization?.expectedTarget ??
        (await captureSessionEventTargetForHost(agentId, eventSessionKey, {
          assertCaptureCurrent: assertAcceptanceCurrent,
        }));
      expectedTarget.assertCurrent?.();
      if (!(await isNodeEventConnectionCurrent(opts))) {
        return pairingChangedResult(event);
      }
      assertAcceptanceCurrent();
      if (
        event === "exec.finished" &&
        runId &&
        shouldDropDuplicateExecFinished({ sessionKey, runId, now: Date.now() })
      ) {
        return undefined;
      }
      // Only the registry's captured route or session fallback may select the destination.
      const deliveryContext =
        authorization?.invocationDeliveryContext ?? expectedTarget.deliveryContext;
      const targetAgentId = expectedTarget.agentId ?? agentId;
      const targetSessionKey = expectedTarget.sessionKey ?? eventSessionKey;
      const eventOptions = withSystemEventOwner(
        {
          sessionKey: targetSessionKey,
          contextKey: runId ? `exec:${runId}` : "exec",
          deliveryContext,
        },
        targetAgentId,
      );
      const occurrence = enqueueSystemEventEntry(text, eventOptions);
      if (!occurrence) {
        return undefined;
      }
      let receipt;
      try {
        receipt = enqueueSessionEventForHost(text, {
          agentId: targetAgentId,
          // Queue keys include an owner prefix; the handoff retains the logical target.
          sessionKey: targetSessionKey,
          contextKey: eventOptions.contextKey,
          deliveryContext,
          source: "node",
          expectedTarget,
          occurrences: [occurrence],
          // The registry accepted this notice before the node connection could depart.
          assertAcceptanceCurrent: config.assertCurrent,
        });
      } catch (error) {
        consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
        throw error;
      }
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        throw new Error(accepted.error);
      }
      void receipt.settled
        .then((outcome) => {
          if (outcome.status !== "completed") {
            ctx.logGateway.warn(`exec event not delivered node=${nodeId}: ${outcome.status}`);
          }
        })
        .finally(release);
      releaseOnExit = undefined;
      return undefined;
    } finally {
      // Accepted receipts retain their own source; rejected and ignored notices end here.
      releaseOnExit?.();
    }
  };
  // A caller still waiting on this run gets its output inline; notify only if that fails.
  if (authorization?.holdNotice) {
    authorization.holdNotice(() => {
      void notify().catch((error: unknown) => {
        ctx.logGateway.warn(
          `exec event not delivered node=${nodeId}: ${formatErrorMessage(error)}`,
        );
      });
    });
  } else {
    return await notify();
  }
  return undefined;
}
