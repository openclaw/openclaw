// Channel log filtering must scan the bounded tail before applying the requested result limit.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setLoggerOverride } from "../../logging.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import { channelsLogsCommand } from "./logs.js";

function logLine(channel: string, message: string): string {
  return JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify({ module: `gateway/channels/${channel}/send` }),
    },
  });
}

describe("channelsLogsCommand channel filtering", () => {
  it("finds matching channel logs beyond newer unrelated lines", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channel-logs-filter-"));
    const logPath = path.join(tempDir, "openclaw.log");
    setLoggerOverride({ file: logPath });
    try {
      await fs.writeFile(
        logPath,
        [
          logLine("slack", "the requested channel"),
          logLine("telegram", "unrelated one"),
          logLine("telegram", "unrelated two"),
          logLine("telegram", "unrelated three"),
          logLine("telegram", "unrelated four"),
        ].join("\n"),
      );
      const runtime = createTestRuntime();

      await channelsLogsCommand({ channel: "slack", json: true, lines: "1" }, runtime);

      const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
        channel: string;
        lines: Array<{ message: string }>;
      };
      expect(payload.channel).toBe("slack");
      expect(payload.lines.map((line) => line.message)).toEqual(["the requested channel"]);
    } finally {
      setLoggerOverride(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
