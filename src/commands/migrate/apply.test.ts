// Migration apply tests cover backups, filtering, provider apply calls, and report output.
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { runMigrationApply } from "./apply.js";

let stateDir = "";
const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-migrate-apply-" });

vi.mock("../../config/paths.js", async (importActual) => {
  const actual = await importActual<typeof import("../../config/paths.js")>();
  return {
    ...actual,
    resolveGatewayPort: () => 18789,
    resolveStateDir: () => stateDir,
  };
});

function buildEmptyPlan(): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: 0,
      planned: 0,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [],
  };
}

describe("runMigrationApply", () => {
  beforeAll(async () => {
    stateDir = await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  it("uses the resolved provider id when forwarding Codex options", async () => {
    const plan = vi.fn(async () => buildEmptyPlan());
    const apply = vi.fn(async () => buildEmptyPlan());
    const provider: MigrationProviderPlugin = {
      id: "codex",
      label: "Codex",
      plan,
      apply,
    };

    await runMigrationApply({
      runtime: createNonExitingRuntime(),
      opts: {
        yes: true,
        json: true,
        noBackup: true,
        configOverride: {},
        configPatchMode: "return",
        verifyPluginApps: true,
      },
      providerId: "codex",
      provider,
    });

    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
      }),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          configPatchMode: "return",
          verifyPluginApps: true,
        },
      }),
      expect.anything(),
    );
  });
});
