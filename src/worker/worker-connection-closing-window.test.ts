import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import { withinTest } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";

describe("worker connection close during durable RPC", () => {
  it("lets the close event run before replaying a Gateway tool call", async ({ signal }) => {
    const workerUrl = new URL("./repro-worker-connection-closing-window.ts", import.meta.url);
    const worker = new Worker(workerUrl, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed: string[] = [];
    let closingReadyState: number | undefined;
    try {
      const outcome = new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.on("error", reject);
        worker.once("exit", (code) => {
          reject(new Error(`worker exited before completing the connection race: ${code}`));
        });
        worker.on("message", (message: Record<string, unknown>) => {
          observed.push(String(message.type));
          if (message.type === "closing-window" && typeof message.readyState === "number") {
            closingReadyState = message.readyState;
          }
          if (message.type === "ready") {
            timeout = setTimeout(
              () => resolve({ type: "timeout", observed: observed.join(",") }),
              2_000,
            );
            worker.postMessage({ type: "close" }, []);
          } else if (message.type === "completed" || message.type === "error") {
            if (timeout) {
              clearTimeout(timeout);
            }
            resolve(message);
          }
        });
      });
      const result = await withinTest(outcome, signal);
      if (result.type === "timeout") {
        throw new Error(
          `worker connection race timed out after: ${JSON.stringify(result.observed)}`,
        );
      }
      expect(result).toMatchObject({ type: "completed", requestCount: 2 });
      expect(observed).toContain("closing-window");
      expect(closingReadyState).toBeDefined();
      expect(closingReadyState).not.toBe(WebSocket.OPEN);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await worker.terminate();
    }
  });
});
