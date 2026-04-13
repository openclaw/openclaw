import { describe, expect, it } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { printCronJson } from "./shared.js";

describe("printCronJson cause display", () => {
  it("adds cause and prefixes error text for cron run entries", () => {
    let written: unknown;
    const original = defaultRuntime.writeJson;
    defaultRuntime.writeJson = (value: unknown) => {
      written = value;
    };
    try {
      printCronJson({
        entries: [
          {
            ts: 1,
            jobId: "job-1",
            action: "finished",
            status: "error",
            errorReason: "timeout",
            error: "cron: job execution timed out",
          },
        ],
      });
    } finally {
      defaultRuntime.writeJson = original;
    }

    const result = written as { entries: Array<Record<string, unknown>> };
    expect(result.entries[0]?.cause).toBe("timeout");
    expect(result.entries[0]?.error).toBe("Cause: timeout\ncron: job execution timed out");
  });
});
