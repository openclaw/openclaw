import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import { createOnboardTestConfigStore } from "./onboard-non-interactive.test-helpers.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const { configStore, readSnapshot, resolveConfigPath: configPath } = createOnboardTestConfigStore();
const ensureWorkspaceAndSessions = vi.hoisted(() => vi.fn(async () => {}));
const provider = vi.hoisted(() => ({
  id: "hermes",
  label: "Hermes",
  description: "Hermes migration provider",
  plan: vi.fn(),
  apply: vi.fn(),
}));

function withSummary<T extends Pick<MigrationPlan, "items">>(plan: T) {
  return { ...plan, summary: summarizeMigrationItems(plan.items) };
}

// mock-isolation: Read only this test's in-memory config store, never the operator's config.
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: async () => readSnapshot(),
}));

vi.mock("../config/config.js", () => ({
  ConfigMutationConflictError: class ConfigMutationConflictError extends Error {},
  replaceConfigFile: async ({ sourceConfig }: { sourceConfig: OpenClawConfig }) => {
    configStore.set(configPath(), structuredClone(sourceConfig));
    return { nextConfig: sourceConfig };
  },
  resolveGatewayPort: (config: OpenClawConfig) => config.gateway?.port ?? 18789,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions,
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run([provider]),
}));

import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

afterEach(() => {
  vi.unstubAllEnvs();
  configStore.clear();
  [ensureWorkspaceAndSessions, provider.plan, provider.apply].forEach((mock) => mock.mockReset());
});

it("stages, promotes, and acknowledges an explicit import", async () => {
  const stateDir = tempRoots.make("openclaw-noninteractive-migration-");
  const source = path.join(stateDir, "hermes-home");
  const workspace = path.join(stateDir, "workspace");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "AGENTS.md"), "Imported agents.\n", "utf8");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

  provider.plan.mockImplementation(async (ctx): Promise<MigrationPlan> => {
    expect(ctx.config.agents?.defaults?.workspace).toBe(workspace);
    const target = path.join(workspace, "AGENTS.md");
    const items: MigrationPlan["items"] = [
      {
        id: "workspace:AGENTS.md",
        kind: "workspace",
        action: "copy",
        status: "planned",
        source: path.join(source, "AGENTS.md"),
        target,
      },
    ];
    return withSummary({ providerId: "hermes", source, target: workspace, items });
  });
  provider.apply.mockImplementation(async (ctx, plan): Promise<MigrationApplyResult> => {
    const item = plan?.items[0];
    if (!plan || !item?.source || !item.target) {
      throw new Error("missing migration plan item");
    }
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await fs.copyFile(item.source, item.target);
    const items = [{ ...item, status: "migrated" as const }];
    return withSummary({ ...plan, items, reportDir: ctx.reportDir });
  });

  await runNonInteractiveSetup(
    {
      nonInteractive: true,
      workspace,
      importFrom: "hermes",
      importSource: source,
    },
    createThrowingTestRuntime(),
  );

  expect(provider.plan).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source, includeSecrets: false, overwrite: false }),
  );
  expect(provider.apply).toHaveBeenCalledOnce();
  const [applyContext, stagedPlan] = provider.apply.mock.calls[0] ?? [];
  expect(applyContext).toMatchObject({
    source,
    reportDir: expect.stringContaining(".openclaw-migration-state-"),
  });
  expect(stagedPlan?.items[0]?.target).toContain(".openclaw-migration-workspace-");
  expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Imported agents.\n");
  expect(configStore.get(configPath())?.agents?.defaults?.workspace).toBe(workspace);
  const [reportDir] = await fs.readdir(path.join(stateDir, "migration", "hermes"));
  await expect(
    fs.access(path.join(stateDir, "migration", "hermes", reportDir!, "onboarding-promotion.json")),
  ).rejects.toThrow();
  expect(ensureWorkspaceAndSessions).not.toHaveBeenCalled();
});
