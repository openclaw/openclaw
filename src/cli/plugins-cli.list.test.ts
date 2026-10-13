import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginStatusReport } from "../plugins/status.js";
import { createCompatibilityNotice, createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildPluginCompatibilityNoticesMock,
  withPluginDiagnosticsReportForInspectionMock,
  buildPluginRegistrySnapshotReportMock,
  inspectPluginRegistryMock,
  pluginCliConfigMock,
  loadPluginManifestRegistryMock,
  readConfigFileSnapshotMock,
  resetPluginsCliTestState,
  refreshPluginRegistryMock,
  runPluginsCommand,
  pluginsCliRuntimeLogs,
} from "./plugins-cli-test-helpers.js";

const cleanDoctorMessage =
  "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
  'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';
const originalExitCode = process.exitCode;

function configuredCodexRuntime(): OpenClawConfig {
  return {
    agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
  };
}

function mockDoctorReport(
  report: Partial<Pick<PluginStatusReport, "plugins" | "diagnostics">> = {},
) {
  withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
    formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
  );
}

async function doctor(...args: string[]) {
  await runPluginsCommand(["plugins", "doctor", ...args]);
  return pluginsCliRuntimeLogs.join("\n");
}

function mockPluginDoctorValidationWarnings(warnings: ConfigValidationIssue[]) {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["imessage", "memory-core"],
      entries: { google: { config: { apiKey: "test-google-key" } } },
    },
  };
  pluginCliConfigMock.mockReturnValue(config);
  readConfigFileSnapshotMock.mockResolvedValueOnce({
    ...createTestConfigSnapshot(config),
    warnings,
  });
  loadPluginManifestRegistryMock.mockReturnValue({
    plugins: ["google", "imessage", "memory-core"].map((id) =>
      createPluginManifestRecordFixture({
        id,
        rootDir: `/plugins/${id}`,
        source: `/plugins/${id}`,
      }),
    ),
    diagnostics: [],
  });
  mockDoctorReport({
    plugins: [createPluginRecord({ id: "google", enabled: false, status: "disabled" })],
  });
}

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("distinguishes plugin load errors from disabled reasons across list formats", async () => {
    const disabledReason = "workspace plugin (disabled by default)";
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [
        createPluginRecord({
          id: "broken",
          description: "Broken plugin description",
          status: "error",
          error: "missing plugin module",
        }),
        createPluginRecord({ id: "healthy", description: "Healthy plugin" }),
        createPluginRecord({ id: "cold", name: "Cold Display", description: "", imported: false }),
        createPluginRecord({
          id: "disabled",
          description: "Disabled plugin description",
          enabled: false,
          status: "disabled",
          error: disabledReason,
          activationReason: disabledReason,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list"]);

    const output = pluginsCliRuntimeLogs.join("\n");
    expect(output).toContain("missing plugin module");
    expect(output).toContain("Healthy plugin");
    expect(output).toContain("Disabled plugin description");
    expect(output).toContain("Cold Display");

    await runPluginsCommand(["plugins", "list", "--verbose"]);

    const verboseOutput = pluginsCliRuntimeLogs.at(-1) ?? "";
    expect(verboseOutput).toContain(`activation reason: ${disabledReason}`);
    expect(verboseOutput).not.toContain(`error: ${disabledReason}`);
    expect(verboseOutput).toContain("error: missing plugin module");
    expect(verboseOutput).toContain("Cold Display (cold) enabled");
    expect(verboseOutput).toContain("imported: no");
  });

  it.each([
    { label: "default", args: [], visibleError: true },
    { label: "enabled-only", args: ["--enabled"], visibleError: false },
  ])(
    "surfaces plugin discovery and stale-registry diagnostics in the $label list",
    async ({ args, visibleError }) => {
      const refreshMessage =
        "Persisted plugin registry is stale. Run `openclaw plugins registry --refresh`.";
      const dependencyError = "Plugin dependency example-package could not be resolved.";
      buildPluginRegistrySnapshotReportMock.mockReturnValue({
        workspaceDir: "/workspace",
        registrySource: "derived",
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "Persisted plugin registry is missing; using the derived index.",
          },
          {
            level: "warn",
            code: "persisted-registry-stale-source",
            message: refreshMessage,
          },
        ],
        plugins: [
          createPluginRecord({ id: "healthy", description: "Healthy plugin" }),
          createPluginRecord({
            id: "broken",
            enabled: visibleError,
            status: "error",
            error: dependencyError,
          }),
        ],
        diagnostics: [
          { level: "warn", message: "Duplicate plugin ID shadows an installed plugin." },
          { level: "error", message: "Plugin manifest could not be loaded." },
          { level: "error", pluginId: "broken", message: dependencyError },
        ],
      });

      await runPluginsCommand(["plugins", "list", ...args]);

      const output = pluginsCliRuntimeLogs.join("\n");
      expect(output).toContain("Warning: Duplicate plugin ID shadows an installed plugin.");
      expect(output).toContain("Error: Plugin manifest could not be loaded.");
      expect(output).toContain(`Warning: ${refreshMessage}`);
      expect(output).not.toContain("Persisted plugin registry is missing");
      expect(output.split(dependencyError)).toHaveLength(2);
      expect(output.includes(`Error: ${dependencyError}`)).toBe(!visibleError);
    },
  );

  it("publishes Doctor output and exit status only after cleanup", async () => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    process.exitCode = 7;
    withPluginDiagnosticsReportForInspectionMock.mockImplementation(
      async (_params, formatReport) => {
        const text = formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
        entered.resolve();
        await finish.promise;
        return text;
      },
    );
    const command = runPluginsCommand(["plugins", "doctor", "--json"]);
    try {
      await entered.promise;
      expect(pluginsCliRuntimeLogs).toEqual([]);
      expect(process.exitCode).toBe(7);
    } finally {
      finish.resolve();
      await command;
    }
    expect(process.exitCode).toBe(0);
    expect(pluginsCliRuntimeLogs).toHaveLength(1);
  });

  it.each(["format", "dispose"])("does not publish success when Doctor %s fails", async (phase) => {
    process.exitCode = 7;
    const failure = new Error(`Doctor ${phase} failed`);
    if (phase === "format") {
      buildPluginCompatibilityNoticesMock.mockImplementation(() => {
        throw failure;
      });
    } else {
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
          throw failure;
        },
      );
    }
    await expect(runPluginsCommand(["plugins", "doctor", "--json"])).rejects.toBe(failure);
    expect(pluginsCliRuntimeLogs).toEqual([]);
    expect(process.exitCode).toBe(7);
  });

  it("includes informational compatibility notices in healthy Doctor JSON", async () => {
    const notice = createCompatibilityNotice({ pluginId: "compatible-plugin", code: "hook-only" });
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "compatible-plugin" })],
    });
    buildPluginCompatibilityNoticesMock.mockReturnValue([notice]);
    await runPluginsCommand(["plugins", "doctor", "--json"]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({
      ok: true,
      compatibility: [notice],
      pluginErrors: [],
      diagnostics: [],
      configurationWarnings: [],
    });
  });

  it("updates the doctor exit status as health changes in one process", async () => {
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "compatible-plugin" })],
      diagnostics: [],
    });
    const compatibilityNotice = (code: "hook-only" | "removed-session-transcript-file-api") =>
      createCompatibilityNotice({ pluginId: "compatible-plugin", code });

    for (const [code, exitCode] of [
      ["hook-only", 0],
      ["removed-session-transcript-file-api", 1],
      ["hook-only", 0],
    ] as const) {
      buildPluginCompatibilityNoticesMock.mockReturnValue([compatibilityNotice(code)]);
      await runPluginsCommand(["plugins", "doctor"]);
      expect(process.exitCode).toBe(exitCode);
      const output = pluginsCliRuntimeLogs.at(-1);
      expect(output).toContain(compatibilityNotice(code).message);
      expect(output?.includes(cleanDoctorMessage)).toBe(exitCode === 0);
    }
  });

  it("sanitizes plugin warning terminal controls in human doctor output", async () => {
    mockPluginDoctorValidationWarnings([
      { path: "plugins.\nentries.google\u001b[31m", message: "bad\r\n\tvalue\u001b[0m\u0007" },
    ]);
    const output = await doctor();
    expect(output).toContain("- plugins.\\nentries.google: bad\\r\\n\\tvalue");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u001b");
  });

  it("reports inaccessible plugin directories as actionable discovery warnings", async () => {
    const message = "failed to read extensions dir: /tmp/plugins (permission denied)";
    mockDoctorReport({ diagnostics: [{ level: "warn", message }] });
    const output = await doctor();
    expect(output).toContain("Diagnostics:");
    expect(output).toContain(message);
    expect(output).not.toContain(cleanDoctorMessage);
  });

  it.each([
    ["codex", "missing", "openclaw plugins install @openclaw/codex"],
    ["acpx", "blocked", "Set plugins.entries.acpx.enabled=true"],
    ["codex", "enabled", cleanDoctorMessage],
    ["codex", "disabled", 'Enable the "codex" plugin'],
    ["codex", "denied", 'Remove "codex" from plugins.deny'],
  ] as const)("reports actionable %s runtime guidance when %s", async (id, state, guidance) => {
    const config: OpenClawConfig =
      id === "acpx" ? { acp: { backend: id } } : configuredCodexRuntime();
    if (state === "blocked") {
      config.plugins = { entries: { [id]: { enabled: false } } };
    } else if (state === "denied") {
      config.plugins = { deny: [id] };
    }
    pluginCliConfigMock.mockReturnValue(config);
    mockDoctorReport({
      plugins:
        state === "disabled" || state === "enabled"
          ? [
              createPluginRecord({
                id,
                enabled: state === "enabled",
                status: state === "enabled" ? "loaded" : "disabled",
              }),
            ]
          : [],
    });
    const output = await doctor();
    expect(output).toContain(guidance);
    if (state === "enabled") {
      expect(output).not.toContain(`Configured runtime "${id}"`);
      return;
    }
    expect(output).toContain(
      `Configured runtime "${id}" requires the ${id === "acpx" ? "ACPX Runtime" : "Codex"} plugin`,
    );
    expect(output).not.toContain(cleanDoctorMessage);
    if (state === "missing") {
      expect(output).toContain("openclaw doctor --fix");
      expect(output).toContain(
        "No plugin install-tree issues detected; configuration warnings remain.",
      );
    } else {
      expect(output).toContain(
        `but "${id}" is ${state === "disabled" ? "disabled" : "blocked by plugin configuration"}`,
      );
      expect(output).not.toContain(`openclaw plugins install @openclaw/${id}`);
      expect(output).not.toContain('Run "openclaw doctor --fix" to install');
      if (id === "acpx") {
        expect(output).toContain("disable ACP/acpx in acp config");
        expect(output).not.toContain('runtime policy to "openclaw"');
      }
    }
  });

  it("does not report healthy config-selected plugin source shadowing as doctor issue", async () => {
    mockDoctorReport({
      plugins: [
        createPluginRecord({
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw-upstream/extensions/discord/index.ts",
          status: "loaded",
        }),
      ],
      diagnostics: [
        {
          level: "info",
          pluginId: "discord",
          source: "/tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; global plugin will be overridden by config plugin (/tmp/openclaw-upstream/extensions/discord/index.ts)",
        },
      ],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(pluginsCliRuntimeLogs).toContain(cleanDoctorMessage);
  });

  it("refreshes the persisted plugin registry on request", async () => {
    refreshPluginRegistryMock.mockResolvedValue({
      plugins: [
        { pluginId: "demo", enabled: true },
        { pluginId: "off", enabled: false },
      ],
    });
    inspectPluginRegistryMock.mockResolvedValue({
      state: "fresh",
      refreshReasons: [],
      differences: [],
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await runPluginsCommand(["plugins", "registry", "--refresh"]);

    expect(refreshPluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        reason: "manual",
      }),
    );
    expect(inspectPluginRegistryMock).toHaveBeenCalledWith({ config: {} });
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Plugin registry refreshed: 1/2 enabled");
  });

  it.each([false, true])(
    "reports persisted replacement differences after stale refresh (json=%s)",
    async (json) => {
      refreshPluginRegistryMock.mockResolvedValue({ plugins: [] });
      inspectPluginRegistryMock.mockResolvedValue({
        state: "stale",
        refreshReasons: ["source-changed"],
        differences: [
          {
            pluginId: "demo",
            changed: ["record"],
            persistedSource: "/plugins/demo/index.js",
            derivedSource: "/plugins/demo/dist/index.js",
          },
        ],
        persisted: { plugins: [] },
        current: { plugins: [] },
      });
      const command = runPluginsCommand([
        "plugins",
        "registry",
        "--refresh",
        ...(json ? ["--json"] : []),
      ]);
      if (!json) {
        await expect(command).rejects.toThrow(
          /demo: record changed; persisted \/plugins\/demo\/index\.js; derived \/plugins\/demo\/dist\/index\.js.*openclaw plugins registry --refresh/su,
        );
        return;
      }
      await expect(command).rejects.toThrow();
      expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).toMatchObject({
        ok: false,
        refreshed: false,
        state: "stale",
        refreshReasons: ["source-changed"],
        differences: [
          {
            pluginId: "demo",
            changed: ["record"],
            persistedSource: "/plugins/demo/index.js",
            derivedSource: "/plugins/demo/dist/index.js",
          },
        ],
      });
    },
  );

  it("preserves differing registry source paths beside the home directory", async () => {
    const homeDir = path.resolve(path.sep, "tmp", "p-home");
    const sourceDir = path.resolve(path.sep, "tmp", "p-home-other");
    const differences = [
      {
        pluginId: "source-probe",
        changed: ["source"],
        persistedSource: path.join(sourceDir, "old.js"),
        derivedSource: path.join(sourceDir, "new.js"),
      },
    ];
    inspectPluginRegistryMock.mockResolvedValue({
      state: "stale",
      refreshReasons: ["source-changed"],
      differences,
      persisted: { plugins: [] },
      current: { plugins: [] },
    });

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "registry"]);
      expect(pluginsCliRuntimeLogs.join("\n")).toContain(
        `persisted ${path.join(sourceDir, "old.js")}; derived ${path.join(sourceDir, "new.js")}`,
      );
      pluginsCliRuntimeLogs.length = 0;
      await runPluginsCommand(["plugins", "registry", "--json"]);
      expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toMatchObject({ differences });
    });
  });

  it("serializes registry rebuilds with other plugin lifecycle mutations", async () => {
    const firstEntered = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const entries: number[] = [];
    refreshPluginRegistryMock.mockImplementation(async () => {
      const entry = entries.length + 1;
      entries.push(entry);
      if (entry === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return { plugins: [] };
    });

    const first = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await firstEntered.promise;
    const second = runPluginsCommand(["plugins", "registry", "--refresh", "--json"]);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(entries).toEqual([1]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(entries).toEqual([1, 2]);
  });
});
