import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistryStatusReport, PluginStatusReport } from "../plugins/status.js";
import { createCompatibilityNotice, createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildPluginCompatibilityNoticesMock,
  withPluginDiagnosticsReportForInspectionMock as withDiagnostics,
  buildPluginRegistrySnapshotReportMock as registryReport,
  inspectPluginRegistryMock as inspectRegistry,
  pluginCliConfigMock as configMock,
  loadPluginManifestRegistryMock,
  readConfigFileSnapshotMock,
  resetPluginsCliTestState,
  refreshPluginRegistryMock as refreshRegistry,
  runPluginCli as plugins,
  pluginsCliRuntimeLogs as logs,
} from "./plugins-cli-test-helpers.js";

const cleanDoctorMessage =
  "Plugin discovery, module loading, compatibility, and configuration checks passed. " +
  'Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.';
const originalExitCode = process.exitCode;

function mockDoctorReport(report: Partial<Pick<PluginStatusReport, "plugins" | "diagnostics">>) {
  withDiagnostics.mockImplementation(async (_params, formatReport) =>
    formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
  );
}

function mockRegistry(report: Partial<PluginRegistryStatusReport> = {}) {
  registryReport.mockReturnValue({
    workspaceDir: "/workspace",
    registrySource: "persisted",
    registryDiagnostics: [],
    plugins: [],
    diagnostics: [],
    ...report,
  });
}

function mockRegistryInspection(
  persistedSource: string,
  derivedSource: string,
  pluginId = "demo",
  changed = "record",
) {
  const differences = [{ pluginId, changed: [changed], persistedSource, derivedSource }];
  inspectRegistry.mockResolvedValue({
    state: "stale",
    refreshReasons: ["source-changed"],
    differences,
    persisted: { plugins: [] },
    current: { plugins: [] },
  });
  return differences;
}

async function doctor(...args: string[]) {
  await plugins("doctor", ...args);
  return logs.join("\n");
}

