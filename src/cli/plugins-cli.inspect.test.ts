import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginInspectReport } from "../plugins/status.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withPluginDiagnosticsReportForInspectionMock as withDiagnostics,
  buildAllPluginInspectReportsMock as inspectAll,
  buildPluginDiagnosticsReportMock as diagnostics,
  buildPluginInspectReportMock as inspectOne,
  buildPluginRegistrySnapshotReportMock as registryReport,
  buildPluginSnapshotReportMock as snapshot,
  loadPluginMetadataSnapshotMock,
  expectNoPluginCliCalls as expectNoCalls,
  pluginCliConfigMock as configMock,
  pluginsCliRuntimeLogs as logs,
  resetPluginsCliTestState,
  retirePluginDiagnosticsMock,
  runPluginsCommand,
  runPluginCli as plugins,
  runtimeErrors,
  setInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const workshopMocks = vi.hoisted(() => ({ detectToolPolicyDiagnostic: vi.fn() }));

vi.mock("../skills/workshop/tool-policy-diagnostic.js", () => ({
  detectSkillWorkshopToolPolicyDiagnostic: workshopMocks.detectToolPolicyDiagnostic,
}));

function createInspectReport(
  overrides: Partial<PluginInspectReport> & Pick<PluginInspectReport, "plugin">,
): PluginInspectReport {
  return {
    shape: "non-capability",
    capabilityMode: "none",
    capabilityCount: 0,
    capabilities: [],
    typedHooks: [],
    customHooks: [],
    tools: [],
    commands: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServices: [],
    gatewayMethods: [],
    mcpServers: [],
    lspServers: [],
    httpRouteCount: 0,
    bundleCapabilities: [],
    diagnostics: [],
    policy: { allowedModels: [], hasAllowedModelsConfig: false },
    compatibility: [],
    ...overrides,
  };
}

function mockInspection(
  plugin: PluginInspectReport["plugin"],
  overrides: Partial<PluginInspectReport> = {},
  allPlugins = [plugin],
) {
  const inspect = createInspectReport({ plugin, ...overrides });
  const report = {
    ...createEmptyPluginRegistry(),
    workspaceScope: "omitted" as const,
    plugins: allPlugins,
  };
  snapshot.mockReturnValue(report);
  inspectOne.mockReturnValue(inspect);
  inspectAll.mockReturnValue([inspect]);
  return report;
}

function shadowMessage(source: string) {
  return (
    "duplicate plugin id resolved by explicit config-selected plugin; " +
    `global plugin will be overridden by config plugin (${source})`
  );
}

const originalExitCode = process.exitCode;

