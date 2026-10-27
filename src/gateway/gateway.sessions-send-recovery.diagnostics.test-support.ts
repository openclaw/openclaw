import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClient } from "./client.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

export const RECOVERY_PROBE_ID = "session-recovery-proof";
const METHOD = "sessionRecoveryProof.inspect";

const RECOVERY_DIAGNOSTIC_MARKERS = [
  "HOLD_PARALLEL_0",
  "HOLD_PARALLEL_1",
  "HOLD_PARALLEL_2",
  "PARALLEL_INPUT_0_1",
  "PARALLEL_INPUT_0_2",
  "PARALLEL_INPUT_1_1",
  "PARALLEL_INPUT_1_2",
  "PARALLEL_INPUT_2_1",
  "PARALLEL_INPUT_2_2",
  "SEND_STEER_UPDATE",
  "SEND_PEER_UPDATE_1",
  "SEND_PEER_UPDATE_2",
  "SEND_PEER_UPDATE_3",
  "SEND_PEER_UPDATE_4",
  "SEND_PEER_UPDATE_5",
  "SEND_CANCELLED_UPDATE",
  "SEND_RESET_SOURCE_UPDATE",
  "SEND_REVOKED_UPDATE",
  "SEND_ARCHIVED_SOURCE_UPDATE",
  "HOLD_STEER",
  "HOLD_TARGET",
  "PEER_UPDATE_1",
  "PEER_UPDATE_2",
  "PEER_UPDATE_3",
  "PEER_UPDATE_4",
  "PEER_UPDATE_5",
  "CHAT_UPDATE_1",
  "CHAT_UPDATE_2",
  "CHAT_UPDATE_3",
  "CHAT_UPDATE_4",
  "CHAT_UPDATE_5",
  "CANCELLED_CHAT",
  "CANCELLED_UPDATE",
  "RESET_SOURCE_UPDATE",
  "REVOKED_UPDATE",
  "ARCHIVED_SOURCE_UPDATE",
  "none",
] as const;

export type RecoveryDiagnosticMarker = (typeof RECOVERY_DIAGNOSTIC_MARKERS)[number];

export function normalizeRecoveryDiagnosticMarker(value: unknown): RecoveryDiagnosticMarker {
  return RECOVERY_DIAGNOSTIC_MARKERS.find((marker) => marker === value) ?? "none";
}

function sanitizeRecoveryDiagnosticMarkers(
  markers: Readonly<Record<string, RecoveryDiagnosticMarker>>,
): Record<string, RecoveryDiagnosticMarker> {
  return Object.fromEntries(
    Object.entries(markers).map(([runId, marker]) => [
      runId,
      normalizeRecoveryDiagnosticMarker(marker),
    ]),
  );
}

// Observe the child's RPC outcome cache without coupling diagnostics to private controller state.
const inspectLiveRecovery: GatewayRequestHandler = ({ params, context, respond }) => {
  const { runId } = params as { runId: string };
  const dedupe = ["pending-chat:", "chat:", "agent:"].map((prefix) => {
    const entry = context.dedupe.get(prefix + runId);
    const payload = entry?.payload as { status?: string; stopReason?: string } | undefined;
    return {
      prefix,
      present: Boolean(entry),
      ts: entry?.ts,
      ok: entry?.ok,
      effectAccepted: entry?.effectAccepted,
      hasRequestIdentity: Boolean(entry?.requestIdentity),
      status: payload?.status?.match(/^(?:accepted|ok|error|aborted|pending)$/u)?.[0],
      stopped: Boolean(payload?.stopReason),
    };
  });
  respond(true, { dedupe });
};

export async function writeRecoveryDiagnosticProbe(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: RECOVERY_PROBE_ID,
      type: "commonjs",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: RECOVERY_PROBE_ID,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(directory, "index.js"),
    `module.exports = { id: ${JSON.stringify(RECOVERY_PROBE_ID)}, register(api) {
      api.registerGatewayMethod(${JSON.stringify(METHOD)}, ${inspectLiveRecovery.toString()}, { scope: "operator.read" });
    } };`,
  );
}

