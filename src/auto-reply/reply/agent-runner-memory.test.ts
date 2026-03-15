import { describe, expect, it } from "vitest";
import { shouldAttemptMemoryFlushRun } from "./agent-runner-memory.js";

describe("shouldAttemptMemoryFlushRun", () => {
  it("skips subagent sessions", () => {
    expect(
      shouldAttemptMemoryFlushRun({
        memoryFlushWritable: true,
        isHeartbeat: false,
        isCli: false,
        sessionKey: "agent:main:subagent:worker",
      }),
    ).toBe(false);
  });

  it("skips heartbeat and cli runs", () => {
    expect(
      shouldAttemptMemoryFlushRun({
        memoryFlushWritable: true,
        isHeartbeat: true,
        isCli: false,
        sessionKey: "main",
      }),
    ).toBe(false);
    expect(
      shouldAttemptMemoryFlushRun({
        memoryFlushWritable: true,
        isHeartbeat: false,
        isCli: true,
        sessionKey: "main",
      }),
    ).toBe(false);
  });

  it("allows regular writable sessions", () => {
    expect(
      shouldAttemptMemoryFlushRun({
        memoryFlushWritable: true,
        isHeartbeat: false,
        isCli: false,
        sessionKey: "main",
      }),
    ).toBe(true);
  });
});
