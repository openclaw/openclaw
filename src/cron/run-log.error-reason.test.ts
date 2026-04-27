import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCronRunLogEntriesPage } from "./run-log.js";

describe("cron run log errorReason", () => {
  it("backfills errorReason from timeout error text for older entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      `${JSON.stringify({ ts: 1, jobId: "job-1", action: "finished", status: "error", error: "cron: job execution timed out" })}\n`,
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10 });
    expect(page.entries[0]?.errorReason).toBe("timeout");
  });

  it("validates persisted errorReason before exposing entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-run-log-"));
    const file = path.join(dir, "job.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "error",
          error: "upstream unavailable: 503 overloaded",
          errorReason: "not-a-real-reason",
        }),
        JSON.stringify({
          ts: 2,
          jobId: "job-1",
          action: "finished",
          status: "error",
          errorReason: "auth_permanent",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const page = await readCronRunLogEntriesPage(file, { limit: 10, sortDir: "asc" });
    expect(page.entries[0]?.errorReason).toBe("overloaded");
    expect(page.entries[1]?.errorReason).toBe("auth_permanent");
  });
});
