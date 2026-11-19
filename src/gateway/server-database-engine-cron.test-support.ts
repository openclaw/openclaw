import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import pg from "pg";
import { expect } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawTestProcess } from "../../test/helpers/openclaw-test-process.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayClient } from "./client.js";

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

type ExitBoot = { outcome: string | null; startup_reason: string | null; reason: string | null };

export async function readGatewayExitBoots(connectionString: string, quotedNamespace: string) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
    return (
      await client.query<ExitBoot>(
        `SELECT outcome, startup_reason, reason FROM ${quotedNamespace}.gateway_boot_lifecycle ORDER BY started_at_ms DESC LIMIT 3`,
      )
    ).rows;
  } finally {
    await client.end();
  }
}

function classifyGatewayExitText(text: string) {
  const bounded = stripVTControlCharacters(text.slice(-64 * 1024));
  const markers = {
    fatalRejection: "[openclaw] FATAL unhandled rejection:",
    unhandledRejection: "[openclaw] Unhandled promise rejection:",
    configurationError: "[openclaw] CONFIGURATION ERROR - requires fix:",
    uncaughtException: "OpenClaw hit an unexpected runtime error.",
    commandFailed: "The CLI command failed.",
    startupFailed: "gateway startup failed:",
    lifecycleFailed: "gateway lifecycle completion failed:",
    shutdownFailed: "shutdown step failed (",
  };
  const categories = Object.entries(markers)
    .filter(([, marker]) => bounded.includes(marker))
    .map(([name]) => name);
  const lines = bounded.split(/\r?\n/u);
  const fatalMarkers = Object.values(markers).slice(0, 4);
  const fatal = lines.findLastIndex((line) => fatalMarkers.some((marker) => line.includes(marker)));
  const start =
    fatal >= 0
      ? fatal
      : lines.findLastIndex((line) =>
          Object.values(markers).some((marker) => line.includes(marker)),
        );
  const failure = start < 0 ? "" : lines.slice(start, start + 32).join("\n");
  // Emit identifiers and repository-relative stack sites, never arbitrary error text.
  return {
    categories,
    errorIdentifiers: [
      ...new Set(failure.match(/\b(?:[A-Z][A-Za-z0-9]{0,76}Error|ERR_[A-Z_]{1,76})\b/gu)),
    ].slice(0, 8),
    frames: [
      ...failure.matchAll(
        /(?:^|\n)\s*(?:\[openclaw\]\s*)?at [^\n]*?((?:src|packages|dist)\/(?:[A-Za-z0-9_-]{1,80}\/){0,5}[A-Za-z0-9_.-]{1,120}:\d{1,7}:\d{1,5})/gu,
      ),
    ]
      .map((match) => match[1])
      .slice(0, 8),
  };
}

export function createCronRestartDiagnostics(
  signal: AbortSignal,
  resources: AsyncDisposableStack,
  requests: () => number,
) {
  const started = performance.now();
  let phase = "setup";
  const elapsedMs = () => Math.round(performance.now() - started);
  const closed = createDeferred<{
    elapsedMs: number;
    code: number | null;
    signal: NodeJS.Signals | null;
    output: ReturnType<typeof classifyGatewayExitText>;
  }>();
  let socketClose: { elapsedMs: number; code: number } | undefined;
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
  return {
    trace,
    trackChild(child: OpenClawTestProcess, readLogs: () => string) {
      let exit:
        | { elapsedMs: number; code: number | null; signal: NodeJS.Signals | null }
        | undefined;
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exit = { elapsedMs: elapsedMs(), code, signal };
      };
      // The facade emits close only after both output streams have finished.
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        closed.resolve({
          ...(exit ?? { elapsedMs: elapsedMs(), code, signal }),
          output: classifyGatewayExitText(readLogs()),
        });
      };
      child.once("exit", onExit);
      child.once("close", onClose);
      resources.defer(() => {
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      });
    },
    onClose(code: number) {
      socketClose ??= { elapsedMs: elapsedMs(), code };
    },
    async observeRetry<T>(retry: Promise<T>, readBoots: () => Promise<ExitBoot[]>) {
      const result = await withinTest(
        Promise.race([
          retry.then((value) => ({ kind: "retry" as const, value })),
          closed.promise.then((exit) => ({ kind: "exit" as const, exit })),
        ]),
        signal,
      );
      if (result.kind === "retry") {
        return result.value;
      }
      const outcomes = new Set([
        "clean_stop",
        "planned_restart",
        "safe_mode_stable",
        "startup_failed",
        "startup_failure_repaired",
        "forced_stop",
      ]);
      const reasons = [
        "unhandled rejection",
        "uncaught exception",
        "fatal unhandled rejection",
        "configuration error",
        "gateway.stop_close_failed",
        "gateway.restart_close_failed",
      ];
      // This one bounded read follows exit and settles before fixture cleanup begins.
      const boots = await readBoots().then(
        (rows) => ({ available: true, rows }),
        () => ({ available: false, rows: [] as ExitBoot[] }),
      );
      console.info("cron-restart-terminal", {
        ...result.exit,
        socketClose,
        bootReadAvailable: boots.available,
        boots: boots.rows.map((boot) => ({
          outcome: boot.outcome === null || outcomes.has(boot.outcome) ? boot.outcome : "unknown",
          reasons: reasons.filter((reason) => boot.reason?.includes(reason)),
          startupReasonPresent: boot.startup_reason !== null,
        })),
      });
      throw new Error("Gateway exited before its automatic scheduled retry");
    },
  };
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
