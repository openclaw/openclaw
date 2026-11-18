import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it as baseIt, vi } from "vitest";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSetupWizard } from "../wizard/setup.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import { setupCommand } from "./setup.js";
import { makePrompter, makeRuntime } from "./setup/__tests__/test-utils.js";

const it = baseIt.extend<{ home: string }>({
  home: ({ task: _task }, use) =>
    withDoctorConfigPreflightHome((home) =>
      withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => use(home)),
    ),
});

const repairOptions = {
  observe: false,
  invocationPurpose: "doctor",
  repairPrefixedConfig: true,
  doctorOnlyStateMigrations: true,
  preparePluginMetadataSnapshot: true,
} as const;

async function damageState(databasePath: string, sql: string) {
  await closeOpenClawStateDatabaseAsync();
  using database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA foreign_keys=OFF; ${sql}`);
}

it.for([
  ["state-schema", "INSERT INTO task_delivery_state(task_id) VALUES('missing-task')", false],
  [
    "legacy-state-migrations",
    `INSERT INTO workspace_generated_bootstrap_hashes
            (workspace_key,filename,sha256) VALUES('missing-workspace','fixture.md','fixture-hash')`,
    true,
  ],
] as const)(
  "preserves plugin obligations after damage at %s",
  async ([phase, sql, refuses], { home }) => {
    const workspace = path.join(home, ".openclaw", "workspace");
    await writeOpenClawConfig(home, {
      gateway: { mode: "local" },
      agents: { ownership: "explicit", defaults: { workspace }, entries: { main: {} } },
      plugins: { entries: { "missing-preparation-fixture": { enabled: true } } },
    });
    await fs.mkdir(workspace, { recursive: true });
    const databasePath = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();

    let injected = false;
    const operation = runDoctorConfigPreflight({
      ...repairOptions,
      measure: async (name, run) => {
        if (!injected && name === `doctor.config-preflight.${phase}`) {
          await damageState(databasePath, sql);
          injected = true;
        }
        return await run();
      },
    });
    if (refuses) {
      await expect(operation).rejects.toThrow(/foreign_key_check|state migration refused/);
    } else {
      await operation;
      const { db } = openOpenClawStateDatabase();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    expect(injected).toBe(true);
    using inspected = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      inspected
        .prepare(
          "SELECT id FROM migration_runs WHERE id LIKE 'deferred-plugin-migration:%' AND status='pending'",
        )
        .all(),
    ).toEqual([{ id: "deferred-plugin-migration:missing-preparation-fixture" }]);
    if (refuses) {
      expect(inspected.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        inspected.prepare("SELECT workspace_key FROM workspace_generated_bootstrap_hashes").all(),
      ).toEqual([{ workspace_key: "missing-workspace" }]);
    }
  },
);

it("points failed setup to a repair that works without a terminal", async ({ home }) => {
  const repairHint =
    "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.";
  const ttyMock = createCliTtyMock([process.stdin]);
  ttyMock.set(false);
  try {
    const workspace = path.join(home, "workspace");
    const configPath = await writeOpenClawConfig(home, {
      agents: {
        defaults: { skipBootstrap: true, systemAgent: { agentId: "main" } },
        entries: { main: { workspace } },
      },
      browser: { enabled: false, actionTimeoutTypoMs: 5000 },
      gateway: { mode: "local" },
      logging: { level: "info", file: path.join(home, "doctor.log") },
      plugins: { enabled: false },
    });
    const original = await fs.readFile(configPath, "utf8");

    const baseline = makeRuntime();
    await expect(setupCommand({ json: true }, baseline)).rejects.toThrow("exit:1");
    const nonInteractive = makeRuntime();
    await expect(
      runNonInteractiveSetup(
        { nonInteractive: true, acceptRisk: true, json: true },
        nonInteractive,
      ),
    ).rejects.toThrow("exit:1");
    const prompter = makePrompter({
      select: vi.fn(async () => {
        throw new Error("Invalid config must stop before setup prompts");
      }),
    });
    await expect(runSetupWizard({ acceptRisk: true }, makeRuntime(), prompter)).rejects.toThrow(
      "exit:1",
    );
    expect(prompter.select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith(repairHint);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);

    await using guided = await prepareDoctorContext(configPath, { options: {} });
    expect(guided.prompter.repairMode.nonInteractive).toBe(true);
    await runInitialConfigWriteHealth(guided);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);

    await using repair = await prepareDoctorContext(configPath, { options: { repair: true } });
    await runInitialConfigWriteHealth(repair);
    const repaired = await readConfigFileSnapshot();
    expect(repaired.valid).toBe(true);
    expect(repaired.config.browser).toEqual({ enabled: false });
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);

    const retry = makeRuntime();
    await setupCommand({ json: true }, retry);
    expect(retry.exit).not.toHaveBeenCalled();
    expect(retry.error).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(retry.log).mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      workspaceDir: workspace,
      configStatus: "unchanged",
    });

    expect(baseline.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(nonInteractive.error).toHaveBeenCalledWith(repairHint);
  } finally {
    ttyMock.restore();
  }
}, 30_000);
