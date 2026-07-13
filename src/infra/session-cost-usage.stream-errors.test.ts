// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionLogs } from "./session-cost-usage.js";

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

    const logs = await loadSessionLogs({ sessionFile });

    expect(logs).toEqual([]);
  });
});
