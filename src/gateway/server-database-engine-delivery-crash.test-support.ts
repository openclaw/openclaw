import fs from "node:fs/promises";
import type pg from "pg";
import { expect } from "vitest";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-namespaces.js";
import type { DurableDeliveryCompletion } from "../infra/outbound/delivery-queue-types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

type Anchor = { storeId: string; namespace: string };

export async function readPostgresAnchor(
  state: OpenClawTestState,
  pathname = resolveOpenClawStateSqlitePath(state.env),
): Promise<Anchor | undefined> {
  try {
    await fs.stat(pathname);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  using db = openNodeSqliteDatabase(pathname, { readOnly: true });
  const sqliteState = db.prepare(
    "SELECT name FROM sqlite_master WHERE name IN ('schema_meta', 'config_machine_state')",
  );
  expect(sqliteState.all()).toEqual([]);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'openclaw_engine_anchor'").get()) {
    return undefined;
  }
  const rows = db.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.engine).toBe("postgres");
  if (typeof row?.store_id !== "string" || typeof row.schema !== "string") {
    throw new Error("PostgreSQL bootstrap did not persist a complete anchor identity");
  }
  return { storeId: row.store_id, namespace: row.schema };
}

export function createDeliveryCrashReader(
  client: pg.Client,
  stateNamespace: string,
  agentNamespace: string,
  sessionKey: string,
  id: string,
) {
  const [state, agent] = [stateNamespace, agentNamespace].map(
    (namespace) => `"${namespace.replaceAll('"', '""')}"`,
  );
  return {
    readEntry: async (): Promise<InternalSessionEntry> => {
      const { rows } = await client.query<{ entry_json: string }>(
        `SELECT entry_json FROM ${agent}.session_nodes WHERE session_key = $1`,
        [sessionKey],
      );
      expect(rows).toHaveLength(1);
      return JSON.parse(rows[0]!.entry_json);
    },
    readQueue: async (entryId = id) => {
      return (
        await client.query<{ status: string; entry_json: string }>(
          `SELECT status, entry_json FROM ${state}.delivery_queue_entries WHERE queue_name = $1 AND id = $2`,
          [OUTBOUND_DELIVERY_QUEUE_NAME, entryId],
        )
      ).rows;
    },
    readNoticeTranscript: async (sessionId: string, noticeId: string) => {
      return (
        await client.query<{ event_json: string }>(
          `SELECT e.event_json FROM ${agent}.transcript_events e JOIN ${agent}.transcript_event_identities i USING (session_id, seq) WHERE i.session_id = $1 AND i.message_idempotency_key = $2`,
          [sessionId, noticeId],
        )
      ).rows;
    },
  };
}

export async function recoverNoticeAcknowledgementCrash({
  reader,
  instance,
  completion,
  noticeId,
  gatewayPrefix,
  serverUrl,
  recovered,
  signal,
  deliveries,
  target,
}: {
  reader: ReturnType<typeof createDeliveryCrashReader>;
  instance: OpenClawTestInstance;
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>;
  noticeId: string;
  gatewayPrefix: string[];
  serverUrl: string;
  recovered: Promise<{ id: string; pid: number }>;
  signal: AbortSignal;
  deliveries: Array<{ to: string; text: string }>;
  target: string;
}) {
  const { readEntry, readQueue, readNoticeTranscript } = reader;
  const firstChild = instance.child!;
  const notice = { to: target, text: expect.stringContaining("I couldn’t confirm") };
  expect(deliveries).toEqual([expect.objectContaining(notice)]);
  const completedNotice = await readQueue(noticeId);
  expect(completedNotice).toMatchObject([{ status: "completed" }]);
  expect(JSON.parse(completedNotice[0]!.entry_json)).toMatchObject({
    recoveryState: "completed_bounded",
  });
  const checkpoint = await readQueue();
  expect(checkpoint).toMatchObject([{ status: "failed" }]);
  expect(JSON.parse(checkpoint[0]!.entry_json)).toMatchObject({
    recoveryState: "settlement_pending",
    // Queue custody crosses JSON, which omits optional undefined fields.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    deliveryCompletion: JSON.parse(JSON.stringify(completion)),
  });
  const entry = await readEntry();
  expect(entry.pendingDeliveryNotice).toMatchObject({ state: "owed" });
  expect(await readNoticeTranscript(entry.sessionId, noticeId)).toEqual([]);
  await instance.crashGateway();
  expect(firstChild.signalCode).toBe("SIGKILL");
  expect(await readQueue()).toEqual(checkpoint);
  expect(await readQueue(noticeId)).toEqual(completedNotice);
  gatewayPrefix[2] = createDeliveryCrashPreload({
    window: "notice-ack-reply-lost",
    id: completion.deliveryId,
    serverUrl,
    observe: true,
  });
  await instance.startGateway();
  expect(await withinTest(recovered, signal)).toEqual({
    id: completion.deliveryId,
    pid: instance.child?.pid,
  });
  expect(instance.child?.pid).not.toBe(firstChild.pid);
  expect((await readEntry()).pendingDeliveryNotice).toMatchObject({ state: "acknowledged" });
  const transcript = await readNoticeTranscript(entry.sessionId, noticeId);
  expect(transcript).toHaveLength(1);
  expect(JSON.parse(transcript[0]!.event_json)).toMatchObject({
    message: { role: "assistant", content: [{ type: "text", text: deliveries[0]!.text }] },
  });
  expect(JSON.parse((await readQueue())[0]!.entry_json)).toMatchObject({
    recoveryState: "completed_permanent",
  });
  await instance.stopGateway();
  expect(deliveries).toEqual([expect.objectContaining(notice)]);
}

