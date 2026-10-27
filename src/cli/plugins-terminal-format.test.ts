import { Chalk } from "chalk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { hasTerminalControl } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginInspectReport } from "../plugins/status.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  buildAllPluginInspectReportsMock,
  buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReportMock,
  buildPluginSnapshotReportMock,
  pluginsCliRuntimeLogs as logs,
  resetPluginsCliTestState,
  runtimeErrors,
  runPluginsCommand,
} from "./plugins-cli-test-helpers.js";

const escape = "\u001b]0;untrusted-title\u0007\u009f";
const untrusted = (text: string) => `${text}${escape}`;

describe("installed plugin terminal rendering", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    const plugin = createPluginRecord({
      id: "terminal-fixture",
      name: untrusted("Fixture"),
      description: untrusted("Plugin description"),
      version: untrusted("1.0.0"),
      enabled: false,
      providerIds: [untrusted("fixture-provider")],
    });
    const report = {
      ...createEmptyPluginRegistry(),
      workspaceScope: "omitted" as const,
      plugins: [plugin],
    };
    buildPluginSnapshotReportMock.mockReturnValue(report);
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      ...report,
      registrySource: "derived",
      registryDiagnostics: [],
    });
    const inspect: PluginInspectReport = {
      plugin,
      workspaceDir: "/workspace",
      shape: "non-capability",
      capabilityMode: "none",
      capabilityCount: 0,
      capabilities: [],
      typedHooks: [],
      customHooks: [],
      tools: [],
      commands: [untrusted("fixture-command")],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServices: [],
      gatewayMethods: [],
      mcpServers: [],
      lspServers: [],
      httpRouteCount: 0,
      bundleCapabilities: [],
      diagnostics: [{ level: "warn", message: untrusted("Fixture diagnostic") }],
      policy: { allowedModels: [], hasAllowedModelsConfig: false },
      compatibility: [],
    };
    buildPluginInspectReportMock.mockReturnValue(inspect);
    buildAllPluginInspectReportsMock.mockReturnValue([inspect]);
  });

  it.each([["list"], ["list", "--verbose"], ["inspect", "terminal-fixture"], ["inspect", "--all"]])(
    "does not execute controls from metadata in %j",
    async (...args) => {
      await runPluginsCommand(["plugins", ...args]);
      const output = logs.join("\n");
      expect(
        hasTerminalControl(
          stripAnsi(output).replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", ""),
        ),
      ).toBe(false);
      expect(output).not.toContain(escape);
      expect(output).toContain("Fixture");
      if (!args.includes("--all")) {
        expect(output).toContain("1.0.0");
      }
      if (args[0] === "inspect" && !args.includes("--all")) {
        expect(output).toContain("fixture-command");
        expect(output).toContain("Fixture diagnostic");
      }
    },
  );

  it.each([false, true])("handles controls in missing plugin IDs (json=%s)", async (json) => {
    const id = `${untrusted("missing-plugin")}\nforged error`;
    await expect(
      runPluginsCommand(["plugins", "inspect", id, ...(json ? ["--json"] : [])]),
    ).rejects.toThrow("__exit__:1");
    if (json) {
      expect(JSON.parse(logs.at(-1) ?? "null").error.message).toContain(id);
    } else {
      const output = runtimeErrors.join("\n");
      expect(output).toContain("missing-plugin");
      expect(output).not.toContain(escape);
      expect(output).toContain("\\nforged error");
      expect(hasTerminalControl(output.replaceAll("\n", ""))).toBe(false);
    }
  });

  it("retains trusted status styling in the all-plugins table", async () => {
    const colors = new Chalk({ level: 1 });
    const warn = vi.spyOn(theme, "warn").mockImplementation(colors.yellow);
    try {
      await runPluginsCommand(["plugins", "inspect", "--all"]);
      expect(logs.join("\n")).toContain(colors.yellow("disabled"));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([["terminal-fixture"], ["--all"]])(
    "sanitizes global diagnostics for %j",
    async (...args) => {
      buildPluginSnapshotReportMock.mockReturnValue({
        ...createEmptyPluginRegistry(),
        workspaceScope: "omitted",
        plugins: [createPluginRecord({ id: "terminal-fixture" })],
        diagnostics: [{ level: "warn", message: untrusted("Global discovery warning") }],
      });
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await runPluginsCommand(["plugins", "inspect", ...args]);
        const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(output).toContain("Global discovery warning");
        expect(hasTerminalControl(output.replaceAll("\n", ""))).toBe(false);
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it.each([["list"], ["inspect", "terminal-fixture"]])(
    "retains metadata values in %j JSON",
    async (...args) => {
      await runPluginsCommand(["plugins", ...args, "--json"]);
      const output = JSON.parse(logs.at(-1) ?? "null");
      const plugin = args[0] === "list" ? output.plugins[0] : output.plugin;
      expect(plugin.name).toBe(untrusted("Fixture"));
      expect(plugin.description).toBe(untrusted("Plugin description"));
      expect(plugin.providerIds).toEqual([untrusted("fixture-provider")]);
    },
  );
});
