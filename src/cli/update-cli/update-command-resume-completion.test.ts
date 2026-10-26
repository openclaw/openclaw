import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  formatDeferredPluginMigration,
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "../../infra/deferred-plugin-migrations.js";
import { listUpdateRuns } from "../../infra/update-run-reader.js";
import { updateRunWarningMessages } from "../../infra/update-run-step.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  seedInstalledPluginIndex,
} from "../../plugins/test-helpers/installed-plugin-index.js";
import { runExec } from "../../process/exec.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { registerUpdateCli } from "../update-cli.js";
import { expectMissing } from "./update-boundary.test-support.js";
import {
  entrypoint,
  events,
  expectDoctorDiagnostics,
  expectSuccess,
  installUpdateLeaseHarness,
  invoke,
  mocks,
  pluginResult,
  reportedResult,
  state,
  writeScenario,
} from "./update-command-lease.test-harness.js";

await vi.hoisted(async () => {
  await import("./update-command-lease.test-harness.js");
});

installUpdateLeaseHarness();

const readyEvents = ["post-attempt", "post-acquired", "validate", "readiness"];
const unchangedPluginResult = () => ({ ...pluginResult, changed: false });
const readConfig = (suffix = "") => fs.readFile(`${state.configPath}${suffix}`, "utf8");
const localConfig = {
  gateway: { mode: "local", auth: { mode: "none" } },
  agents: { entries: { main: {} } },
  plugins: { enabled: false },
} as const;
const deferredCompletions = () =>
  executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
    type: "plugins.deferredMigrations.completions.read",
    input: undefined,
  });

async function legacyResume(metadata?: boolean) {
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
  if (metadata !== undefined) {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", metadata ? "1" : undefined);
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", undefined);
  }
  vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  await writeScenario("resume", { runDoctorConfigFlow: true });
  await fs.rm(state.path("handoff.json"));
}

