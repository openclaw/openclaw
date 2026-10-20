import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionControllerEntry } from "../sessions/session-controller.contracts.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.types.js";
import type { GatewayClient } from "./client.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

export const RECOVERY_PROBE_ID = "session-recovery-proof";
const METHOD = "sessionRecoveryProof.inspect";

// Serialized into the fixture plugin so it observes the child Gateway's actual
// owner, not an unrelated registry imported into the test process.
const inspectLiveRecovery: GatewayRequestHandler = ({ params, context, respond }) => {
  const { runId, sessionKey } = params as { runId: string; sessionKey: string };
  const state = Reflect.get(globalThis, Symbol.for("openclaw.sessionControllers")) as
    | {
        controllers: Map<string, SessionControllerEntry>;
        rpcSourcesByRunId: Map<string, Set<RpcSourceRef>>;
      }
    | undefined;
  const sources = [...(state?.rpcSourcesByRunId.get(runId) ?? [])];
  const mailboxes = [...(state?.controllers.values() ?? [])]
    .filter((entry) => entry.key === sessionKey || entry.aliases.has(sessionKey))
    .slice(0, 2)
    .map((entry) => {
      const mailbox = entry.mailbox;
      return {
        active: Boolean(entry.active),
        preparing: mailbox?.preparing === true,
        dispatchEnabled: mailbox?.dispatchEnabled === true,
        inputs: mailbox?.entries
          .filter((input) => input.protocolRunId === runId)
          .slice(0, 2)
          .map((input) => ({
            phase: input.phase,
            claimed: mailbox.claim?.inputs.includes(input) === true,
            enqueued: input.custody.enqueued === true,
            adopted: input.custody.adopted === true,
            completed: input.custody.completed === true,
            aborted: input.abortSignal.aborted,
          })),
      };
    });
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
  respond(true, {
    registryPresent: Boolean(state),
    sources: sources.slice(0, 2).map(({ input, adapter }) => ({
      phase: input.phase,
      started: adapter.timing?.startedAtMs !== undefined,
      terminalObserved: adapter.terminalOutcomeObserved === true,
      terminalPersisted: adapter.projectSessionTerminalPersisted === true,
    })),
    mailboxes,
    dedupe,
  });
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

export async function readRecoveryDiagnosticSnapshot(
  databasePath: string,
  sessionKey: string,
  runId: string,
  markers: Record<string, string>,
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
       const hash = (value) => typeof value === 'string'
         ? require('node:crypto').createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
       const rows = db.prepare(
         "SELECT seq, input_id, run_id, session_id, lifecycle_generation, message_json, accepted_at, state, consumed_event_id IS NOT NULL AS consumed FROM session_pending_inputs WHERE session_key = ? ORDER BY seq DESC LIMIT 20"
       ).all(workerData.sessionKey).map((row) => {
         const message = JSON.parse(row.message_json);
         const chat = message.__openclaw?.chatInputRecovery;
         const peer = message.__openclaw?.sessionSendDelivery;
         const source = chat?.source ?? peer?.target;
         return {
           seq: row.seq, id: row.input_id.slice(0, 8), run: row.run_id.slice(0, 8),
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
           // The owner does not persist its per-input startup selection. Current
           // row eligibility is not evidence that startup included or skipped it.
           startupReplay: 'not-recorded',
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
    { eval: true, workerData: { databasePath, sessionKey, runId, markers } },
  );
  try {
    const [snapshot] = await once(worker, "message", { signal: AbortSignal.timeout(2_000) });
    return snapshot as unknown;
  } finally {
    await worker.terminate();
  }
}

async function readLogTail(logPath: string): Promise<string> {
  const file = await fs.open(logPath, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 128_000));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function recoveryLogTail(logs: string): string[] {
  // Do not emit raw log lines: even a recovery error may contain request text,
  // paths, or credentials. Preserve only fixed event labels and numeric timings.
  return logs
    .split("\n")
    .flatMap((line) => {
      try {
        const record = asOptionalRecord(JSON.parse(line));
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
    })
    .flatMap((line) => {
      const event = line.match(
        /Pending input replay:|Chat input recovery blocked:|Session delivery recovery (?:retry|blocked|failed)|main-session restart recovery (?:candidate|startup complete:)|chat pending input aborted:|\[admission\] closed:|slow chat send|startup (?:phase|trace): (?:sessions\.admission|sidecars\.[a-z.-]*recovery)|mailbox/iu,
      )?.[0];
      if (!event) {
        return [];
      }
      const time = line.match(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+/u)?.[0] ?? "";
      const facts = line.match(
        /"(?:kind|outcome|waitReason|decision|reason|nextOwner)":"(?:peer|chat|accepted|stale|cancelled|blocked|aborted|none|endpoint-replaced|requester-unavailable|permission-denied|transient-admission|store-unavailable|unknown|started|settled|deferred|stopped|not_main_session|archived|work_start_blocked|work_start_pending|dispatch_target_unavailable|live_owner|already_handled|state_changed|inactive|tombstoned|exhausted|message_action_authority_unavailable|observation_only|pending_delivery|invalid_harness_completion|delegated_authority_unavailable|dispatch_skipped|terminal-residue|terminal-evidence|pending_delivery_notice|operator|session-preparation|outbound-delivery|session-owner|next-startup|main-session-recovery)"|"(?:runId|inputId|sourceRunId|recoveryRunId)":"[a-f0-9-]{36}"|"(?:attempts|[a-zA-Z]+Ms)":\d+(?:\.\d+)?|\b(?:stage=(?:request|startup|steer|queued)|[a-zA-Z.]+=\d+(?:\.\d+)?ms|(?:started|settled|failed|skipped)=\d+|\d+(?:\.\d+)?ms)\b|\b(?:restart|rpc|cancelled|interrupted|stop|SIGTERM|SIGKILL)\b/gu,
      );
      return [`${time} ${event} ${(facts ?? []).join(" ")}`.trim().slice(0, 500)];
    })
    .slice(-40);
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
  markers: Record<string, string>;
}): Promise<void> {
  const { client, databasePath, sessionKey, runId, frames } = params;
  const reads = runId
    ? await Promise.allSettled([
        readRecoveryDiagnosticSnapshot(databasePath, sessionKey, runId, params.markers),
        client?.request(METHOD, { sessionKey, runId }, { timeoutMs: 2_000 }),
      ])
    : [];
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
  console.error(
    `[session-recovery-child-log] ${JSON.stringify({ console: recoveryLogTail(params.restartedLogs), file: recoveryLogTail(fileLog) })}`,
  );
}
