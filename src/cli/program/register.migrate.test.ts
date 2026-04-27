import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationDetection } from "../../migrations/types.js";
import { registerMigrateCommand } from "./register.migrate.js";

const mocks = vi.hoisted(() => ({
  detectMigrationSources: vi.fn(async (): Promise<MigrationDetection[]> => []),
  listMigrationProviders: vi.fn(() => [{ id: "hermes", label: "Hermes" }]),
  buildMigrationPlan: vi.fn(async () => ({
    id: "plan",
    providerId: "hermes",
    label: "Hermes",
    sourceDir: "/tmp/hermes",
    targetStateDir: "/tmp/openclaw",
    targetWorkspaceDir: "/tmp/openclaw/workspace",
    createdAt: "2026-04-26T00:00:00.000Z",
    migrateSecrets: false,
    actions: [],
    warnings: [],
  })),
  applyMigrationPlan: vi.fn(async () => ({
    planId: "plan",
    dryRun: true,
    reportDir: "/tmp/openclaw/migrations/hermes/plan",
    results: [],
  })),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../migrations/registry.js", () => ({
  detectMigrationSources: mocks.detectMigrationSources,
  listMigrationProviders: mocks.listMigrationProviders,
}));

vi.mock("../../migrations/plan.js", () => ({
  buildMigrationPlan: mocks.buildMigrationPlan,
}));

vi.mock("../../migrations/apply.js", () => ({
  applyMigrationPlan: mocks.applyMigrationPlan,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerMigrateCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerMigrateCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers detect", async () => {
    mocks.detectMigrationSources.mockResolvedValueOnce([
      {
        providerId: "hermes",
        label: "Hermes",
        sourceDir: "/tmp/hermes",
        confidence: "high",
        reasons: ["config.yaml"],
      },
    ]);

    await runCli(["migrate", "detect"]);

    expect(mocks.detectMigrationSources).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining("Hermes: /tmp/hermes"));
  });

  it("builds plans with forwarded options", async () => {
    await runCli([
      "migrate",
      "plan",
      "--from",
      "hermes",
      "--source",
      "/tmp/hermes",
      "--target-state",
      "/tmp/openclaw",
      "--migrate-secrets",
    ]);

    expect(mocks.buildMigrationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "hermes",
        sourceDir: "/tmp/hermes",
        targetStateDir: "/tmp/openclaw",
        migrateSecrets: true,
      }),
    );
  });

  it("applies plans in dry-run mode", async () => {
    await runCli(["migrate", "apply", "--from", "hermes", "--dry-run"]);

    expect(mocks.applyMigrationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
      }),
    );
  });
});
