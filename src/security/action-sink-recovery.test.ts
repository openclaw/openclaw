import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionSinkPolicyConfig } from "./action-sink-policy-config.js";
import { disableActionSinkModule, setActionSinkGlobalMode } from "./action-sink-recovery.js";
import { buildActionSinkShadowReport } from "./action-sink-shadow-report.js";

describe("action sink recovery", () => {
  const config = parseActionSinkPolicyConfig({ recovery: { operatorIds: ["ceo"] } });

  it("denies non-operators", async () => {
    await expect(
      setActionSinkGlobalMode(config, "shadow", { actorId: "agent", reason: "test" }),
    ).rejects.toThrow(/operators/);
  });

  it("allows operator global rollback and per-module disable with emergency log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "action-sink-recovery-"));
    const emergencyLogPath = path.join(dir, "emergency.ndjson");
    await expect(
      setActionSinkGlobalMode(config, "shadow", {
        actorId: "ceo",
        reason: "rollback",
        emergencyLogPath,
      }),
    ).resolves.toMatchObject({ defaultMode: "shadow" });
    await expect(
      disableActionSinkModule(config, "protectedWorktree", {
        actorId: "ceo",
        reason: "breakglass",
        emergencyLogPath,
      }),
    ).resolves.toMatchObject({ moduleModes: { protectedWorktree: "disabled" } });
    expect(await fs.readFile(emergencyLogPath, "utf8")).toContain("breakglass");
  });

  it("summarizes shadow mode report", () => {
    expect(
      buildActionSinkShadowReport([
        {
          timestamp: "t",
          policyVersion: "v1",
          policyId: "p",
          decision: "allow",
          actionType: "file_write",
          reasonCode: "shadow_allowed",
          reason: "Shadow mode would have block: x",
          mode: "shadow",
          correlationId: "c",
        },
      ]).wouldBlock,
    ).toBe(1);
  });
});
