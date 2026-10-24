import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import { readLifecycleWriteCustody } from "../../infra/lifecycle-write-custody.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { runMigrationApply } from "./apply.js";
import type { MigrateApplyOptions } from "./types.js";

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
    summary: summarizeMigrationItems([]),
    items: [],
  };
}

function makeProvider(overrides: Partial<MigrationProviderPlugin> = {}) {
  return {
    id: "codex",
    label: "Codex",
    plan: vi.fn(async () => buildEmptyPlan()),
    apply: vi.fn(async () => buildEmptyPlan()),
    ...overrides,
  };
}

function run(provider: MigrationProviderPlugin, opts: MigrateApplyOptions = {}) {
  return runMigrationApply({
    runtime: createNonExitingRuntime(),
    providerId: provider.id,
    provider,
    opts: { json: true, noBackup: true, ...opts },
  });
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
    const provider = makeProvider({ id: "fixture", label: "Fixture" });
    try {
      await expect(run(provider, { configOverride: {} })).rejects.toThrow("stop the Gateway");
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
      const provider = makeProvider({
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
      });
      const running = run(provider, { configOverride: {} }).catch((error: unknown) => error);
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
    const provider = makeProvider();
    const providerOptions = { configPatchMode: "return", verifyPluginApps: true } as const;
    await run(provider, {
      yes: true,
      configOverride: {},
      ...providerOptions,
    });

    const context = expect.objectContaining({ providerOptions });
    expect(provider.plan).toHaveBeenCalledWith(context);
    expect(provider.apply).toHaveBeenCalledWith(context, expect.anything());
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
    const provider = makeProvider({ apply: vi.fn(async () => partial) });
    const result = await run(provider, { yes: true, allowPartialResult: true });

    expect(result.summary.errors).toBe(1);
    expect(result.items[0]?.details?.recoveryPath).toBe("/tmp/staged-memory");
    expect(result.reportDir).toContain("codex");
  });
});
