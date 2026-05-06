import { describe, expect, it, vi } from "vitest";
import { buildWorkerTriggerLoopResult, workerTriggerLoopCommand } from "./worker-trigger.js";

describe("worker trigger CLI contract", () => {
  it("returns a bounded local contract without external dispatch", () => {
    expect(buildWorkerTriggerLoopResult()).toEqual({
      ok: true,
      command: "worker trigger loop",
      mode: "local-contract",
      executed: false,
      message: "Worker trigger loop accepted by the local contract; no external dispatch executed.",
    });
  });

  it("prints machine-readable trigger-loop proof", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let output = "";
    try {
      await workerTriggerLoopCommand();
      output = String(write.mock.calls[0]?.[0] ?? "");
    } finally {
      write.mockRestore();
    }

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      command: "worker trigger loop",
      mode: "local-contract",
      executed: false,
    });
  });
});
