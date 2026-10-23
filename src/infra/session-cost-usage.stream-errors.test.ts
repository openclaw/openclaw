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
const sessionHeader = JSON.stringify({ type: "session", version: 1, id: "sess-stream-error" });
async function createSession(id: string, contents: string) {
  const tempDir = tempDirs.make("openclaw-session-cost-stream-");
  const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
  await fs.writeFile(sessionFile, contents, "utf-8");
  return { tempDir, sessionsDir, sessionFile };
}

describe("session cost usage stream errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not crash when the transcript stream emits an error mid-read", async () => {
    const { sessionFile } = await createSession(
      "sess-stream-error",
      [
        sessionHeader,
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "hello" },
        }),
        "",
      ].join("\n"),
    );

    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce(() => {
      const stream = new PassThrough();
      stream.write(`${sessionHeader}\n`);
      process.nextTick(() => {
        stream.destroy(new Error("stream read failed"));
      });
      return stream as unknown as nodeFs.ReadStream;
    });

    expect(await loadSessionLogs({ agentId: "main", sessionFile })).toEqual([]);
  });

  it("keeps readable usage and complete checkpoints after background and report stream errors", async () => {
    const usageEntry = (timestamp: string, input: number) =>
      JSON.stringify({
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          usage: { input, output: 0, totalTokens: input, cost: { total: input / 1000 } },
        },
      });
    const { tempDir, sessionsDir, sessionFile } = await createSession(
      "sess-cache-stream-error",
      `${usageEntry("2026-07-06T12:00:00.000Z", 10)}\n`,
    );

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
        const query = {
          config: {},
          agentId: "main",
          startMs: Date.UTC(2026, 6, 6),
          endMs: Date.UTC(2026, 6, 7),
        };
        await loadCostUsageSummary(query);
        const rollupsBefore = readSessionCostUsageRollupRows();

        await fs.appendFile(sessionFile, appendedEntry, "utf-8");
        await fs.writeFile(armed, "armed");

        const work = new AsyncWorkScope();
        try {
          await work.track(async () =>
            requestCostUsageCacheRefresh({
              config: query.config,
              agentId: query.agentId,
              storePath: path.join(sessionsDir, "sessions.json"),
            }),
          );
          await work.runWhenIdle(() => undefined);
        } finally {
          await work.drain();
        }
        const readSummary = () =>
          loadCostUsageSummaryFromCache({
            ...query,
            requestRefresh: false,
          });
        const afterRefresh = await readSummary();
        expect(await fs.readFile(failed, "utf8")).toBe("stream read failed");
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
        expect(afterRefresh).toMatchObject({
          totals: { totalTokens: 17 },
          cacheStatus: { status: "partial", cachedFiles: 2, pendingFiles: 1 },
        });

        await fs.unlink(failed);
        await fs.writeFile(armed, "armed");
        const afterReplay = await readSummary();
        expect(await fs.readFile(failed, "utf8")).toBe("stream read failed");
        expect(afterReplay).toMatchObject({
          totals: { totalTokens: 7 },
          cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 1 },
        });
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
        const recovered = await readSummary();
        expect(recovered.totals.totalTokens).toBe(17);
        expect(readSessionCostUsageRollupRows()).toEqual(rollupsBefore);
      },
    );
  });
});
