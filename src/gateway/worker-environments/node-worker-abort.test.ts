import { describe, expect, it } from "vitest";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";

describe("raceNodeWorkerOperation", () => {
  it("observes source rejection when the operation was already aborted", async () => {
    const reason = new Error("worker owner closed");
    const signal = AbortSignal.abort(reason);
    const operation = Promise.reject(new Error("worker transport failed"));

    await expect(raceNodeWorkerOperation(operation, signal)).rejects.toBe(reason);
  });
});
