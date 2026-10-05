import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../infra/node-commands.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import {
  NODE_INVOKE_PROGRESS_DIAGNOSTIC_EVENT,
  NODE_INVOKE_PROGRESS_DIAGNOSTIC_INTERVAL_MS,
  type NodeInvokeProgressDiagnostic,
  type NodeInvokeProgressDisposition,
} from "../shared/node-invoke-progress-diagnostic.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke-types.js";
import { buildNodeEventParams } from "./node-event-params.js";

const PROGRESS_CHUNK_BYTES = 16 * 1024;
const MIN_HEARTBEAT_INTERVAL_MS = 250;
const MAX_HEARTBEAT_INTERVAL_MS = 5_000;
const progressLog = createSubsystemLogger("node-host/progress");

function resolveNodeInvokeHeartbeatInterval(idleTimeoutMs: number): number {
  return Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(idleTimeoutMs / 2)),
  );
}

export function createNodeInvokeProgressWriter(params: {
  client: NodeHostClient;
  frame: NodeInvokeRequestPayload;
  idleTimeoutMs: number;
  onError: (error: Error) => void;
}) {
  let seq = 0;
  let queue = Promise.resolve();
  let progressError: Error | undefined;
  let heartbeatQueued = false;
  let heartbeatDirty = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let recurringHeartbeats = false;
  let stopped = false;
  let lastProgressAt = 0;
  const heartbeatIntervalMs = resolveNodeInvokeHeartbeatInterval(params.idleTimeoutMs);
  let pendingSeq: number | null = null;
  let lastSentSeq: number | null = null;
  let lastCompletedSeq: number | null = null;
  let progressRequestId: string | null = null;
  let sourceWrites = 0;
  let lastSourceAtMs: number | null = null;
  let lastSentAtMs: number | null = null;
  let lastCompletedAtMs: number | null = null;
  let lastSampleAtMs: number | undefined;
  let disposition: NodeInvokeProgressDisposition = "active";
  let settlementObserved = false;
  let sendingDiagnostic = false;
  let queuedDiagnostic: NodeInvokeProgressDiagnostic | undefined;
  const publishDiagnostic = () => {
    if (sendingDiagnostic || !queuedDiagnostic) {
      return;
    }
    const snapshot = queuedDiagnostic;
    queuedDiagnostic = undefined;
    sendingDiagnostic = true;
    // Coalesce outside the ordered progress queue; observation cannot stall its delivery.
    void Promise.resolve()
      .then(() =>
        params.client.request(
          "node.event",
          buildNodeEventParams(NODE_INVOKE_PROGRESS_DIAGNOSTIC_EVENT, snapshot),
        ),
      )
      .catch(() => {})
      .finally(() => {
        sendingDiagnostic = false;
        publishDiagnostic();
      });
  };
  const observe = (stage: NodeInvokeProgressDiagnostic["stage"]) => {
    const now = Date.now();
    if (
      stage === "sample" &&
      lastSampleAtMs !== undefined &&
      now - lastSampleAtMs < NODE_INVOKE_PROGRESS_DIAGNOSTIC_INTERVAL_MS
    ) {
      return;
    }
    if (stage === "sample") {
      lastSampleAtMs = now;
    }
    const snapshot: NodeInvokeProgressDiagnostic = {
      invokeId: params.frame.id,
      stage,
      category:
        params.frame.command === NODE_DESKTOP_STREAM_COMMAND
          ? "desktop_stream"
          : params.frame.command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND
            ? "agent_cli"
            : "registered_command",
      disposition,
      atMs: now,
      nextSeq: seq,
      lastSentSeq,
      lastCompletedSeq,
      pendingSeq,
      progressRequestId,
      sourceWrites,
      lastSourceAtMs,
      lastSentAtMs,
      lastCompletedAtMs,
      requestFailed: progressError !== undefined,
    };
    try {
      progressLog.info("node invoke progress state", { nodeId: params.frame.nodeId, ...snapshot });
    } catch {
      // The invocation owns delivery even when its local diagnostic sink fails.
    }
    queuedDiagnostic = snapshot;
    publishDiagnostic();
  };

  const recordError = (error: unknown) => {
    const firstFailure = progressError === undefined;
    progressError = error instanceof Error ? error : new Error(String(error));
    if (firstFailure) {
      observe("request_failed");
    }
    params.onError(progressError);
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(recordError);
    return queue;
  };

  const sendChunk = async (chunk: string) => {
    const sendingSeq = seq;
    let sent = false;
    pendingSeq = sendingSeq;
    try {
      await params.client.request(
        "node.invoke.progress",
        {
          invokeId: params.frame.id,
          nodeId: params.frame.nodeId,
          seq,
          chunk,
        },
        {
          onSent: (requestId) => {
            sent = true;
            lastSentSeq = sendingSeq;
            progressRequestId = requestId;
            lastSentAtMs = Date.now();
          },
        },
      );
      if (sent) {
        lastCompletedSeq = sendingSeq;
        lastCompletedAtMs = Date.now();
      }
      seq += 1;
    } finally {
      pendingSeq = null;
    }
  };

  const sendText = async (text: string) => {
    let remaining = text;
    while (remaining) {
      const chunk = truncateUtf8Prefix(remaining, PROGRESS_CHUNK_BYTES);
      if (!chunk) {
        break;
      }
      await sendChunk(chunk);
      remaining = remaining.slice(chunk.length);
    }
  };

  const queueHeartbeat = () => {
    if (stopped) {
      return;
    }
    if (heartbeatQueued) {
      heartbeatDirty = true;
      return;
    }
    heartbeatQueued = true;
    const delayMs = Math.max(0, heartbeatIntervalMs - (Date.now() - lastProgressAt));
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      observe("sample");
      void enqueue(async () => {
        await sendChunk("");
        lastProgressAt = Date.now();
      }).finally(() => {
        heartbeatQueued = false;
        if ((heartbeatDirty || recurringHeartbeats) && !stopped) {
          heartbeatDirty = false;
          queueHeartbeat();
        }
      });
    }, delayMs);
  };

  return {
    write(text: string): Promise<void> {
      if (!text || stopped) {
        return queue;
      }
      lastProgressAt = Date.now();
      sourceWrites += 1;
      lastSourceAtMs = lastProgressAt;
      observe("sample");
      return enqueue(() => sendText(text));
    },
    queueHeartbeat,
    startHeartbeats(): void {
      recurringHeartbeats = true;
      queueHeartbeat();
    },
    stopHeartbeats(): void {
      recurringHeartbeats = false;
      heartbeatDirty = false;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      heartbeatQueued = false;
    },
    async flush(): Promise<void> {
      await queue.catch(() => {});
      if (stopped && !settlementObserved) {
        settlementObserved = true;
        observe("settled");
      }
    },
    stop(reason: Exclude<NodeInvokeProgressDisposition, "active"> = "stopped"): void {
      const firstStop = !stopped;
      stopped = true;
      disposition = reason;
      recurringHeartbeats = false;
      heartbeatDirty = false;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      if (firstStop) {
        observe("stopped");
      }
    },
    get error(): Error | undefined {
      return progressError;
    },
  };
}
