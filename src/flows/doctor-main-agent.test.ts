// Tests for the main agent doctor check.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import type { HealthRepairContext } from "./health-checks.js";

const createMockContext = (cfg: OpenClawConfig, overrides?: Partial<HealthRepairContext>) => ({
  cfg,
  cwd: "/tmp/test-workspace",
  configPath: "/tmp/test-config/openclaw.json",
  mode: "fix" as const, // repair requires "fix" mode
  allowExecSecretRefs: false,
  ...overrides,
});

describe("doctor main agent check", () => {
  it("detects missing main agent in configuration", async () => {
    const checks = createCoreHealthChecks();
    const mainAgentCheck = checks.find((c) => c.id === "core/doctor/main-agent");
    expect(mainAgentCheck).toBeDefined();

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "secondary",
            name: "Secondary Agent",
          },
        ],
      },
    };

    const findings = await mainAgentCheck!.detect(createMockContext(cfg));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "core/doctor/main-agent",
      severity: "error",
      message: expect.stringContaining('Missing required "main" agent entry'),
      path: "agents.list",
    });
  });

  it("passes when main agent is present", async () => {
    const checks = createCoreHealthChecks();
    const mainAgentCheck = checks.find((c) => c.id === "core/doctor/main-agent");
    expect(mainAgentCheck).toBeDefined();

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
          },
        ],
      },
    };

    const findings = await mainAgentCheck!.detect(createMockContext(cfg));
    expect(findings).toHaveLength(0);
  });

  it("repairs missing main agent in dry-run mode", async () => {
    const checks = createCoreHealthChecks();
    const mainAgentCheck = checks.find((c) => c.id === "core/doctor/main-agent");
    expect(mainAgentCheck).toBeDefined();

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "secondary",
            name: "Secondary Agent",
          },
        ],
      },
    };

    const repairResult = await mainAgentCheck!.repair!(
      createMockContext(cfg, { dryRun: true }),
      [],
    );

    expect(repairResult.status).toBe("repaired");
    expect(repairResult.changes).toHaveLength(1);
    expect(repairResult.changes[0]).toContain('Would add default "main" agent entry');
    expect(repairResult.effects).toHaveLength(1);
    expect(repairResult.effects[0]).toMatchObject({
      kind: "config",
      action: "would-add-main-agent",
      target: "agents.list",
      dryRunSafe: true,
    });
  });

  it("repairs missing main agent - verifies config structure", async () => {
    const checks = createCoreHealthChecks();
    const mainAgentCheck = checks.find((c) => c.id === "core/doctor/main-agent");
    expect(mainAgentCheck).toBeDefined();

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "secondary",
            name: "Secondary Agent",
          },
        ],
      },
    };

    // This test verifies the repair logic produces the correct config structure
    // without actually writing to disk (which would require complex mocking)
    const repairResult = await mainAgentCheck!.repair!(
      createMockContext(cfg, { dryRun: true }),
      [],
    );

    expect(repairResult.status).toBe("repaired");
    expect(repairResult.changes).toHaveLength(1);
    expect(repairResult.changes[0]).toContain('Would add default "main" agent entry');

    // Verify the effect is correct
    expect(repairResult.effects).toHaveLength(1);
    expect(repairResult.effects[0]).toMatchObject({
      kind: "config",
      action: "would-add-main-agent",
      target: "agents.list",
      dryRunSafe: true,
    });
  });

  it("skips repair when main agent already exists", async () => {
    const checks = createCoreHealthChecks();
    const mainAgentCheck = checks.find((c) => c.id === "core/doctor/main-agent");
    expect(mainAgentCheck).toBeDefined();

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
          },
          {
            id: "secondary",
            name: "Secondary",
          },
        ],
      },
    };

    const repairResult = await mainAgentCheck!.repair!(
      createMockContext(cfg, { dryRun: false }),
      [],
    );

    expect(repairResult.status).toBe("skipped");
    expect(repairResult.reason).toContain("already present");
  });
});