export function createDeliveryCrashPreload({
  window,
  id,
  noticeId,
  serverUrl,
  observe = false,
  offset = 0,
}: {
  window:
    | "receipt-before-ack"
    | "acceptance-before-receipt"
    | "response-lost"
    | "notice-ack-reply-lost";
  id: string;
  noticeId?: string;
  serverUrl: string;
  observe?: boolean;
  offset?: number;
}) {
  const identity = JSON.stringify(id);
  const receiptCommitted = window === "receipt-before-ack";
  let matches: string;
  if (observe) {
    matches = receiptCommitted
      ? `command?.type === "deliveryQueue.ack" && input?.id === ${identity}`
      : `command?.type === "deliveryQueue.finalizeFailure" &&
         JSON.parse(input.entry.entryJson).id === ${identity}`;
  } else if (window === "notice-ack-reply-lost") {
    matches = `command?.type === "deliveryQueue.ack" && input?.id === ${JSON.stringify(noticeId)}`;
  } else if (window === "acceptance-before-receipt") {
    matches = `command?.type === "session.actor.deliverySettled" &&
      input?.settlement?.deliveryId === ${identity} && input.settlement.state === "delivered"`;
  } else if (window === "response-lost") {
    matches = `command?.type === "deliveryQueue.mutateOutbound" &&
      input?.id === ${identity} && input.kind === "fail"`;
  } else {
    matches = `command?.type === "deliveryQueue.ack" && input?.id === ${identity}`;
  }
  // Hold receipt/ACK requests before execution, or the committed transport-failure reply.
  // Restart observes real terminal replies with one clock across Gateway threads.
  return `data:text/javascript,${encodeURIComponent(`
    import threads, { Worker, isMainThread } from "node:worker_threads";
    import { syncBuiltinESMExports } from "node:module";
    import { deserialize } from "node:v8";
    const now = Date.now.bind(Date);
    Date.now = () => now() + ${offset};
    threads.Worker = class extends Worker {
      constructor(url, options = {}) {
        super(url, { ...options, execArgv: [
          ...(options.execArgv ?? process.execArgv), "--import", import.meta.url,
        ] });
      }
    };
    syncBuiltinESMExports();
    if (isMainThread) {
      const post = Worker.prototype.postMessage;
      const emit = Worker.prototype.emit;
      let target;
      const report = () => fetch(${JSON.stringify(`${serverUrl}/${observe ? "recovered" : "held"}`)}, {
        method: "POST", body: JSON.stringify({ id: ${identity}, pid: process.pid })
      }).then((response) => { if (!response.ok) throw new Error("Boundary report failed"); });
      Worker.prototype.postMessage = function(request, ...rest) {
        if (request?.type === "execute") {
          const command = deserialize(request.input);
          const input = command?.input;
          if (${matches}) {
            ${
              observe || window === "response-lost" || window === "notice-ack-reply-lost"
                ? "target = { worker: this, requestId: request.id };"
                : "void report(); return;"
            }
          }
        }
        return Reflect.apply(post, this, [request, ...rest]);
      };
      Worker.prototype.emit = function(event, ...args) {
        const reply = args[0];
        if (target?.worker === this && event === "message" &&
            reply?.id === target.requestId && reply.ok === true
            ${observe && !receiptCommitted ? "&& reply.value instanceof Uint8Array && deserialize(reply.value) === true" : ""}) {
          target = undefined;
          void report();
          ${!observe && (window === "response-lost" || window === "notice-ack-reply-lost") ? "return true;" : ""}
        }
        return Reflect.apply(emit, this, [event, ...args]);
      };
    }
  `)}`;
}