async function readRecoveryDiagnosticSnapshot(
  databasePath: string,
  sessionKey: string,
  runId: string,
  markers: Readonly<Record<string, RecoveryDiagnosticMarker>>,
) {
  // A separate read-only SQLite connection takes one snapshot, without history
  // reconciliation, schema preparation, or touching the Gateway's writer custody.
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
     try {
       db.exec("BEGIN");
       const node = db.prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?").get(workerData.sessionKey);
       const entry = JSON.parse(node?.entry_json ?? '{}');
       const hash = (value, length = 12) => typeof value === 'string'
         ? require('node:crypto').createHash('sha256').update(value).digest('hex').slice(0, length) : null;
       const rows = db.prepare(
         "SELECT seq, input_id, run_id, session_id, lifecycle_generation, message_json, accepted_at, state, consumed_event_id IS NOT NULL AS consumed FROM session_pending_inputs WHERE session_key = ? ORDER BY seq DESC LIMIT 20"
       ).all(workerData.sessionKey).map((row) => {
         const message = JSON.parse(row.message_json);
         const chat = message.__openclaw?.chatInputRecovery;
         const peer = message.__openclaw?.sessionSendDelivery;
         const source = chat?.source ?? peer?.target;
         return {
           seq: row.seq, id: row.input_id.slice(0, 8), run: row.run_id.slice(0, 8),
           inputHash: hash(row.input_id, 16),
           state: row.state, consumed: row.consumed, final: row.run_id === workerData.runId,
           marker: workerData.markers[row.run_id] ?? null,
           replayMetadata: { chat: Boolean(chat), peer: Boolean(peer), request: Boolean(chat?.request),
             version: chat?.version === 1 || peer?.version === 1 },
           source: source ? {
             kind: chat ? 'chat' : 'peer',
             sessionMatches: source.sessionId === row.session_id,
             runMatches: (chat ? source.sourceRunId : peer.runId) === row.run_id,
             operatorSnapshot: Boolean(chat ? source.snapshot : peer.operatorSource),
           } : null,
           fence: {
             pending: hash(row.lifecycle_generation), source: hash(source?.lifecycleRevision),
             current: hash(entry.lifecycleRevision),
             currentSession: node?.current_session_id === row.session_id,
           },
           ageMs: Math.max(0, Date.now() - row.accepted_at),
           // Selection is observed from owner logs below, not reconstructed from
           // current row eligibility. No replay plan is persisted in this row.
           startupReplay: 'not-persisted',
         };
       });
       const count = db.prepare("SELECT count(*) AS total FROM session_pending_inputs WHERE session_key = ?").get(workerData.sessionKey);
       const hasCompletions = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_input_completions'").get();
       const completion = hasCompletions ? db.prepare(
         "SELECT succeeded, completed_at AS at, json_extract(outcome_json,'$.kind') AS kind FROM session_input_completions WHERE session_key = ? AND idempotency_key = ?"
       ).get(workerData.sessionKey, workerData.runId + ':user') : null;
       const idempotency = db.prepare(
         "SELECT i.seq, substr(i.event_id,1,8) AS id, i.event_type AS type FROM transcript_event_identities i JOIN session_windows w ON w.session_id = i.session_id WHERE w.session_key = ? AND i.message_idempotency_key = ? LIMIT 2"
       ).all(workerData.sessionKey, workerData.runId + ':user');
       parentPort.postMessage({ rows: rows.reverse(), ...count, idempotency, completion: completion ?? null,
         recovery: {
           sourceRun: entry.restartRecoveryDeliverySourceRunId?.slice(0, 8) ?? null,
           run: entry.restartRecoveryDeliveryRunId?.slice(0, 8) ?? null,
           lifecycleRun: entry.lifecycleRunId?.slice(0, 8) ?? null,
           operatorSource: Boolean(entry.restartRecoveryOperatorSource),
           requesterSource: Boolean(entry.restartRecoveryRequesterSource),
         },
       });
     } finally { db.close(); }`,
    {
      eval: true,
      workerData: {
        databasePath,
        sessionKey,
        runId,
        markers: sanitizeRecoveryDiagnosticMarkers(markers),
      },
    },
  );
  try {
    const [snapshot] = await once(worker, "message", { signal: AbortSignal.timeout(2_000) });
    return snapshot as unknown;
  } finally {
    await worker.terminate();
  }
}

const RECOVERY_LOG_BYTES = 2_000_000;

async function readLogTail(logPath: string): Promise<string> {
  const file = await fs.open(logPath, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, RECOVERY_LOG_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function recoveryLogMessages(logs: string, sinceMs?: number): string[] {
  return logs.split("\n").flatMap((line) => {
    try {
      const record = asOptionalRecord(JSON.parse(line));
      if (sinceMs !== undefined) {
        const timestamp = typeof record?.time === "string" ? Date.parse(record.time) : Number.NaN;
        if (!Number.isFinite(timestamp) || timestamp < sinceMs) {
          return [];
        }
      }
      // The file logger's display message includes structured metadata. Prefer
      // it over duplicate argument fields, retaining run IDs on abort records.
      return typeof record?.message === "string"
        ? [record.message]
        : record
          ? Object.values(record).filter((value) => typeof value === "string")
          : [];
    } catch {
      return [line];
    }
  });
}

const CHAT_INPUT_RECOVERY_REFUSAL_LABELS = new Map([
  [
    "accepted chat turn recovery ownership changed; automatic retry stopped to avoid duplicate execution | UNAVAILABLE",
    "accepted-recovery-ownership-changed",
  ],
  [
    "Chat admission ended or was cancelled; submit a new turn. | UNAVAILABLE",
    "chat-admission-ended",
  ],
  [
    "Chat input was not durably admitted; refresh and retry. | UNAVAILABLE",
    "input-not-durably-admitted",
  ],
]);

function projectChatInputRecoveryBlocked(line: string) {
  const match = line.match(
    /Chat input recovery blocked: (.+) (\{"sessionKeyHash":"[a-f0-9]{16}","inputId":"[a-f0-9-]{36}","ageMs":\d+\})$/u,
  );
  if (!match) {
    return undefined;
  }
  return {
    facts: match[2]!,
    refusal: CHAT_INPUT_RECOVERY_REFUSAL_LABELS.get(match[1]!),
  };
}

function recoveryLogTail(logs: string, sinceMs?: number): string[] {
  // Do not emit raw log lines: even a recovery error may contain request text,
  // paths, or credentials. Preserve only fixed event labels and numeric timings.
  return recoveryLogMessages(logs, sinceMs)
    .flatMap((line) => {
      const event = line.match(
        /Pending input replay:|Chat input recovery blocked:|Session delivery recovery (?:retry|blocked|failed)|main-session restart recovery (?:candidate|startup complete:)|chat pending input aborted:|session lifecycle queue waiting|\[admission\] closed:|slow chat send|^gateway ready$|startup (?:phase|trace): (?:sessions\.admission|sidecars\.(?:[a-z.-]*recovery|delivery-notices)|ready)|mailbox/iu,
      )?.[0];
      if (!event) {
        return [];
      }
      const blocked =
        event === "Chat input recovery blocked:"
          ? projectChatInputRecoveryBlocked(line)
          : undefined;
      const timeSource =
        event === "Chat input recovery blocked:" ? line.slice(0, line.indexOf(event)) : line;
      const time = timeSource.match(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+/u)?.[0] ?? "";
      const facts = (event === "Chat input recovery blocked:" ? blocked?.facts : line)?.match(
        /"(?:kind|outcome|waitReason|decision|reason|nextOwner)":"(?:peer|chat|accepted|stale|cancelled|blocked|aborted|none|endpoint-replaced|requester-unavailable|permission-denied|transient-admission|store-unavailable|unknown|started|settled|deferred|stopped|not_main_session|archived|work_start_blocked|work_start_pending|dispatch_target_unavailable|live_owner|already_handled|state_changed|inactive|tombstoned|exhausted|message_action_authority_unavailable|observation_only|pending_delivery|invalid_harness_completion|delegated_authority_unavailable|dispatch_skipped|terminal-residue|terminal-evidence|pending_delivery_notice|operator|session-preparation|outbound-delivery|session-owner|next-startup|main-session-recovery)"|"(?:runId|inputId|sourceRunId|recoveryRunId)":"[a-f0-9-]{36}"|"(?:attempts|[a-zA-Z]+Ms)":\d+(?:\.\d+)?|\b(?:stage=(?:request|startup|steer|queued)|[a-zA-Z.]+=\d+(?:\.\d+)?ms|(?:started|settled|failed|skipped)=\d+|\d+(?:\.\d+)?ms)\b|\b(?:restart|rpc|cancelled|interrupted|stop|SIGTERM|SIGKILL)\b/gu,
      );
      const projected = [
        ...(blocked?.refusal ? [`"refusal":"${blocked.refusal}"`] : []),
        ...(facts ?? []),
      ];
      return [`${time} ${event} ${projected.join(" ")}`.trim().slice(0, 500)];
    })
    .slice(-40);
}

export async function readRecoveryLogProjection(params: {
  logPath: string;
  sinceMs: number;
}): Promise<{ atLimit: boolean; events: string[] }> {
  const fileLog = await readLogTail(params.logPath);
  return {
    atLimit: Buffer.byteLength(fileLog) >= RECOVERY_LOG_BYTES,
    events: recoveryLogTail(fileLog, params.sinceMs),
  };
}

export async function printRecoveryFailureDiagnostics(params: {
  client: GatewayClient | undefined;
  databasePath: string;
  sessionKey: string;
  runId: string | undefined;
  frames: unknown[];
  restartedLogs: string;
  startupSnapshot: unknown;
  logPath: string;
  markers: Readonly<Record<string, RecoveryDiagnosticMarker>>;
  restartEpoch?: 0 | 1 | 2;
  restartStartedAtMs?: number;
}): Promise<void> {
  const { client, databasePath, sessionKey, runId, frames } = params;
  const reads = runId
    ? await Promise.allSettled([
        readRecoveryDiagnosticSnapshot(databasePath, sessionKey, runId, params.markers),
        client?.request(METHOD, { sessionKey, runId }, { timeoutMs: 2_000 }),
      ])
    : [];
  // Replay decisions can precede the final tail by many unrelated debug logs.
  // Read a bounded larger window only on failure; print projected facts below.
  const fileLog = await readLogTail(params.logPath).catch(() => "");
  const result = (index: number) => {
    const read = reads[index];
    return read?.status === "fulfilled" && read.value !== undefined
      ? read.value
      : { unavailable: true };
  };
  // Projected metadata only; never stringify transcript, credentials, errors, or
  // request fingerprints. The final cap also bounds unexpected future growth.
  const durable = result(0) as { rows?: unknown[] };
  const startup = (params.startupSnapshot ?? { unavailable: true }) as { rows?: unknown[] };
  const { rows, ...summary } = durable;
  const { rows: startupRows, ...startupSummary } = startup;
  const diagnostic = JSON.stringify({
    replayLogAtLimit: Buffer.byteLength(fileLog) >= RECOVERY_LOG_BYTES,
    restartEpoch: params.restartEpoch ?? null,
    runId,
    frames,
    durable: summary,
    startup: startupSummary,
    live: result(1),
  });
  console.error(
    `[session-recovery-failure] ${Buffer.from(diagnostic).subarray(0, 5_500).toString()}`,
  );
  for (const row of rows ?? []) {
    console.error(`[session-recovery-row] ${JSON.stringify({ phase: "failure", row })}`);
  }
  for (const row of startupRows ?? []) {
    console.error(`[session-recovery-row] ${JSON.stringify({ phase: "before-startup", row })}`);
  }
  const consoleLog =
    params.restartStartedAtMs === undefined ? recoveryLogTail(params.restartedLogs) : [];
  console.error(
    `[session-recovery-child-log] ${JSON.stringify({ console: consoleLog, file: recoveryLogTail(fileLog, params.restartStartedAtMs) })}`,
  );
}
