import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import { PluginInstallRuntimeBatch } from "../plugins/install-runtime-batch.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyClawUpdateForGateway } from "./gateway-update-apply.js";
import { runClawPluginBatch } from "./plugin-runtime.js";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  stage: vi.fn(),
}));

vi.mock("./clawhub-source.js", () => ({
  withResolvedClawHubSource: async (input: {
    run: (source: unknown, trust: unknown, persist: () => Promise<unknown>) => Promise<unknown>;
  }) => {
    const source = {
      source: { packageRoot: "/tmp/verified-claw", name: "@acme/worker" },
      manifest: { mcpServers: {} },
    };
    const trust = { riskAcknowledgementRequired: false };
    return { value: await input.run(source, trust, async () => source), ...trust };
  },
}));

vi.mock("./gateway-lifecycle-plan.js", () => ({
  prepareGatewayClawUpdatePlanning: async () => ({
    stateOptions: { env: process.env },
    packagePreflight: async () => ({ ok: true }),
    packageDeps: {},
  }),
  buildGatewayClawUpdatePlan: async () => ({
    plan: {
      agentId: "worker",
      planIntegrity: "sha256:canonical",
      blockers: [],
      actions: [],
    },
    projection: {
      planIntegrity: "sha256:reviewed",
      blockers: [],
      pluginReviews: [],
      skillReviews: [],
      configuredAccess: { current: {}, desired: {} },
      readiness: { ready: true, requirements: [] },
    },
    stateOptions: { env: process.env },
    sourceMcpServers: {},
  }),
}));

vi.mock("./gateway-plan-projection.js", () => ({
  bindClawLifecycleTrust: (value: unknown) => value,
  plansMatchAcrossSourceRoots: () => true,
}));

vi.mock("./gateway-disclosure.js", () => ({
  projectClawConfiguredAccess: ({ config }: { config: OpenClawConfig }) => ({
    current: config.agents?.entries?.worker?.name === "Changed" ? { changed: true } : {},
    desired: {},
  }),
}));

vi.mock("./update-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-apply.js")>()),
  applyClawUpdatePlan: mocks.apply,
  stageClawUpdateHostRequirements: mocks.stage,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
beforeEach(() => vi.resetAllMocks());

it("uses migration policy committed before the Update runtime activation lease", async () => {
  const root = dirs.make("claw-gateway-update-migration-");
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));

  await withEnvAsync(env, async () => {
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: {},
      nextInstallRecords: {
        fixture: { source: "clawhub", clawhubPackage: "fixture", version: "1" },
      },
      nextConfig: config,
      writeOptions: { afterWrite: { mode: "none", reason: "Update migration fixture" } },
    });
    let pluginLeaseAcquisitions = 0;
    let migrationCommitted = false;
    const acquire = leaseAcquisition.acquireOpenClawStateLease;
    const acquireSpy = vi
      .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
      .mockImplementation(async (params) => {
        if (params.label.includes("plugin lifecycle lease")) {
          pluginLeaseAcquisitions += 1;
          if (pluginLeaseAcquisitions === 2) {
            await recordDeferredPluginMigrations({
              env,
              pending: [
                {
                  pluginId: "legacy-fixture",
                  reason: "Legacy config awaits plugin migration",
                  command: "openclaw doctor --fix",
                  configPaths: [["legacyFixture"]],
                  validationExcludedPaths: [["legacyFixture"]],
                },
              ],
            });
            await fs.writeFile(
              env.OPENCLAW_CONFIG_PATH,
              JSON.stringify({ ...config, legacyFixture: { value: "retained" } }),
            );
            migrationCommitted = true;
          }
        }
        return await acquire(params);
      });
    const result = { agentId: "worker", status: "complete" as const };
    const continueMutation = vi.fn(async () => result);
    mocks.stage.mockImplementation(async (_plan, _source, options) => {
      options.assertReviewedConfig(config, { id: "worker" });
      options.runtimeBatch.retain("fixture");
      return {
        needsRuntimeHandoff: true,
        requiredPluginIds: ["fixture"],
        continue: continueMutation,
        failRuntime: async () => {
          throw new Error("Update runtime activation failed");
        },
      };
    });
    const reloadPlugins = vi.fn(async (_targets, options) =>
      withPluginLifecycleLease({ env }, async () => {
        options?.commitGuard?.();
        return { operationId: "reload", generation: 5, pluginIds: ["fixture"] };
      }),
    );
    try {
      const outcome = await applyClawUpdateForGateway({
        agentId: "worker",
        source: { packageName: "@openclaw/worker", version: "2.0.0" },
        planIntegrity: "sha256:reviewed",
        getRuntimeConfig: () => config,
        policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
        assertCurrent: () => {},
        reloadPlugins,
      });
      expect(migrationCommitted).toBe(true);
      expect(outcome).toMatchObject({ status: "complete" });
      expect(continueMutation).toHaveBeenCalledOnce();
    } finally {
      acquireSpy.mockRestore();
    }
  });
});

