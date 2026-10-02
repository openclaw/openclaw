import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/claws.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { PluginInstallRuntimeBatch } from "../plugins/install-runtime-batch.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ClawHubClawTrust } from "./clawhub-source.js";
import { applyClawAddForGateway } from "./gateway-add-apply.js";
import type { ClawAddPlan, ClawReadResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  build: vi.fn(),
  project: vi.fn(),
  plansMatch: vi.fn(),
  configuredAccess: vi.fn(),
  stage: vi.fn(),
}));

vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
vi.mock("./gateway-add-plan.js", () => ({
  buildGatewayClawAddPlan: mocks.build,
  projectGatewayClawAddPlan: mocks.project,
}));
vi.mock("./gateway-plan-projection.js", () => ({ plansMatchAcrossSourceRoots: mocks.plansMatch }));
vi.mock("./gateway-disclosure.js", () => ({ projectClawConfiguredAccess: mocks.configuredAccess }));
vi.mock("./add.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./add.js")>()),
  stageClawAddHostRequirements: mocks.stage,
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const source = { source: { packageRoot: "/tmp/claw-source" } } as Extract<
  ClawReadResult,
  { ok: true }
>;
const persisted = { source: { packageRoot: "/tmp/claw-cache" } } as Extract<
  ClawReadResult,
  { ok: true }
>;
const trust: ClawHubClawTrust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean",
    clawhubTrustCheckedAt: "2026-10-02T00:00:00.000Z",
  },
};
const plan = {
  agent: { finalId: "workflow-operator", config: { id: "workflow-operator" } },
  blockers: [],
  actions: [
    {
      kind: "package",
      details: {
        kind: "plugin",
        source: "clawhub",
        ref: "@fixture/plugin",
        version: "1",
        integrity: `sha256:${"a".repeat(64)}`,
        ownerAction: "reuse",
        installId: "fixture",
      },
    },
  ],
  planIntegrity: "sha256:canonical",
} as unknown as ClawAddPlan;
const configuredAccess = {
  desired: { tools: { allowed: ["read"] } },
} as NonNullable<ClawLifecyclePlanResult["configuredAccess"]>;
const projection = {
  planIntegrity: "sha256:reviewed",
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  configuredAccess,
  readiness: { ready: true, requirements: [] },
} as unknown as ClawLifecyclePlanResult;
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockImplementation(
    async (input: {
      run: (
        artifact: typeof source,
        trust: ClawHubClawTrust,
        persistSource: () => Promise<typeof persisted>,
      ) => Promise<unknown>;
    }) => ({ value: await input.run(source, trust, async () => persisted) }),
  );
  mocks.build.mockResolvedValue(plan);
  mocks.project.mockReturnValue(projection);
  mocks.plansMatch.mockReturnValue(true);
  mocks.configuredAccess.mockReturnValue(configuredAccess);
});

async function fixture() {
  const root = dirs.make("gateway-claw-add-plugin-batch-");
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const index = createInstalledPluginIndex({
    plugins: [],
    installRecords: { fixture: { source: "path", installPath: root, version: "1" } },
  });
  writeConfigMachineState("plugins.installedIndex", { revision: 1, index }, { env });
  return { env, index };
}

