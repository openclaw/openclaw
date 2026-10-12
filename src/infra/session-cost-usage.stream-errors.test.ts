// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requestCostUsageCacheRefresh } from "./session-cost-usage-cache-runtime.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionLogs,
} from "./session-cost-usage.js";
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

  it("keeps readable usage and complete checkpoints after background and report stream errors", async () => {
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

    await fs.writeFile(
      path.join(sessionsDir, "sess-readable.jsonl"),
      `${usageEntry("2026-07-06T12:00:00.000Z", 7)}\n`,
      "utf-8",
    );
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
        const range = {
          startMs: Date.UTC(2026, 6, 6),
          endMs: Date.UTC(2026, 6, 7),
        };
        await loadCostUsageSummary({
          ...range,
          agentId: "main",
        });
        const rollupsBefore = readSessionCostUsageRollupRows();

        await fs.appendFile(sessionFile, appendedEntry, "utf-8");
        await fs.writeFile(armed, "armed");

        const work = new AsyncWorkScope();
        try {
          await work.track(async () =>
            requestCostUsageCacheRefresh({
              agentId: "main",
              storePath: path.join(sessionsDir, "sessions.json"),
            }),
          );
          await work.runWhenIdle(() => undefined);
        } finally {
          await work.drain();
        }
        const readSummary = () =>
          loadCostUsageSummaryFromCache({
            ...range,
            agentId: "main",
            requestRefresh: false,
          });
        const afterRefresh = await readSummary();
        expect(await fs.readFile(failed, "utf8")).toBe("stream read failed");
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
        expect(afterRefresh.totals.totalTokens).toBe(17);
        expect(afterRefresh.cacheStatus).toMatchObject({
          status: "partial",
          cachedFiles: 2,
          pendingFiles: 1,
        });

        await fs.unlink(failed);
        await fs.writeFile(armed, "armed");
        const afterReplay = await readSummary();
        expect(await fs.readFile(failed, "utf8")).toBe("stream read failed");
        expect(afterReplay.totals.totalTokens).toBe(7);
        expect(afterReplay.cacheStatus).toMatchObject({
          status: "partial",
          cachedFiles: 1,
          pendingFiles: 1,
        });
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
        const recovered = await readSummary();
        expect(recovered.totals.totalTokens).toBe(17);
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
      },
    );
  });
});