describe("update completion ownership", () => {
  it.each([false, true])(
    "reconciles a delayed Doctor warning against current pending state (pending again=%s)",
    async (pendingAgain) => {
      const pending = {
        pluginId: "acpx",
        reason: "The installed plugin has not confirmed its saved data and settings.",
        command: "openclaw doctor --fix",
      };
      const swapWarning = formatDeferredPluginMigration(pending, {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      });
      const finalPassWarning = formatDeferredPluginMigration(pending, {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      });
      await recordDeferredPluginMigrations({ pending: [pending] });
      await writeScenario("repair", {
        doctorWarningsByInvocation: [[swapWarning], [finalPassWarning]],
        completeDeferredPluginMigration: pending.pluginId,
      });
      mocks.plugins.mockImplementationOnce(async () => {
        // The child completed the migration before its buffered warning reached the parent.
        expect(await readDeferredPluginMigrationsAsync()).toEqual([]);
        expect(await deferredCompletions()).toEqual([
          expect.objectContaining({ pluginId: pending.pluginId }),
        ]);
        if (pendingAgain) {
          await recordDeferredPluginMigrations({ pending: [pending] });
        }
        return unchangedPluginResult();
      });

      await invoke("repair");

      expect(reportedResult("repair")).toMatchObject({
        status: pendingAgain ? "warning" : "ok",
      });
      expect(reportedResult("repair")).toHaveProperty("postUpdate.doctor", { status: "ok" });
      if (pendingAgain) {
        expect(reportedResult("repair")).toHaveProperty("postUpdate.plugins.warnings", [
          expect.objectContaining({ pluginId: pending.pluginId, message: finalPassWarning }),
        ]);
      }
      const [run] = listUpdateRuns();
      expect(run).toMatchObject({ status: "succeeded" });
      const expectedWarnings = pendingAgain ? [finalPassWarning] : [];
      expect(updateRunWarningMessages(run?.steps ?? [])).toEqual(expectedWarnings);
    },
  );

  it("repair completes deferred migrations after unchanged plugin convergence", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const pluginId = "repair-convergence";
    const pluginRoot = `extensions/${pluginId}`;
    const reason =
      "Package convergence must wait until the updating parent releases its install records.";
    await state.writeJson(`${pluginRoot}/package.json`, {
      name: pluginId,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    });
    await state.writeJson(`${pluginRoot}/openclaw.plugin.json`, {
      id: pluginId,
      activation: { onStartup: true },
      doctorContract: { stateMigrations: [] },
      configSchema: { type: "object", additionalProperties: false },
    });
    await state.writeText(
      `${pluginRoot}/doctor-contract-api.js`,
      "export const stateMigrations = [];\n",
    );
    await state.writeText(
      `${pluginRoot}/index.js`,
      `export default { id: "${pluginId}", register() {} };\n`,
    );
    await state.writeConfig({
      ...localConfig,
      plugins: {
        allow: [pluginId],
        load: { paths: [state.statePath(pluginRoot)] },
        entries: { [pluginId]: { enabled: true } },
      },
    });
    await writeScenario("repair", {
      runDoctorConfigFlow: true,
      verifyRepairOwner: true,
      doctorWarningsByInvocation: [
        [formatDeferredPluginMigration({ pluginId, reason, command: "openclaw update repair" })],
        [],
      ],
    });
    mocks.plugins.mockImplementationOnce(async () => {
      expect(await readDeferredPluginMigrationsAsync()).toEqual([
        expect.objectContaining({ pluginId, reason }),
      ]);
      return unchangedPluginResult();
    });

    await runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--no-restart", "--json"],
    });

    expect(await readDeferredPluginMigrationsAsync()).toEqual([]);
    expect(await deferredCompletions()).toEqual([expect.objectContaining({ pluginId })]);
    expect(JSON.stringify(reportedResult("repair"))).not.toContain(
      "data/settings upgrade is unfinished",
    );
    expectSuccess("repair");
    expect(await events()).toEqual(["pre-attempt", "pre-acquired", ...readyEvents]);
  });

  it.each([false, true])(
    "resume honors completion ownership before its changed result (parent=%s)",
    async (parentOwnsCompletion) => {
      await writeScenario("resume");
      if (!parentOwnsCompletion) {
        await fs.rm(state.path("handoff.json"));
      }
      const resultPath = state.path("legacy-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      mocks.plugins.mockImplementationOnce(async () => {
        expect(await events()).toEqual(
          parentOwnsCompletion ? [] : ["post-attempt", "post-acquired"],
        );
        expect(await fs.stat(resultPath).catch(() => null)).toBeNull();
        return { ...pluginResult, changed: true };
      });

      await invoke("resume");

      expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
        status: "ok",
        changed: true,
      });
      expect(await events()).toEqual(
        parentOwnsCompletion ? [] : ["post-attempt", "post-acquired", ...readyEvents],
      );
      if (!parentOwnsCompletion) {
        expectDoctorDiagnostics();
      }
      const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(probe.stdout).toBe("acquired");
    },
  );

  it("legacy resume preserves Doctor warnings without replacing plugin failure", async () => {
    const beforeWarning = "  Doctor retained optional legacy data.  ";
    const afterWarning = "Doctor retained a plugin notice.";
    const pluginWarning = {
      reason: "existing-plugin-warning",
      message: "Plugin convergence diagnostic.",
      guidance: [],
    };
    await writeScenario("resume", {
      doctorWarningsByInvocation: [[beforeWarning, " "], [afterWarning]],
    });
    await fs.rm(state.path("handoff.json"));
    mocks.plugins.mockResolvedValueOnce({
      ...pluginResult,
      status: "error",
      reason: "plugin-fixture-failure",
      warnings: [pluginWarning],
      changed: true,
    });

    await invoke("resume");

    expect(reportedResult("resume")).toMatchObject({
      status: "error",
      reason: "plugin-fixture-failure",
      warnings: [
        pluginWarning,
        {
          reason: "doctor-advisory",
          message: beforeWarning.trim(),
          guidance: ["Run `openclaw doctor --fix` after repairing the plugin."],
        },
      ],
    });
    expect(await events()).toEqual(["post-attempt", "post-acquired"]);
    expect(mocks.restart).not.toHaveBeenCalled();
    expectDoctorDiagnostics();
  });

  it("legacy resume repairs Doctor-only node state before plugins even when config is current", async () => {
    await legacyResume();
    await state.writeConfig({
      ...localConfig,
      messages: { queue: { allowCollaborativeSteering: false } },
    });
    const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    expect(snapshot).toMatchObject({ valid: true, legacyIssues: [] });
    expect(snapshot.sourceConfig).not.toHaveProperty("plugins.installs");
    const originalConfig = await readConfig();
    const node = {
      version: 1,
      nodeId: "published-node",
      displayName: "Published node",
      gateway: {
        host: "gateway.example.test",
        port: 443,
        tls: true,
        tlsFingerprint: "fixture-fingerprint",
        contextPath: "/gateway",
      },
    } as const;
    const sourcePath = await state.writeJson("node.json", node);
    await expect(loadNodeHostConfig()).rejects.toThrow("retired node-host state remains");
    mocks.plugins.mockImplementation(async ({ configSnapshot }) => {
      expect(configSnapshot.valid).toBe(true);
      expect(await readConfig()).toBe(originalConfig);
      await expectMissing(sourcePath);
      await expectMissing(`${sourcePath}.doctor-importing`);
      expect(await loadNodeHostConfig()).toStrictEqual({ ...node, installedAppsSharing: false });
      return unchangedPluginResult();
    });

    await invoke("resume");

    expectSuccess("resume");
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(await readConfig()).toBe(originalConfig);
    expect(await events()).toEqual(readyEvents);
  }, 60_000);

  it.each([false, true])(
    "resume repairs an old parent's restored config before unchanged plugins (metadata=%s)",
    async (metadata) => {
      await legacyResume(metadata);
      const canonical = { source: "path" as const, installPath: state.path("canonical") };
      await seedInstalledPluginIndex({ existing: canonical }, { config: localConfig });
      await state.writeConfig({
        ...localConfig,
        ...(metadata ? { meta: { lastTouchedAt: "2026-07-02T00:00:00.000Z" } } : {}),
        agents: { list: [{ id: "main" }] },
      });
      const original = await readConfig();
      const expectedRecords = { existing: canonical };
      mocks.plugins.mockImplementation(async ({ configSnapshot, pluginInstallRecords }) => {
        expect(configSnapshot.valid).toBe(true);
        expect(configSnapshot.sourceConfig).not.toHaveProperty("agents.list");
        expect(configSnapshot.sourceConfig).toHaveProperty("agents.entries.main");
        expect(configSnapshot.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(pluginInstallRecords).toEqual(expectedRecords);
        return unchangedPluginResult();
      });

      await invoke("resume");

      expectSuccess("resume", false);
      expect(await readConfig(".bak")).toBe(original);
      const savedIndex = readPersistedInstalledPluginIndexRowSync({ stateDir: state.stateDir })!;
      expect(JSON.parse(savedIndex.value_json).index.installRecords).toEqual(expectedRecords);
      const saved = await readConfig();
      const firstEvents = await events();
      expect(firstEvents).toEqual(readyEvents);
      expect(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBeUndefined();

      await invoke("resume");

      expect(await readConfig()).toBe(saved);
      expect(await readConfig(".bak")).toBe(original);
      expect(await events()).toEqual([...firstEvents, ...readyEvents]);
    },
    60_000,
  );
});
