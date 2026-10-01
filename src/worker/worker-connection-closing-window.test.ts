import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";

describe("worker connection close during durable RPC", () => {
  it("lets the close event run before replaying a Gateway tool call", async () => {
    const worker = new Worker(
      new URL("./repro-worker-connection-closing-window.ts", import.meta.url),
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
      },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed: string[] = [];
    let closingReadyState: number | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        timeout = setTimeout(
          () => resolve({ type: "timeout", observed: observed.join(",") }),
          2_000,
        );
        worker.on("error", reject);
        worker.on("message", (message: Record<string, unknown>) => {
          observed.push(String(message.type));
          if (message.type === "closing-window" && typeof message.readyState === "number") {
            closingReadyState = message.readyState;
          }
          if (message.type === "ready") {
            worker.postMessage({ type: "close" }, []);
          } else if (message.type === "completed" || message.type === "error") {
            if (timeout) {
              clearTimeout(timeout);
            }
            resolve(message);
          }
        });
      });
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
