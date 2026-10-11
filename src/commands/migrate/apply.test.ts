// Migration apply tests cover backups, filtering, provider apply calls, and report output.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import { readLifecycleWriteCustody } from "../../infra/lifecycle-write-custody.js";
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

  it("refuses a supplied provider before planning or applying under a live Gateway", async () => {
    const discover = vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
      pid: process.pid,
      port: 18789,
      ownerId: "synthetic-foreign-gateway",
      createdAt: new Date().toISOString(),
    });
    const provider = {
      id: "fixture",
      label: "Fixture",
      plan: vi.fn(async () => buildEmptyPlan()),
      apply: vi.fn(async () => buildEmptyPlan()),
    };
    try {
      await expect(
        runMigrationApply({
          runtime: createNonExitingRuntime(),
          providerId: provider.id,
          provider,
          opts: { json: true, noBackup: true, configOverride: {} },
        }),
      ).rejects.toThrow("stop the Gateway");
      expect(provider.plan).not.toHaveBeenCalled();
      expect(provider.apply).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
    }
  });

  it.each([false, true])(
    "retains migration custody until provider settlement (failure: %s)",
    async (fail) => {
      const entered = createDeferred();
      const settled = createDeferred();
      const provider: MigrationProviderPlugin = {
        id: "fixture",
        label: "Fixture",
        plan: async () => {
          expect(readLifecycleWriteCustody()).toEqual([]);
          return buildEmptyPlan();
        },
        apply: async () => {
          entered.resolve();
          await settled.promise;
          if (fail) {
            throw new Error("migration failed");
          }
          return buildEmptyPlan();
        },
      };
      const running = runMigrationApply({
        runtime: createNonExitingRuntime(),
        providerId: provider.id,
        provider,
        opts: { json: true, noBackup: true, configOverride: {} },
      }).catch((error: unknown) => error);
      await entered.promise;
      try {
        expect(readLifecycleWriteCustody()).toEqual([{ phase: "migration", count: 1 }]);
      } finally {
        settled.resolve();
        await running;
      }
      const result = await running;
      expect(result instanceof Error).toBe(fail);
      expect(readLifecycleWriteCustody()).toEqual([]);
    },
  );

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

  it("returns partial item failures to embedded callers with report metadata", async () => {
    const partial = buildEmptyPlan();
    partial.summary = { ...partial.summary, total: 1, errors: 1 };
    partial.items = [
      {
        id: "memory:one",
        kind: "memory",
        action: "copy",
        status: "error",
        reason: "copy failed",
        details: { recoveryPath: "/tmp/staged-memory" },
      },
    ];
    const provider: MigrationProviderPlugin = {
      id: "codex",
      label: "Codex",
      plan: vi.fn(async () => buildEmptyPlan()),
      apply: vi.fn(async () => partial),
    };

    const result = await runMigrationApply({
      runtime: createNonExitingRuntime(),
      opts: {
        yes: true,
        json: true,
        noBackup: true,
        allowPartialResult: true,
      },
      providerId: "codex",
      provider,
    });

    expect(result.summary.errors).toBe(1);
    expect(result.items[0]?.details?.recoveryPath).toBe("/tmp/staged-memory");
    expect(result.reportDir).toContain("codex");
  });
});
