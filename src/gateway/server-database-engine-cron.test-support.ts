import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { expect } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "./client.js";

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
