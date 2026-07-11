// Bounded retention for the launchd supervisor stderr sink (gateway.err.log).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capLaunchAgentStderrLogTail } from "./launchd.js";

const tempRoots: string[] = [];

async function makeStderrFile(content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-stderr-"));
  tempRoots.push(root);
  const stderrPath = path.join(root, "gateway.err.log");
  await fs.writeFile(stderrPath, content, "utf8");
  return stderrPath;
}

describe("capLaunchAgentStderrLogTail", () => {
  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps files at or under the cap untouched", async () => {
    const content = "small stderr content\n";
    const stderrPath = await makeStderrFile(content);

    await capLaunchAgentStderrLogTail(stderrPath);

    await expect(fs.readFile(stderrPath, "utf8")).resolves.toBe(content);
  });

  it("truncates an oversized stderr log to its most recent tail", async () => {
    // 2.5MB of numbered lines; the newest bytes must survive, oldest must go.
    const line = (n: number) => `stderr line ${String(n).padStart(8, "0")}\n`;
    const lines = Array.from({ length: 120_000 }, (_, n) => line(n)).join("");
    expect(Buffer.byteLength(lines)).toBeGreaterThan(2_000_000);
    const stderrPath = await makeStderrFile(lines);

    await capLaunchAgentStderrLogTail(stderrPath);

    const after = await fs.readFile(stderrPath, "utf8");
    expect(Buffer.byteLength(after)).toBe(1_000_000);
    expect(after).toContain(line(119_999).trim());
    expect(after).not.toContain("stderr line 00000000");
  });

  it("silently no-ops when the stderr log does not exist", async () => {
    await expect(
      capLaunchAgentStderrLogTail("/nonexistent/openclaw/gateway.err.log"),
    ).resolves.toBeUndefined();
  });
});
