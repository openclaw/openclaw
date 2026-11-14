import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as leaseAcquisition from "../state/openclaw-state-lease-acquisition.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { StatelessTemplateAddOptions } from "./add-stateless.js";
import type { ClawHubTemplateTrust } from "./clawhub-source.js";
import { applyTemplateAddForGateway } from "./gateway-add-apply.js";
import type { TemplateAddPlan, TemplateReadResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  build: vi.fn(),
  project: vi.fn(),
  plansMatch: vi.fn(),
  configuredAccess: vi.fn(),
  apply: vi.fn(),
}));

// mock-isolation: The batch test supplies a fixed Template source instead of fetching one.
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
// mock-isolation: Planning outputs are fixed so this suite can exercise batch application only.
vi.mock("./gateway-add-plan.js", () => ({
  buildGatewayTemplateAddPlan: mocks.build,
  projectGatewayTemplateAddPlan: mocks.project,
}));
// mock-isolation: Source-root comparison is controlled while testing batch ownership.
vi.mock("./gateway-plan-projection.js", () => ({ plansMatchAcrossSourceRoots: mocks.plansMatch }));
// mock-isolation: Configured-access disclosure is a fixed input to the batch scenario.
vi.mock("./gateway-disclosure.js", () => ({
  projectTemplateConfiguredAccess: mocks.configuredAccess,
}));
// mock-isolation: Staging is a fixture; the real mutation would alter shared plugin state.
vi.mock("./add-stateless.js", () => ({ applyTemplateAddPlanStateless: mocks.apply }));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const source = {
  manifest: { agent: { id: "workflow-operator" } },
  source: { packageRoot: "/tmp/template-source" },
} as Extract<TemplateReadResult, { ok: true }>;
const persisted = { source: { packageRoot: "/tmp/template-cache" } } as Extract<
  TemplateReadResult,
  { ok: true }
>;
const trust: ClawHubTemplateTrust = {
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
} as unknown as TemplateAddPlan;
const configuredAccess = {
  desired: { tools: { allowed: ["read"] } },
} as NonNullable<TemplateLifecyclePlanResult["configuredAccess"]>;
const projection = {
  planIntegrity: "sha256:reviewed",
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  configuredAccess,
  readiness: { ready: true, requirements: [] },
} as unknown as TemplateLifecyclePlanResult;
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { templates: true } } } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockImplementation(
    async (input: {
      run: (
        artifact: typeof source,
        trust: ClawHubTemplateTrust,
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
  const root = dirs.make("gateway-template-add-plugin-batch-");
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

describe("Gateway Template Add activation policy", () => {
  it("keeps deferred migration policy committed while activation waited for the plugin lease", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
      let pluginLeaseAcquisitions = 0;
      let migrationCommitted = false;
      const acquire = leaseAcquisition.acquireOpenClawStateLease;
      const acquireSpy = vi
        .spyOn(leaseAcquisition, "acquireOpenClawStateLease")
        .mockImplementation(async (params) => {
          if (params.label.includes("plugin lifecycle lease") && ++pluginLeaseAcquisitions === 2) {
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
          return await acquire(params);
        });
      mocks.configuredAccess.mockReturnValue({
        ...configuredAccess,
        current: configuredAccess.desired,
      });
      const activated = vi.fn();
      mocks.apply.mockImplementation(
        async (_plan: TemplateAddPlan, options: StatelessTemplateAddOptions) => {
          await options.reloadPlugins!([
            { pluginId: "fixture", installHash: "fixture-hash", sourceDigests: {} },
          ]);
          await options.prepareEffect?.();
          expect(options.getCurrentConfig?.()).toBeDefined();
          expect(JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH, "utf8"))).toMatchObject({
            legacyFixture: { value: "retained" },
          });
          return { agent: plan.agent, status: "complete" };
        },
      );
      try {
        const result = await applyTemplateAddForGateway({
          source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
          planIntegrity: projection.planIntegrity,
          getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
          policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
          assertCurrent() {},
          reloadPlugins: async (_targets, options) => {
            options?.commitGuard?.();
            activated();
            return { operationId: "reload", generation: 3, pluginIds: ["fixture"] };
          },
        });
        expect(migrationCommitted).toBe(true);
        expect(activated).toHaveBeenCalledOnce();
        expect(result.status).toBe("complete");
      } finally {
        acquireSpy.mockRestore();
      }
    });
  });

  it("refuses a plugin disabled at the actual runtime activation commit", async () => {
    const { env } = await fixture();
    await withEnvAsync(env, async () => {
      mocks.configuredAccess.mockReturnValue({
        ...configuredAccess,
        current: configuredAccess.desired,
      });
      const activated = vi.fn();
      mocks.apply.mockImplementation(
        async (_plan: TemplateAddPlan, options: StatelessTemplateAddOptions) => {
          await options.reloadPlugins!([
            { pluginId: "fixture", installHash: "fixture-hash", sourceDigests: {} },
          ]);
          return { agent: plan.agent, status: "complete" };
        },
      );
      await expect(
        applyTemplateAddForGateway({
          source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
          planIntegrity: projection.planIntegrity,
          getPlanningContext: async () => ({ config, sourceMcpServers: {} }),
          policyConfig: { configPath: env.OPENCLAW_CONFIG_PATH, env },
          assertCurrent() {},
          reloadPlugins: async (_targets, options) => {
            await fs.writeFile(
              env.OPENCLAW_CONFIG_PATH,
              JSON.stringify({ ...config, plugins: { entries: { fixture: { enabled: false } } } }),
            );
            options?.commitGuard?.();
            activated();
            return { operationId: "reload", generation: 3, pluginIds: ["fixture"] };
          },
        }),
      ).rejects.toThrow("no longer enabled");
      expect(activated).not.toHaveBeenCalled();
    });
  });
});
