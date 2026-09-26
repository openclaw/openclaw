import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-record-state.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { runExec } from "../../process/exec.js";
// Register shared mocks before the tested runtime modules are imported.
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

installUpdateLeaseHarness();

describe("update resume completion ownership", () => {
  it.each(
    [false, true].flatMap((changed) =>
      [false, true].map((parentOwnsCompletion) => ({ changed, parentOwnsCompletion })),
    ),
  )(
    "resume honors completion ownership before its result (parent=$parentOwnsCompletion, changed=$changed)",
    async ({ changed, parentOwnsCompletion }) => {
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
        return { ...pluginResult, changed };
      });

      await invoke("resume");

      expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
        status: "ok",
        changed,
      });
      expect(await events()).toEqual(
        parentOwnsCompletion
          ? []
          : [
              "post-attempt",
              "post-acquired",
              ...(changed ? ["post-attempt", "post-acquired"] : []),
              "validate",
              "readiness",
            ],
      );
      if (!parentOwnsCompletion) {
        expectDoctorDiagnostics();
      }
      const probe = await runExec(process.execPath, [entrypoint, "probe"], { timeoutMs: 15_000 });
      expect(probe.stdout).toBe("acquired");
    },
  );

  it.each([
    { changed: false, pluginError: false },
    { changed: true, pluginError: false },
    { changed: true, pluginError: true },
  ])(
    "legacy resume preserves Doctor warnings without replacing plugin failure (changed=$changed, error=$pluginError)",
    async ({ changed, pluginError }) => {
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
        status: pluginError ? "error" : "ok",
        ...(pluginError ? { reason: "plugin-fixture-failure" } : {}),
        warnings: [pluginWarning],
        changed,
      });

      await invoke("resume");

      expect(reportedResult("resume")).toMatchObject({
        status: pluginError ? "error" : "warning",
        ...(pluginError ? { reason: "plugin-fixture-failure" } : {}),
        warnings: [
          pluginWarning,
          {
            reason: "doctor-advisory",
            message: beforeWarning.trim(),
            guidance: ["Run `openclaw doctor --fix` after repairing the plugin."],
          },
          ...(changed && !pluginError
            ? [
                {
                  reason: "doctor-advisory",
                  message: afterWarning,
                  guidance: ["Run `openclaw doctor --fix` after repairing the plugin."],
                },
              ]
            : []),
        ],
      });
      expect(await events()).toEqual([
        "post-attempt",
        "post-acquired",
        ...(changed && !pluginError ? ["post-attempt", "post-acquired"] : []),
        ...(!pluginError ? ["validate", "readiness"] : []),
      ]);
      expect(mocks.restart).not.toHaveBeenCalled();
      expectDoctorDiagnostics();
    },
  );

  it.each([false, true])(
    "resume reads the parent migration owner's committed generation (empty=%s)",
    async (empty) => {
      const old = { old: { source: "path" as const } };
      await seedInstalledPluginIndex(old);
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual(old);
      const recordsPath = await state.writeJson("forwarded.json", old);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH", recordsPath);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS", String(Date.now()));
      const current: Record<string, PluginInstallRecord> = empty
        ? {}
        : { current: { source: "path" } };
      await state.writeConfig({ plugins: { enabled: false }, gateway: { port: 19003 } });
      await seedInstalledPluginIndex(current);
      await writeScenario("resume");
      await invoke("resume");
      expectSuccess("resume", false);
      expect(mocks.plugins).toHaveBeenCalledWith(
        expect.objectContaining({
          configSnapshot: expect.objectContaining({
            config: expect.objectContaining({ gateway: expect.objectContaining({ port: 19003 }) }),
          }),
          pluginInstallRecords: current,
        }),
      );
      expect(await events()).toEqual([]);
    },
  );

  it("legacy resume repairs Doctor-only node state before plugins even when config is current", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    await writeScenario("resume", { runDoctorConfigFlow: true });
    await fs.rm(state.path("handoff.json"));
    await state.writeConfig({
      gateway: { mode: "local", auth: { mode: "none" } },
      agents: { entries: { main: {} } },
      plugins: { enabled: false },
    });
    const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    expect(snapshot.valid).toBe(true);
    expect(snapshot.legacyIssues).toEqual([]);
    expect(snapshot.sourceConfig).not.toHaveProperty("plugins.installs");
    const originalConfig = await fs.readFile(state.configPath, "utf8");
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
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${sourcePath}.doctor-importing`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await loadNodeHostConfig()).toStrictEqual({ ...node, installedAppsSharing: false });
      return { ...pluginResult, changed: false };
    });

    await invoke("resume");

    expectSuccess("resume");
    expect(mocks.plugins).toHaveBeenCalledOnce();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
    expect(await events()).toEqual(["post-attempt", "post-acquired", "validate", "readiness"]);
  }, 60_000);

  it.each([false, true])(
    "resume repairs an old parent's restored config before unchanged plugins (metadata=%s)",
    async (metadata) => {
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", metadata ? "1" : undefined);
      vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", undefined);
      vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", undefined);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      await writeScenario("resume", { runDoctorConfigFlow: true });
      await fs.rm(state.path("handoff.json"));
      const canonical = { source: "path" as const, installPath: state.path("canonical") };
      const legacy = { source: "path" as const, installPath: state.path("legacy") };
      const config = {
        gateway: { mode: "local", auth: { mode: "none" } },
        agents: { entries: { main: {} } },
        plugins: { enabled: false },
      } as const;
      await seedInstalledPluginIndex({ existing: canonical }, { config });
      await state.writeConfig({
        ...config,
        ...(metadata ? { meta: { lastTouchedAt: "2026-03-31T00:00:00.000Z" } } : {}),
        plugins: { ...config.plugins, installs: { existing: legacy, imported: legacy } },
      });
      const original = await fs.readFile(state.configPath, "utf8");
      const expectedRecords = { existing: canonical, imported: legacy };
      mocks.plugins.mockImplementation(async ({ configSnapshot, pluginInstallRecords }) => {
        expect(configSnapshot.valid).toBe(true);
        expect(configSnapshot.sourceConfig).not.toHaveProperty("plugins.installs");
        expect(configSnapshot.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(pluginInstallRecords).toEqual(expectedRecords);
        return { ...pluginResult, changed: false };
      });

      await invoke("resume");

      expectSuccess("resume", false);
      expect(await fs.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
      expect(
        JSON.parse(
          readPersistedInstalledPluginIndexRowSync({ stateDir: state.stateDir })!.value_json,
        ).index.installRecords,
      ).toEqual(expectedRecords);
      const saved = await fs.readFile(state.configPath, "utf8");
      const firstEvents = await events();
      expect(firstEvents).toEqual(["post-attempt", "post-acquired", "validate", "readiness"]);
      expect(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBeUndefined();

      await invoke("resume");

      expect(await fs.readFile(state.configPath, "utf8")).toBe(saved);
      expect(await fs.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
      expect(await events()).toEqual([
        ...firstEvents,
        "post-attempt",
        "post-acquired",
        "validate",
        "readiness",
      ]);
    },
    60_000,
  );
});
