import { getEnvironmentData, Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("offline database port", () => {
  it("round-trips bounded workboard data, exact cells and cursors, and refuses literal text NUL", async () => {
    const url = new URL("./port-roundtrip.test-support.ts", import.meta.url);
    const worker = new Worker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: { connection },
    });
    const result = await new Promise<{ milliseconds: number; rows: number; nulRefused: boolean }>(
      (resolve, reject) => {
        let received: { milliseconds: number; rows: number; nulRefused: boolean } | undefined;
        worker.once("message", (value: typeof received) => {
          received = value;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0 || !received) {
            reject(new Error(`Port worker exited ${code} without a result`));
          } else {
            resolve(received);
          }
        });
      },
    );
    expect(result.rows).toBe(1011);
    expect(result.nulRefused).toBe(true);
    expect(result.milliseconds).toBeLessThan(60_000);
  }, 60_000);
});
