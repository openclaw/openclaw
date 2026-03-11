import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendExecHighRiskAuditLog,
  matchHighRiskExecCommand,
  resolveExecHighRiskSafetyConfig,
} from "./exec-high-risk-safety.js";

describe("exec high-risk safety", () => {
  it("matches high-risk commands in shell chains", () => {
    const match = matchHighRiskExecCommand({
      command: "echo ok && mv file-a file-b",
      commands: ["rm", "mv", "cp"],
      platform: "darwin",
    });
    expect(match?.matchedCommands).toEqual(["mv"]);
  });

  it("detects wrapped high-risk commands", () => {
    const match = matchHighRiskExecCommand({
      command: "sudo rm -rf ./tmp",
      commands: ["rm"],
      platform: "darwin",
    });
    expect(match?.matchedCommands).toEqual(["rm"]);
  });

  it("does not flag non-executable mentions", () => {
    const match = matchHighRiskExecCommand({
      command: "echo rm should-not-run",
      commands: ["rm"],
      platform: "darwin",
    });
    expect(match).toBeNull();
  });

  it("writes minimal audit entries without full command arguments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-risk-audit-"));
    const logPath = path.join(dir, "safety.log");
    const safety = resolveExecHighRiskSafetyConfig({
      enabled: true,
      commands: ["rm"],
      audit: { enabled: true, file: logPath, mode: "minimal" },
    });

    await appendExecHighRiskAuditLog({
      safety,
      host: "gateway",
      command: "rm -rf /tmp/secret",
      matchedCommands: ["rm"],
      decision: "rejected",
      reason: "user-denied",
      agentId: "main",
      sessionKey: "agent:main:main",
      turnSourceChannel: "telegram",
      turnSourceTo: "12345",
    });

    const lines = (await fs.readFile(logPath, "utf-8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as { command: string; reason: string; decision: string };
    expect(entry.command).toBe("rm");
    expect(entry.reason).toBe("user-denied");
    expect(entry.decision).toBe("rejected");
  });
});