describe("plugins cli inspect", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    workshopMocks.detectToolPolicyDiagnostic.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it.each([
    { directory: "p-home", expectedRoot: "$OPENCLAW_HOME" },
    { directory: "p-home-other", expectedRoot: path.resolve(path.sep, "tmp", "p-home-other") },
  ])("preserves source paths across list and inspect for $directory", async (testCase) => {
    const homeDir = path.resolve(path.sep, "tmp", "p-home");
    const source = path.resolve(path.sep, "tmp", testCase.directory, "p", "index.js");
    const plugin = createPluginRecord({ id: "source-probe", source, origin: "config" });
    const report = mockInspection(plugin);
    registryReport.mockReturnValue({
      ...report,
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics: [],
    });
    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      for (const args of [
        ["list", "--verbose"],
        ["inspect", plugin.id],
        ["info", plugin.id],
      ]) {
        logs.length = 0;
        await plugins(...args);
        const text = stripVTControlCharacters(logs.join("\n"));
        expect(/^\s*source: (.+)$/im.exec(text)?.[1]).toBe(
          path.join(testCase.expectedRoot, "p", "index.js"),
        );
      }
      for (const args of [
        ["list", "--json"],
        ["inspect", plugin.id, "--json"],
      ]) {
        logs.length = 0;
        await plugins(...args);
        const output = JSON.parse(logs.at(-1) ?? "null");
        expect((args[0] === "list" ? output.plugins[0] : output.plugin).source).toBe(source);
      }
    });
  });

  it.each([false, true])(
    "serializes while owned and waits for release before JSON output (all: %s)",
    async (all) => {
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const plugin = createPluginRecord({ id: "owned-inspect" });
      let released = false;
      let serialized = false;
      Object.defineProperty(plugin, "description", {
        enumerable: true,
        get() {
          expect(released).toBe(false);
          serialized = true;
          return "resource-backed description";
        },
      });
      const report = mockInspection(plugin);
      withDiagnostics.mockImplementation(async (_params, formatReport) => {
        const output = formatReport(report);
        expect(serialized).toBe(true);
        started.resolve();
        await finish.promise;
        released = true;
        return output;
      });
      const command = plugins("inspect", all ? "--all" : plugin.id, "--runtime", "--json");
      try {
        await started.promise;
        expect(logs).toEqual([]);
      } finally {
        finish.resolve();
        await command;
      }
      expect(withDiagnostics).toHaveBeenCalledTimes(1);
      expect(released).toBe(true);
      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0] ?? "");
      expect((all ? result[0] : result).plugin.description).toBe("resource-backed description");
    },
  );

  it("reports a missing runtime inspection as JSON failure", async () => {
    const plugin = createPluginRecord({ id: "owned-inspect" });
    mockInspection(plugin);
    inspectOne.mockReturnValue(null);
    await expect(plugins("inspect", plugin.id, "--runtime", "--json")).rejects.toThrow(
      "__exit__:1",
    );
    expect(withDiagnostics).toHaveBeenCalledOnce();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Plugin not found: owned-inspect") },
    });
  });

  it.each([{ selection: ["--all", "extra"] }, { selection: [] }])(
    "rejects invalid runtime selection before acquisition: $selection",
    async ({ selection }) => {
      await expect(plugins("inspect", ...selection, "--runtime", "--json")).rejects.toThrow(
        "__exit__:1",
      );
      expect(withDiagnostics).not.toHaveBeenCalled();
    },
  );

  it("does not publish runtime inspection output when retirement fails", async () => {
    inspectAll.mockReturnValue([]);
    retirePluginDiagnosticsMock.mockRejectedValue(new Error("diagnostics cleanup failed"));

    await expect(plugins("inspect", "--all", "--runtime", "--json")).rejects.toThrow(
      "diagnostics cleanup failed",
    );

    expect(logs).toEqual([]);
  });

  it.each([
    { runtime: false, selection: "all" },
    { runtime: false, selection: "single" },
    { runtime: true, selection: "missing" },
  ])(
    "preserves global diagnostics on stderr with $selection, runtime=$runtime",
    async ({ runtime, selection }) => {
      const plugin = createPluginRecord({ id: "shared-plugin" });
      const diagnostic = { level: "warn" as const, pluginId: plugin.id, message: "Plugin warning" };
      const inspect = createInspectReport({ plugin, diagnostics: [diagnostic] });
      const reports = selection === "missing" ? [] : [inspect];
      const report = {
        plugins: reports.map((entry) => entry.plugin),
        diagnostics: [
          {
            level: "warn" as const,
            code: "workspace-scope-omitted" as const,
            message: "Workspace discovery was skipped; select the system owner.",
          },
          diagnostic,
        ],
      };
      snapshot.mockReturnValue(report);
      withDiagnostics.mockImplementation(async (_params, formatReport) =>
        formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
      );
      inspectOne.mockReturnValue(inspect);
      inspectAll.mockReturnValue(reports);
      const args = [
        "plugins",
        "inspect",
        selection === "single" ? plugin.id : selection === "missing" ? "missing-plugin" : "--all",
        ...(runtime ? ["--runtime"] : []),
      ];
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const command = runPluginsCommand(args);
        if (selection === "missing") {
          await expect(command).rejects.toThrow("__exit__:1");
          expectNoCalls(diagnostics, withDiagnostics);
          expect(runtimeErrors.at(-1)).toContain("Plugin not found: missing-plugin");
        } else {
          await command;
        }
        const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(warnings.match(/Workspace discovery was skipped/g)).toHaveLength(1);
        expect(warnings).not.toContain("Plugin warning");
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it("keeps package-child inspection static and distinguishes disabled reasons from errors", async () => {
    const pluginId = "openclaw-mem0/core";
    const records: Record<string, PluginInstallRecord> = {
      "openclaw-mem0": {
        source: "clawhub",
        installPath: "/plugins/openclaw-mem0",
        clawhubPackage: "openclaw-mem0",
        artifactKind: "npm-pack",
        npmIntegrity: "sha512-clawpack",
        clawpackSha256: "a".repeat(64),
        clawpackSpecVersion: 1,
        clawpackSize: 4096,
      },
    };
    setInstalledPluginIndexInstallRecords(records);
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [{ id: pluginId, rootDir: "/plugins/openclaw-mem0" }],
    });
    metadata.index.installRecords = records;
    recordInstalledPluginIndexInstallOwner(metadata.index.plugins[0]!, "openclaw-mem0");
    loadPluginMetadataSnapshotMock.mockReturnValue(metadata);
    const packagePlugin = createPluginRecord({ id: pluginId, name: "Mem0" });
    const details: Partial<PluginInspectReport> = {
      shape: "hook-only",
      capabilityMode: "plain",
      capabilityCount: 1,
      typedHooks: [{ name: "agent_end" }],
      services: ["mem0-background"],
      gatewayDiscoveryServices: ["mem0-discovery", "mem0-discovery-secondary"],
      mcpServers: [
        { name: "local", hasStdioTransport: true },
        { name: "remote", hasStdioTransport: false },
        { name: "broken", hasStdioTransport: false, unsupported: true },
      ],
      policy: { allowConversationAccess: true, allowedModels: [], hasAllowedModelsConfig: false },
    };
    mockInspection(packagePlugin, details);

    await plugins("inspect", pluginId);

    expectNoCalls(diagnostics, withDiagnostics);
    const output = logs.join("\n");
    expect(output).toContain("Policy");
    expect(output).toContain("allowConversationAccess: true");
    expect(output).toContain("Services:\nmem0-background");
    expect(output).toContain("Gateway discovery:\nmem0-discovery\nmem0-discovery-secondary");
    expect(output).toContain("ClawHub package: openclaw-mem0");
    expect(output).toContain("Artifact kind: npm-pack");
    expect(output).toContain("Npm integrity: sha512-clawpack");
    expect(output).toContain(`ClawPack sha256: ${"a".repeat(64)}`);
    expect(output).toContain("ClawPack spec: 1");
    expect(output).toContain("ClawPack size: 4096 bytes");
    expect(output).toContain("remote");
    expect(output).toContain("broken (unsupported transport)");
    expect(output).not.toContain("remote (unsupported transport)");

    await plugins("inspect", pluginId, "--json");
    expect(JSON.parse(logs.at(-1) ?? "null")).toMatchObject({
      services: ["mem0-background"],
      gatewayDiscoveryServices: ["mem0-discovery", "mem0-discovery-secondary"],
    });

    for (const { id, status, detail, label } of [
      {
        id: "workspace-disabled",
        status: "disabled" as const,
        detail: "workspace plugin (disabled by default)",
        label: "Reason",
      },
      { id: "broken", status: "error" as const, detail: "missing plugin module", label: "Error" },
    ]) {
      const plugin = createPluginRecord({
        id,
        enabled: status !== "disabled",
        status,
        error: detail,
        ...(status === "disabled" ? { activationReason: detail } : {}),
      });
      mockInspection(plugin, details);

      await plugins("inspect", id);

      const inspectOutput = logs.at(-1) ?? "";
      expect(inspectOutput).toContain(`Status: ${status}`);
      expect(inspectOutput).toContain(`${label}: ${detail}`);
      expect(inspectOutput).not.toContain(`${label === "Reason" ? "Error" : "Reason"}: ${detail}`);

      if (status === "disabled") {
        await plugins("inspect", id, "--json");
        expect(JSON.parse(logs.at(-1) ?? "null").plugin).toMatchObject({
          status: "disabled",
          error: detail,
          activationReason: detail,
        });
      }
    }
  });

  it("runtime-inspects exact plugin ids and display names without repairing deps", async () => {
    const plugin = createPluginRecord({ id: "openclaw-mem0", name: "Mem0" });
    mockInspection(
      plugin,
      {
        gatewayDiscoveryServices: ["mem0-runtime-discovery"],
      },
      [createPluginRecord({ id: "unrelated-plugin", name: "openclaw-mem0" }), plugin],
    );

    for (const selector of ["openclaw-mem0", "Mem0"]) {
      await plugins("inspect", selector, "--runtime");
      expect(withDiagnostics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          config: {},
          onlyPluginIds: ["openclaw-mem0"],
          runtimeInspection: true,
        }),
        expect.any(Function),
      );
      expect(logs.at(-1)).toContain("Gateway discovery:\nmem0-runtime-discovery");
    }
  });

  it("explains policy-hidden Skill Workshop for every configured agent", async () => {
    const agentIds = ["main", "venus"];
    const config: OpenClawConfig = {
      tools: { profile: "messaging" },
      agents: { ownership: "explicit", entries: { main: {}, venus: {} } },
    };
    configMock.mockReturnValue(config);
    workshopMocks.detectToolPolicyDiagnostic.mockImplementation(
      ({ agentId }: { agentId: string }) => ({
        agentId,
        message:
          `Skill Workshop is active, but "skill_workshop" is hidden for agent "${agentId}": ` +
          'tools.profile: "messaging" does not include "skill_workshop". ' +
          'Add tools.alsoAllow: ["skill_workshop"].',
      }),
    );
    snapshot.mockReturnValue({ plugins: [], diagnostics: [] });

    await expect(plugins("inspect", "skill-workshop")).rejects.toThrow("__exit__:1");

    const output = runtimeErrors.at(-1);
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config,
      workspaceDir: undefined,
    });
    expect(output).toContain("Skill Workshop is built into OpenClaw, not a plugin");
    expect(output).toContain('tools.profile: "messaging" does not include "skill_workshop".');
    expect(output).toContain('Add tools.alsoAllow: ["skill_workshop"].');
    for (const agentId of agentIds) {
      expect(workshopMocks.detectToolPolicyDiagnostic).toHaveBeenCalledWith({
        config,
        workshopEnabled: true,
        agentId,
      });
      expect(output).toContain(`hidden for agent "${agentId}"`);
    }
  });
  it.each(["", "-other"])(
    "preserves diagnostic metadata and source identity (home suffix=%s)",
    async (sourceSuffix) => {
      const metadata: Pick<PluginDiagnostic, "pluginId" | "code" | "sdkCompatibility"> =
        sourceSuffix
          ? {}
          : {
              pluginId: "broken",
              code: "sdk-incompatible",
              sdkCompatibility: {
                seam: "openclaw/plugin-sdk/channel-runtime",
                coreVersion: "2026.9.4",
                builtWithOpenClawVersion: "2026.7.1",
                nestedSdk: true,
              },
            };
      const homeDir = path.resolve(path.sep, "tmp", "openclaw-plugin-doctor-home");
      const sourceDir = `${homeDir}${sourceSuffix}`;
      const displayedSourceDir = sourceSuffix ? sourceDir : "$OPENCLAW_HOME";
      const diagnostic: PluginDiagnostic = {
        ...metadata,
        level: "warn",
        source: `${sourceDir}/plugins/unreadable`,
        message: `failed to inspect ${homeDir}/plugins/unreadable`,
      };
      withDiagnostics.mockImplementation(async (_params, formatReport) =>
        formatReport({
          ...createEmptyPluginRegistry(),
          workspaceScope: "omitted",
          plugins: [
            createPluginRecord({
              id: "broken",
              origin: "config",
              source: `${sourceDir}/plugins/broken/index.ts`,
              status: "error",
              error: `failed to load ${homeDir}/plugins/broken/runtime.ts`,
            }),
          ],
          diagnostics: [
            {
              level: "info",
              pluginId: "broken",
              source: `${sourceDir}/plugins/shadowed/index.ts`,
              message: shadowMessage(`${homeDir}/plugins/broken/index.ts`),
            },
            diagnostic,
          ],
        }),
      );

      await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
        await plugins("doctor", "--json");
      });

      expect(process.exitCode).toBe(1);
      expect(logs).toHaveLength(1);
      expect(runtimeErrors).toEqual([]);
      if (!sourceSuffix) {
        expect(logs[0]).not.toContain(homeDir);
      }
      expect(logs[0]).not.toMatch(/Plugin errors:|Docs:/);
      const source = `${displayedSourceDir}/plugins/broken/index.ts`;
      const error = "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts";
      expect(JSON.parse(logs[0] ?? "null")).toMatchObject({
        ok: false,
        pluginErrors: [{ id: "broken", error, source }],
        diagnostics: [
          {
            ...diagnostic,
            source: `${displayedSourceDir}/plugins/unreadable`,
            message: "failed to inspect $OPENCLAW_HOME/plugins/unreadable",
          },
        ],
        sourceShadowing: [
          {
            pluginId: "broken",
            message: shadowMessage("$OPENCLAW_HOME/plugins/broken/index.ts"),
            active: { source, origin: "config", status: "error", error },
            shadowedSource: `${displayedSourceDir}/plugins/shadowed/index.ts`,
          },
        ],
      });

      logs.length = 0;
      await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
        await plugins("doctor");
      });
      const human = logs.join("\n");
      expect(human).toContain(`  active: ${displayedSourceDir}/plugins/broken/index.ts (config)`);
      expect(human).toContain(`  shadowed: ${displayedSourceDir}/plugins/shadowed/index.ts`);
    },
  );
});
