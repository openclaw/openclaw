// Regression test: session-cost readline stream errors are swallowed instead of
// crashing the caller's async iteration.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionLogs } from "./session-cost-usage.js";

describe("session cost usage stream errors", () => {
  let tempDir = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("does not crash when the transcript stream emits an error mid-read", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cost-stream-"));
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

    const originalCreateReadStream = nodeFs.createReadStream;
    vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce((...args: unknown[]) => {
      const stream = originalCreateReadStream.apply(nodeFs, args as never);
      process.nextTick(() => {
        stream.emit("error", new Error("stream read failed"));
      });
      return stream;
    });

    const logs = await loadSessionLogs({ sessionFile });

    expect(logs).toEqual([]);
  });
});