function mockPluginDoctorValidationWarnings(warnings: ConfigValidationIssue[]) {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["imessage", "memory-core"],
      entries: { google: { config: { apiKey: "test-google-key" } } },
    },
  };
  configMock.mockReturnValue(config);
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
    mockRegistry({
      plugins: [
        createPluginRecord({ id: "broken", status: "error", error: "missing plugin module" }),
        createPluginRecord({
          id: "disabled",
          description: "Disabled plugin description",
          enabled: false,
          status: "disabled",
          error: disabledReason,
          activationReason: disabledReason,
        }),
      ],
    });

    await plugins("list");

    const output = logs.join("\n");
    expect(output).toContain("missing plugin module");
    expect(output).toContain("Disabled plugin description");

    await plugins("list", "--verbose");

    const verboseOutput = logs.at(-1) ?? "";
    expect(verboseOutput).toContain(`activation reason: ${disabledReason}`);
    expect(verboseOutput).not.toContain(`error: ${disabledReason}`);
    expect(verboseOutput).toContain("error: missing plugin module");
  });

  it.each([
    { label: "default", args: [], visibleError: true },
    { label: "enabled-only", args: ["--enabled"], visibleError: false },
  ])(
    "surfaces plugin discovery and stale-registry diagnostics in the $label list",
    async ({ args, visibleError }) => {
      const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 240 });
      onTestFinished(() => {
        if (columns) {
          Object.defineProperty(process.stdout, "columns", columns);
        } else {
          Reflect.deleteProperty(process.stdout, "columns");
        }
      });
      const refreshMessage =
        "Persisted plugin registry is stale. Run `openclaw plugins registry --refresh`.";
      const dependencyError = "Plugin dependency example-package could not be resolved.";
      mockRegistry({
        registrySource: "derived",
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "Persisted plugin registry is missing; using the derived index.",
          },
          { level: "warn", code: "persisted-registry-stale-source", message: refreshMessage },
        ],
        plugins: [
          createPluginRecord({ id: "healthy" }),
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

      await plugins("list", ...args);

      const output = logs.join("\n");
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
    const notice = createCompatibilityNotice({ pluginId: "compatible-plugin", code: "hook-only" });
    buildPluginCompatibilityNoticesMock.mockReturnValue([notice]);
    process.exitCode = 7;
    withDiagnostics.mockImplementation(async (_params, formatReport) => {
      const text = formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
      entered.resolve();
      await finish.promise;
      return text;
    });
    const command = plugins("doctor", "--json");
    try {
      await entered.promise;
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(7);
    } finally {
      finish.resolve();
      await command;
    }
    expect(process.exitCode).toBe(0);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "null")).toMatchObject({ ok: true, compatibility: [notice] });
  });

  it.each(["format", "dispose"])("does not publish success when Doctor %s fails", async (phase) => {
    process.exitCode = 7;
    const failure = new Error(`Doctor ${phase} failed`);
    if (phase === "format") {
      buildPluginCompatibilityNoticesMock.mockImplementation(() => {
        throw failure;
      });
    } else {
      withDiagnostics.mockImplementation(async (_params, formatReport) => {
        formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted" });
        throw failure;
      });
    }
    await expect(plugins("doctor", "--json")).rejects.toBe(failure);
    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(7);
  });

  it("updates the doctor exit status as health changes in one process", async () => {
    const compatibilityNotice = (code: "hook-only" | "removed-session-transcript-file-api") =>
      createCompatibilityNotice({ pluginId: "compatible-plugin", code });

    for (const [code, exitCode] of [
      ["hook-only", 0],
      ["removed-session-transcript-file-api", 1],
      ["hook-only", 0],
    ] as const) {
      buildPluginCompatibilityNoticesMock.mockReturnValue([compatibilityNotice(code)]);
      await plugins("doctor");
      expect(process.exitCode).toBe(exitCode);
      const output = logs.at(-1);
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
    ["codex", "missing", "openclaw plugins install npm:@openclaw/codex"],
    ["acpx", "blocked", "Set plugins.entries.acpx.enabled=true"],
    ["codex", "enabled", cleanDoctorMessage],
    ["codex", "disabled", 'Enable the "codex" plugin'],
    ["codex", "denied", 'Remove "codex" from plugins.deny'],
  ] as const)("reports actionable %s runtime guidance when %s", async (id, state, guidance) => {
    const config: OpenClawConfig =
      id === "acpx"
        ? { acp: { backend: id } }
        : {
            agents: {
              defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
            },
          };
    if (state === "blocked") {
      config.plugins = { entries: { [id]: { enabled: false } } };
    } else if (state === "denied") {
      config.plugins = { deny: [id] };
    }
    configMock.mockReturnValue(config);
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
    expect(output).not.toContain(cleanDoctorMessage);
    if (state === "missing") {
      expect(output).toContain("openclaw doctor --fix");
      expect(output).toContain(
        "No plugin install-tree issues detected; configuration warnings remain.",
      );
    } else {
      expect(output).not.toContain(`openclaw plugins install npm:@openclaw/${id}`);
      expect(output).not.toContain('Run "openclaw doctor --fix" to install');
      if (id === "acpx") {
        expect(output).toContain("disable ACP/acpx in acp config");
        expect(output).not.toContain('runtime policy to "openclaw"');
      }
    }
  });

  it("does not report healthy config-selected plugin source shadowing as doctor issue", async () => {
    mockDoctorReport({
      plugins: [createPluginRecord({ id: "discord", origin: "config" })],
      diagnostics: [
        {
          level: "info",
          pluginId: "discord",
          message: "duplicate plugin id resolved by explicit config-selected plugin",
        },
      ],
    });

    await plugins("doctor");

    expect(logs).toContain(cleanDoctorMessage);
  });

  it("refreshes the persisted plugin registry on request", async () => {
    refreshRegistry.mockResolvedValue({
      plugins: [
        { pluginId: "demo", enabled: true },
        { pluginId: "off", enabled: false },
      ],
    });

    await plugins("registry", "--refresh");

    expect(logs.join("\n")).toContain("Plugin registry refreshed: 1/2 enabled");
  });

  it.each([false, true])(
    "reports persisted replacement differences after stale refresh (json=%s)",
    async (json) => {
      refreshRegistry.mockResolvedValue({ plugins: [] });
      const differences = mockRegistryInspection(
        "/plugins/demo/index.js",
        "/plugins/demo/dist/index.js",
      );
      const command = plugins("registry", "--refresh", ...(json ? ["--json"] : []));
      if (!json) {
        await expect(command).rejects.toThrow(
          /demo: record changed; persisted \/plugins\/demo\/index\.js; derived \/plugins\/demo\/dist\/index\.js.*openclaw plugins registry --refresh/su,
        );
        return;
      }
      await expect(command).rejects.toThrow();
      expect(JSON.parse(logs.at(-1) ?? "null")).toMatchObject({
        ok: false,
        refreshed: false,
        state: "stale",
        refreshReasons: ["source-changed"],
        differences,
      });
    },
  );

  it("preserves differing registry source paths beside the home directory", async () => {
    const homeDir = path.resolve(path.sep, "tmp", "p-home");
    const sourceDir = path.resolve(path.sep, "tmp", "p-home-other");
    const differences = mockRegistryInspection(
      path.join(sourceDir, "old.js"),
      path.join(sourceDir, "new.js"),
      "source-probe",
      "source",
    );

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await plugins("registry");
      expect(logs.join("\n")).toContain(
        `persisted ${path.join(sourceDir, "old.js")}; derived ${path.join(sourceDir, "new.js")}`,
      );
      logs.length = 0;
      await plugins("registry", "--json");
      expect(JSON.parse(logs[0] ?? "null")).toMatchObject({ differences });
    });
  });

  it("serializes registry rebuilds with other plugin lifecycle mutations", async () => {
    const firstEntered = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const entries: number[] = [];
    refreshRegistry.mockImplementation(async () => {
      const entry = entries.length + 1;
      entries.push(entry);
      if (entry === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return { plugins: [] };
    });

    const first = plugins("registry", "--refresh", "--json");
    await firstEntered.promise;
    const second = plugins("registry", "--refresh", "--json");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(entries).toEqual([1]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(entries).toEqual([1, 2]);
  });
});
