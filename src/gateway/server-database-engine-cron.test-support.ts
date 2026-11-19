import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import pg from "pg";
import { expect } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayClient } from "./client.js";

type CronRetrySnapshot = {
  enabled: boolean;
  state: CronJob["state"];
  receipts: Array<{ status: string; started_at_ms: number }>;
};

export async function expectStoredCronOneShotComplete(
  client: pg.Client,
  quotedNamespace: string,
  jobId: string,
) {
  const result = await client.query<{ enabled: number; state_json: string }>(
    `SELECT CAST(enabled AS integer) AS enabled, state_json FROM ${quotedNamespace}.cron_jobs WHERE job_id = $1`,
    [jobId],
  );
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.enabled).toBe(0);
  const state = JSON.parse(result.rows[0]!.state_json) as CronJob["state"];
  expect(state.startupCatchupAtMs).toBeUndefined();
  expect(state.runningReceiptId).toBeUndefined();
  expect(state.queuedAtMs).toBeUndefined();
}

export async function readCronRetrySnapshot(
  connectionString: string,
  quotedNamespace: string,
  jobId: string,
): Promise<CronRetrySnapshot> {
  // Keep diagnostic reads bounded independently of the suite's normal observer.
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
    const result = await client.query<{
      enabled: number;
      state_json: string;
      receipts_json: string;
    }>(
      `SELECT CAST(enabled AS integer) AS enabled, state_json,
        (SELECT COALESCE(json_agg(json_build_object('status', receipt.status,
          'started_at_ms', CAST(receipt.started_at_ms AS double precision))
          ORDER BY receipt.started_at_ms, receipt.receipt_id), '[]'::json)::text
         FROM (SELECT receipt_id, status, started_at_ms FROM ${quotedNamespace}.cron_run_receipts
           WHERE job_id = $1 ORDER BY started_at_ms, receipt_id LIMIT 3) receipt) AS receipts_json
       FROM ${quotedNamespace}.cron_jobs WHERE job_id = $1`,
      [jobId],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    return {
      enabled: row.enabled !== 0,
      state: JSON.parse(row.state_json) as CronJob["state"],
      receipts: JSON.parse(row.receipts_json) as CronRetrySnapshot["receipts"],
    };
  } finally {
    await client.end();
  }
}

export async function observeCronRetryDeadline<T>(
  retry: Promise<T>,
  signal: AbortSignal,
  dueAtMs: number,
  readSnapshot: () => Promise<CronRetrySnapshot>,
) {
  const observation = new AbortController();
  let reading: Promise<unknown> | undefined;
  // One read after the durable due time separates an unclaimed retry from a blocked launch.
  const snapshot = delay(Math.max(0, dueAtMs + 5_000 - Date.now()), undefined, {
    signal: observation.signal,
  }).then(async () => {
    signal.throwIfAborted();
    const pending = readSnapshot();
    reading = pending;
    const { enabled, state, receipts } = await pending;
    const remaining = (time: number | undefined) =>
      time === undefined ? null : Math.round(time - Date.now());
    console.info("cron-retry-deadline-snapshot", {
      enabled,
      nextRunDelayMs: remaining(state.nextRunAtMs),
      startupCatchupDelayMs: remaining(state.startupCatchupAtMs),
      queued: state.queuedAtMs !== undefined,
      running: state.runningAtMs !== undefined,
      runningReceipt: state.runningReceiptId !== undefined,
      admissionRetryDelayMs: remaining(state.admissionDeferred?.retryAtMs),
      receipts: receipts.map(({ status, started_at_ms }) => ({ status, started_at_ms })),
    });
    return await retry;
  });
  try {
    return await withinTest(Promise.race([retry, snapshot]), signal);
  } finally {
    observation.abort();
    await reading;
  }
}

export function createCronRestartDiagnostics(
  signal: AbortSignal,
  resources: AsyncDisposableStack,
  requests: () => number,
) {
  const started = performance.now();
  let phase = "setup";
  const elapsedMs = () => Math.round(performance.now() - started);
  const trace = (next: string) => {
    phase = next;
    console.info("cron-restart-diagnostic", {
      phase,
      elapsedMs: elapsedMs(),
      requests: requests(),
    });
  };
  const onAbort = () => trace(`aborted-during-${phase}`);
  signal.addEventListener("abort", onAbort, { once: true });
  resources.defer(() => signal.removeEventListener("abort", onAbort));
  return { trace, elapsedMs };
}

/** Only complete startup records can prove cumulative pool reuse across Gateway boots. */
function readPostgresBridgeStartupHistory(logs: string) {
  return [
    ...stripVTControlCharacters(logs).matchAll(/worker startup state: (\{[^\r\n]*\})\r?\n/gu),
  ].map((match) => {
    const snapshot: {
      workerLifecycle: Array<{
        script: string;
        started: number;
        retired: Array<{ reason: string; count: number }>;
      }>;
    } = JSON.parse(match[1]!);
    return snapshot.workerLifecycle.filter(({ script }) => script === "bridge.worker.js");
  });
}

export async function observePostgresPoolReuse(gateway: GatewayClient, readLogs: () => string) {
  const readBridgeStarts = () => readPostgresBridgeStartupHistory(readLogs());
  const census = { postgresBridgeCount: 4, postgresPoolSelfRootCount: 0 };
  const bridge = [{ script: "bridge.worker.js", started: 4, retired: [] }];
  await expect(gateway.request("diagnostics.lanes", {})).resolves.toMatchObject(census);
  await expect.poll(readBridgeStarts).toEqual([bridge]);
  return {
    expectBeforeRestart() {
      expect(readBridgeStarts()).toEqual([bridge]);
    },
    async expectAfterRestart(restarted: GatewayClient) {
      // Live count alone would also pass if all four services had been replaced.
      await expect.poll(readBridgeStarts).toEqual([bridge, bridge]);
      await expect(restarted.request("diagnostics.lanes", {})).resolves.toMatchObject(census);
    },
  };
}

export async function startHeldCronRetryProvider(resources: AsyncDisposableStack, summary: string) {
  const accepted = createDeferred();
  const aborted = createDeferred();
  const retryResponse = createDeferred<() => void>();
  const requests: string[] = [];
  const providerServer = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      requests.push(await readRequestText(request));
      const complete = () =>
        writeOpenAiResponsesText(response, {
          text: summary,
          messageId: "scheduled-retry-message",
          responseId: "scheduled-retry-response",
        });
      if (requests.length === 1) {
        response.once("close", () => {
          if (!response.writableEnded) {
            aborted.resolve();
          }
        });
        accepted.resolve();
      } else if (requests.length === 2) {
        // Hold retry completion until the replacement client's event observer is ready.
        retryResponse.resolve(complete);
      } else {
        complete();
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  const providerUrl = await listenLoopback(providerServer);
  resources.defer(() => closeHttpServer(providerServer));
  return { providerUrl, requests, accepted, aborted, retryResponse };
}
