// Cron Mcp Cleanup Docker Client tests cover cron mcp cleanup docker client script behavior.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCronFinishedOk,
  readCronMcpCleanupProbePidWaitMs,
  waitForProbePid,
} from "../../scripts/e2e/cron-mcp-cleanup-docker-client.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(delay).mockReset();
});

describe("cron MCP cleanup docker client", () => {
  it("rejects malformed probe pid wait limits", () => {
    expect(readCronMcpCleanupProbePidWaitMs({})).toBe(120_000);
    expect(readCronMcpCleanupProbePidWaitMs({ OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS: "250" })).toBe(
      250,
    );
    for (const value of ["1.5", "1e3", "10ms", "0"]) {
      expect(() =>
        readCronMcpCleanupProbePidWaitMs({
          OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS: value,
        }),
      ).toThrow("invalid OPENCLAW_CRON_MCP_CLEANUP_PID_WAIT_MS");
    }
  });

  it.each(["missing", "malformed"])("bounds %s probe pid waits", async (fixture) => {
    const root = tempDirs.make("openclaw-cron-mcp-client-");
    const pidPath = path.join(root, "probe.pid");
    if (fixture === "malformed") {
      fs.writeFileSync(pidPath, "123abc\n", "utf8");
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    vi.mocked(delay).mockImplementation(async (ms) => {
      expect(ms).toBe(1);
      expect(Date.now(), "polling must stop at the configured deadline").toBeLessThan(20);
      vi.setSystemTime(Date.now() + ms!);
    });

    await expect(waitForProbePid(pidPath, { pollMs: 1, timeoutMs: 20 })).resolves.toBeUndefined();
    expect(Date.now()).toBe(20);
  });

  it("accepts cron finished events only when the run status is ok", () => {
    expect(() => assertCronFinishedOk({ status: "ok" })).not.toThrow();
    expect(() => assertCronFinishedOk({ status: "error" })).toThrow(
      /cron cleanup run did not finish ok/u,
    );
    expect(() => assertCronFinishedOk({})).toThrow(/cron cleanup run did not finish ok/u);
  });
});