it.each([
  "complete",
  "reload-rejected",
  "stage-rejected",
  "lease-finalizer-rejected",
  "owner-replaced",
  "zero-target-reuse-owner-replaced",
  "labs-off-during-reload",
  "access-changed-during-reload",
  "plugin-disabled-at-commit",
  "plugin-disabled-after-reload-commit",
] as const)("settles Update plugin requirements between leased phases: %s", async (outcome) => {
  const root = dirs.make("claw-gateway-update-batch-");
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));

  await withEnvAsync(env, async () => {
    const fixtureRecord = { source: "clawhub" as const, clawhubPackage: "fixture", version: "1" };
    const installFixture = () =>
      commitPluginInstallRecordsWithConfig({
        previousInstallRecords: {},
        nextInstallRecords: { fixture: fixtureRecord },
        nextConfig: config,
        writeOptions: { afterWrite: { mode: "none", reason: "Update batch fixture" } },
      });
    const replaceFixture = () =>
      commitPluginInstallRecordsWithConfig({
        previousInstallRecords: { fixture: fixtureRecord },
        nextInstallRecords: {
          fixture: { ...fixtureRecord, installPath: path.join(root, "replacement") },
        },
        nextConfig: config,
        writeOptions: { afterWrite: { mode: "none", reason: "replacement fixture" } },
      });
    if (outcome !== "stage-rejected") {
      await installFixture();
    }

    const result = { agentId: "worker", status: "complete" as const };
    mocks.apply.mockImplementation(
      async (_plan, _source, options) =>
        await runClawPluginBatch(
          options,
          1,
          async (batch) => {
            batch?.retain("fixture");
            return result;
          },
          (failure) => new Error(`Runtime handoff failed: ${String(failure)}`),
        ),
    );
    const continueMutation = vi.fn(
      async (nextOptions: { getCurrentConfig: () => OpenClawConfig }) => {
        expect(hasPluginLifecycleLease()).toBe(true);
        expect(nextOptions.getCurrentConfig()).toMatchObject(config);
        return result;
      },
    );
    const failRuntime = vi.fn(async (error: unknown) => {
      throw error;
    });
    mocks.stage.mockImplementation(async (_plan, _source, options) => {
      expect(hasPluginLifecycleLease()).toBe(true);
      options.assertReviewedConfig(config, { id: "worker" });
      if (outcome === "stage-rejected") {
        const write = await installFixture();
        options.runtimeBatch.install().record({
          operation: "install",
          pluginId: "fixture",
          sourceDigests: {},
          write,
        });
        throw new Error("staging failed after plugin commit");
      }
      if (outcome !== "zero-target-reuse-owner-replaced") {
        options.runtimeBatch.retain("fixture");
      }
      if (outcome === "lease-finalizer-rejected") {
        getPluginCache().instances.add({
          pluginId: "fixture",
          quiesce: () => true,
          dispose: async () => {
            throw new Error("Plugin cache finalizer failed");
          },
        });
      }
      return {
        needsRuntimeHandoff: true,
        requiredPluginIds: ["fixture"],
        continue: continueMutation,
        failRuntime,
      };
    });
    const reloadPlugins = vi.fn(
      async (targets: readonly { pluginId: string }[], options?: { commitGuard?: () => void }) => {
        expect(hasPluginLifecycleLease()).toBe(true);
        expect(targets.map((target) => target.pluginId)).toEqual(["fixture"]);
        if (outcome === "labs-off-during-reload") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ gateway: { controlUi: { experimental: { claws: false } } } }),
          );
        }
        if (outcome === "access-changed-during-reload") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ ...config, agents: { entries: { worker: { name: "Changed" } } } }),
          );
        }
        if (outcome === "plugin-disabled-at-commit") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ ...config, plugins: { entries: { fixture: { enabled: false } } } }),
          );
        }
        expect(options?.commitGuard).toBeTypeOf("function");
        options?.commitGuard?.();
        if (outcome === "reload-rejected") {
          throw new Error("Gateway reload failed");
        }
        if (outcome === "owner-replaced") {
          await replaceFixture();
        }
        if (outcome === "plugin-disabled-after-reload-commit") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ ...config, plugins: { entries: { fixture: { enabled: false } } } }),
          );
        }
        return { operationId: "update", generation: 4, pluginIds: ["fixture"] };
      },
    );

    const originalFinish = Reflect.get(
      PluginInstallRuntimeBatch.prototype,
      "finish",
    ) as PluginInstallRuntimeBatch["finish"];
    const finishSpy =
      outcome === "zero-target-reuse-owner-replaced"
        ? vi
            .spyOn(PluginInstallRuntimeBatch.prototype, "finish")
            .mockImplementation(async function (this: PluginInstallRuntimeBatch, warn) {
              const application = await originalFinish.call(this, warn);
              await replaceFixture();
              return application;
            })
        : undefined;

    const gatewayOutcome = await applyClawUpdateForGateway({
      agentId: "worker",
      source: { packageName: "@acme/worker", version: "2.0.0" },
      planIntegrity: "sha256:reviewed",
      getRuntimeConfig: () => config,
      policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
      assertCurrent: () => {},
      reloadPlugins,
    }).finally(() => finishSpy?.mockRestore());
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(reloadPlugins).toHaveBeenCalledTimes(
      outcome === "lease-finalizer-rejected" || outcome === "zero-target-reuse-owner-replaced"
        ? 0
        : 1,
    );
    expect(gatewayOutcome).toMatchObject({
      status: outcome === "complete" ? "complete" : "partial",
      ...(outcome === "complete" ? {} : { error: { code: "update_outcome_uncertain" } }),
    });
    expect(continueMutation).toHaveBeenCalledTimes(outcome === "complete" ? 1 : 0);
    expect(failRuntime).toHaveBeenCalledTimes(
      outcome === "stage-rejected" || outcome === "complete" ? 0 : 1,
    );
    if (outcome === "lease-finalizer-rejected") {
      expect(failRuntime.mock.calls[0]?.[0]).toMatchObject({
        message: "Plugin cache resources failed to retire",
        errors: [expect.objectContaining({ message: "Plugin cache finalizer failed" })],
      });
    }
    if (outcome === "owner-replaced" || outcome === "zero-target-reuse-owner-replaced") {
      expect(failRuntime.mock.calls[0]?.[0]).toMatchObject({
        message: expect.stringContaining("installed owner changed"),
      });
    }
    if (
      outcome === "plugin-disabled-at-commit" ||
      outcome === "plugin-disabled-after-reload-commit"
    ) {
      expect(failRuntime.mock.calls[0]?.[0]).toMatchObject({
        message: expect.stringContaining("no longer enabled"),
      });
    }
  });
});
