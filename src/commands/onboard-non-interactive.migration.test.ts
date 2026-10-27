import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const provider = vi.hoisted(() => ({
  id: "hermes",
  label: "Hermes",
  plan: vi.fn(),
  apply: vi.fn(),
}));

function withSummary<T extends Pick<MigrationPlan, "items">>(plan: T) {
  return { ...plan, summary: summarizeMigrationItems(plan.items) };
}

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run([provider]),
}));

import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

afterEach(() => [provider.plan, provider.apply].forEach((mock) => mock.mockReset()));

it("stages, promotes, and acknowledges an explicit import", async () => {
  await withOpenClawTestState({ prefix: "openclaw-noninteractive-migration-" }, async (state) => {
    const { stateDir, configPath } = state;
    const source = path.join(stateDir, "hermes-home");
    const workspace = path.join(stateDir, "workspace");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "AGENTS.md"), "Imported agents.\n", "utf8");

    provider.plan.mockImplementation(async (): Promise<MigrationPlan> => {
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
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("Imported agents.\n");
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).agents.defaults.workspace).toBe(
      workspace,
    );
    const [reportDir] = await fs.readdir(path.join(stateDir, "migration", "hermes"));
    await expect(
      fs.access(
        path.join(stateDir, "migration", "hermes", reportDir!, "onboarding-promotion.json"),
      ),
    ).rejects.toThrow();
  });
});
