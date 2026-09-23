// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { loadCostUsageSummaryFromCache, loadSessionLogs } from "./session-cost-usage.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cost usage stream errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not crash when the transcript stream emits an error mid-read", async () => {
    const tempDir = tempDirs.make("openclaw-session-cost-stream-");
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-stream-error.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "hello" },
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce(() => {
      const stream = new PassThrough();
      stream.write(`${JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" })}\n`);
      process.nextTick(() => {
        stream.destroy(new Error("stream read failed"));
      });
      return stream as unknown as nodeFs.ReadStream;
    });

    const logs = await loadSessionLogs({ agentId: "main", sessionFile });

    expect(logs).toEqual([]);
  });

  it("does not persist a partial durable cache entry after a background stream error", async () => {
    const tempDir = tempDirs.make("openclaw-session-cost-cache-stream-");
    const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sess-cache-stream-error.jsonl");
    const usageEntry = (timestamp: string, input: number) =>
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          usage: { input, output: 0, totalTokens: input, cost: { total: input / 1000 } },
        },
      });
    await fs.writeFile(sessionFile, `${usageEntry("2026-07-06T12:00:00.000Z", 10)}\n`, "utf-8");

    const appendedEntry = `${usageEntry("2026-07-06T12:01:00.000Z", 20)}\n`;
    const armed = path.join(tempDir, "fail-next-stream");
    const failed = path.join(tempDir, "stream-failed");
    const preload = path.join(tempDir, "fail-usage-stream.cjs");
    await fs.writeFile(
      preload,
      `const fs = require("node:fs");
const { Readable } = require("node:stream");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function(file, ...args) {
    if (String(file) === ${JSON.stringify(sessionFile)} && fs.existsSync(${JSON.stringify(armed)})) {
      fs.unlinkSync(${JSON.stringify(armed)});
      return Readable.from((async function* () {
        yield ${JSON.stringify(appendedEntry)};
        fs.writeFileSync(${JSON.stringify(failed)}, "stream read failed");
        throw new Error("stream read failed");
      })());
    }
    return Reflect.apply(createReadStream, this, [file, ...args]);
  };
  require("node:module").syncBuiltinESMExports();
}
`,
    );
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: tempDir, ...sqliteWorkerPreloadEnv(preload) },
      async () => {
        try {
          const range = {
            startMs: Date.UTC(2026, 6, 6),
            endMs: Date.UTC(2026, 6, 7),
          };
          await loadCostUsageSummaryFromCache({
            ...range,
            agentId: "main",
            refreshMode: "sync-when-empty",
          });
          const rollupsBefore = readSessionCostUsageRollupRows();

          await fs.appendFile(sessionFile, appendedEntry, "utf-8");
          await fs.writeFile(armed, "armed");

          await loadCostUsageSummaryFromCache({ ...range, agentId: "main" });
          let summary = await loadCostUsageSummaryFromCache({
            ...range,
            agentId: "main",
            requestRefresh: false,
          });
          await vi.waitFor(
            async () => {
              summary = await loadCostUsageSummaryFromCache({
                ...range,
                agentId: "main",
                requestRefresh: false,
              });
              expect(summary.cacheStatus?.status).toBe("partial");
            },
            { interval: 5, timeout: 1_000 },
          );

          expect(await fs.readFile(failed, "utf8")).toBe("stream read failed");
          expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
          expect(summary.totals.totalTokens).toBe(10);
          expect(summary.cacheStatus?.pendingFiles).toBe(1);
        } finally {
          await cleanupSessionStateForTest({ stateDir: tempDir });
        }
      },
    );
  });
});