describe("Gateway Claw Add plugin handoff", () => {
  it("uses migration policy committed while runtime activation waited for the plugin lease", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
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
      const continueAdd = vi.fn(async () => ({
        agent: { finalId: "workflow-operator" },
        status: "complete" as const,
      }));
      mocks.stage.mockImplementation(
        async (_plan: ClawAddPlan, options: { runtimeBatch: PluginInstallRuntimeBatch }) => {
          options.runtimeBatch.retain("fixture");
          return {
            kind: "ready",
            continue: continueAdd,
            failBeforeContinue: async (_error: unknown, code: string) => ({
              agent: { finalId: "workflow-operator" },
              status: "partial" as const,
              error: { code, message: "Runtime activation failed" },
            }),
          };
        },
      );
      const reloadPlugins = vi.fn(async (_targets, options) =>
        withPluginLifecycleLease({ env }, async () => {
          options?.commitGuard?.();
          return { operationId: "reload", generation: 3, pluginIds: ["fixture"] };
        }),
      );
      try {
        const result = await applyClawAddForGateway({
          source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
          planIntegrity: projection.planIntegrity,
          getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
          policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
          assertCurrent: () => {},
          reloadPlugins,
        });
        expect(migrationCommitted).toBe(true);
        expect(result).toMatchObject({ status: "complete" });
        expect(continueAdd).toHaveBeenCalledOnce();
      } finally {
        acquireSpy.mockRestore();
      }
    });
  });

  it("reproduces the real runtime batch refusal while any plugin lease is held", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
      const batch = new PluginInstallRuntimeBatch({ env }, vi.fn());
      await withPluginLifecycleLease({ env }, async (lease) => {
        await batch.prepare(lease);
        await expect(batch.finish(() => {})).rejects.toThrow(
          "Plugin batch was not prepared or its handoff already started",
        );
      });
      batch.close();
    });
  });

  it.each([
    "success",
    "stage-partial",
    "stage-partial-runtime-failure",
    "runtime-failure",
    "prepare-failure",
    "lease-finalizer-failure",
    "authority-lost",
    "policy-drift-at-commit",
    "owner-removed",
    "owner-replaced",
    "owner-reuse-removed",
    "plugin-disabled-reuse",
    "plugin-disabled-retained",
    "plugin-disabled-at-commit",
  ] as const)(
    "settles %s before workspace effects and resumes only after a fresh policy read",
    async (outcome) => {
      const { env, index } = await fixture();
      await withEnvAsync(env, async () => {
        const events: string[] = [];
        let authorityActive = true;
        const zeroTarget = outcome === "owner-reuse-removed" || outcome === "plugin-disabled-reuse";
        const disableAfterFinish =
          outcome === "plugin-disabled-reuse" || outcome === "plugin-disabled-retained";
        const continueAdd = vi.fn(
          async (options: {
            getCurrentConfig: () => OpenClawConfig;
            assertReviewedConfig: (config: OpenClawConfig) => void;
          }) => {
            events.push("continue");
            expect(hasPluginLifecycleLease()).toBe(true);
            const currentConfig = options.getCurrentConfig();
            expect(currentConfig.gateway?.controlUi?.experimental?.claws).toBe(true);
            options.assertReviewedConfig(currentConfig);
            return { agent: { finalId: "workflow-operator" }, status: "complete" };
          },
        );
        const failBeforeContinue = vi.fn(async (_error: unknown, code: string) => {
          events.push("fail");
          expect(hasPluginLifecycleLease()).toBe(false);
          return {
            agent: { finalId: "workflow-operator" },
            status: "partial",
            error: { code, message: "Runtime activation failed" },
          };
        });
        mocks.stage.mockImplementation(
          async (_plan: ClawAddPlan, options: { runtimeBatch: PluginInstallRuntimeBatch }) => {
            events.push("stage");
            expect(hasPluginLifecycleLease()).toBe(true);
            if (!zeroTarget) {
              options.runtimeBatch.retain(outcome === "prepare-failure" ? "missing" : "fixture");
            }
            if (outcome === "lease-finalizer-failure") {
              getPluginCache().instances.add({
                pluginId: "fixture",
                quiesce: () => true,
                dispose: async () => {
                  throw new Error("Plugin cache finalizer failed");
                },
              });
            }
            if (outcome.startsWith("stage-partial")) {
              return {
                kind: "partial",
                result: {
                  agent: { finalId: "workflow-operator" },
                  status: "partial",
                  error: { code: "package_install_failed", message: "Package installation failed" },
                },
              };
            }
            return { kind: "ready", continue: continueAdd, failBeforeContinue };
          },
        );
        const reloadPlugins = vi.fn(async (_targets, reloadOptions) => {
          events.push("reload");
          expect(hasPluginLifecycleLease()).toBe(true);
          if (outcome === "policy-drift-at-commit") {
            await fs.writeFile(
              env.OPENCLAW_CONFIG_PATH,
              JSON.stringify({ gateway: { controlUi: { experimental: { claws: false } } } }),
            );
            reloadOptions?.commitGuard?.();
          }
          if (outcome === "plugin-disabled-at-commit") {
            await fs.writeFile(
              env.OPENCLAW_CONFIG_PATH,
              JSON.stringify({ ...config, plugins: { entries: { fixture: { enabled: false } } } }),
            );
            reloadOptions?.commitGuard?.();
          }
          if (outcome === "runtime-failure" || outcome === "stage-partial-runtime-failure") {
            throw new Error("Runtime activation failed");
          }
          if (outcome === "authority-lost") {
            authorityActive = false;
          }
          return { operationId: "reload", generation: 2, pluginIds: ["fixture"] };
        });

        const finish = Reflect.get(
          PluginInstallRuntimeBatch.prototype,
          "finish",
        ) as PluginInstallRuntimeBatch["finish"];
        const finishSpy =
          outcome === "owner-removed" ||
          outcome === "owner-replaced" ||
          outcome === "owner-reuse-removed" ||
          disableAfterFinish
            ? vi
                .spyOn(PluginInstallRuntimeBatch.prototype, "finish")
                .mockImplementation(async function (this: PluginInstallRuntimeBatch, warn) {
                  const application = await finish.call(this, warn);
                  if (disableAfterFinish) {
                    await fs.writeFile(
                      env.OPENCLAW_CONFIG_PATH,
                      JSON.stringify({
                        ...config,
                        plugins: { entries: { fixture: { enabled: false } } },
                      }),
                    );
                    return application;
                  }
                  const fixtureRecord = index.installRecords.fixture;
                  if (!fixtureRecord) {
                    throw new Error("Fixture plugin install record is missing");
                  }
                  const replacement: typeof index.installRecords =
                    outcome === "owner-removed" || outcome === "owner-reuse-removed"
                      ? {}
                      : {
                          fixture: {
                            ...fixtureRecord,
                            installedAt: "2026-10-02T03:00:00.000Z",
                          },
                        };
                  writeConfigMachineState(
                    "plugins.installedIndex",
                    {
                      revision: 2,
                      index: createInstalledPluginIndex({
                        plugins: [],
                        installRecords: replacement,
                      }),
                    },
                    { env },
                  );
                  return application;
                })
            : undefined;

        const result = await applyClawAddForGateway({
          source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
          planIntegrity: projection.planIntegrity,
          getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
          policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
          assertCurrent: () => {
            if (!authorityActive) {
              throw new Error("Gateway Add authority ended");
            }
          },
          reloadPlugins,
        }).finally(() => finishSpy?.mockRestore());

        if (outcome === "success") {
          expect(events).toEqual(["stage", "reload", "continue"]);
          expect(result).toMatchObject({ status: "complete" });
          expect(continueAdd).toHaveBeenCalledOnce();
          expect(failBeforeContinue).not.toHaveBeenCalled();
        } else if (outcome.startsWith("stage-partial")) {
          expect(events).toEqual(["stage", "reload"]);
          expect(result).toMatchObject({
            status: "partial",
            error: {
              code:
                outcome === "stage-partial-runtime-failure"
                  ? "package_runtime_failed"
                  : "package_install_failed",
            },
          });
          if (outcome === "stage-partial-runtime-failure") {
            expect(result.error?.message).toContain("package_install_failed");
            expect(result.error?.message).toContain("runtime activation failed");
          }
          expect(continueAdd).not.toHaveBeenCalled();
          expect(failBeforeContinue).not.toHaveBeenCalled();
        } else {
          expect(events).toEqual(
            outcome === "prepare-failure" || outcome === "lease-finalizer-failure" || zeroTarget
              ? ["stage", "fail"]
              : ["stage", "reload", "fail"],
          );
          expect(result).toMatchObject({
            status: "partial",
            error: {
              code:
                outcome === "authority-lost" || outcome.startsWith("owner-") || disableAfterFinish
                  ? "policy_recheck_failed"
                  : "package_runtime_failed",
            },
          });
          expect(continueAdd).not.toHaveBeenCalled();
          expect(failBeforeContinue).toHaveBeenCalledOnce();
        }
        expect(reloadPlugins).toHaveBeenCalledTimes(
          outcome === "prepare-failure" || outcome === "lease-finalizer-failure" || zeroTarget
            ? 0
            : 1,
        );
      });
    },
  );
});
