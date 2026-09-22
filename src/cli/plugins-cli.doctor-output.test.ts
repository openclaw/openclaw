import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withPluginDiagnosticsReportForInspectionMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
} from "./plugins-cli-test-helpers.js";

const originalExitCode = process.exitCode;

describe("plugins cli Doctor output", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it.each([
    { name: "unclassified diagnostic", metadata: {}, sourceSuffix: "" },
    {
      name: "classified diagnostic",
      metadata: { code: "workspace-scope-omitted" },
      sourceSuffix: "",
    },
    {
      name: "SDK compatibility diagnostic",
      sourceSuffix: "",
      metadata: {
        pluginId: "broken",
        code: "sdk-incompatible",
        sdkCompatibility: {
          seam: "openclaw/plugin-sdk/channel-runtime",
          coreVersion: "2026.9.4",
          builtWithOpenClawVersion: "2026.7.1",
          nestedSdk: true,
        },
      },
    },
    { name: "sibling home-prefix sources", metadata: {}, sourceSuffix: "-other" },
  ] as const)("preserves diagnostic and source identity ($name)", async (testCase) => {
    const { metadata, sourceSuffix } = testCase;
    const homeDir = path.resolve(path.sep, "tmp", "openclaw-plugin-doctor-home");
    const sourceDir = `${homeDir}${sourceSuffix}`;
    const displayedSourceDir = sourceSuffix ? sourceDir : "$OPENCLAW_HOME";
    withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
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
            level: "warn",
            pluginId: "broken",
            source: `${sourceDir}/plugins/shadowed/index.ts`,
            message:
              "duplicate plugin id resolved by explicit config-selected plugin; " +
              `global plugin will be overridden by config plugin (${homeDir}/plugins/broken/index.ts)`,
          },
          {
            ...metadata,
            level: "warn",
            source: `${sourceDir}/plugins/unreadable`,
            message: `failed to inspect ${homeDir}/plugins/unreadable`,
          },
        ],
      }),
    );

    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "doctor", "--json"]);
    });

    expect(process.exitCode).toBe(1);
    expect(pluginsCliRuntimeLogs).toHaveLength(1);
    expect(runtimeErrors).toEqual([]);
    if (!sourceSuffix) {
      expect(pluginsCliRuntimeLogs[0]).not.toContain(homeDir);
    }
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Plugin errors:");
    expect(pluginsCliRuntimeLogs[0]).not.toContain("Docs:");
    expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toEqual({
      ok: false,
      pluginErrors: [
        {
          id: "broken",
          error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          source: `${displayedSourceDir}/plugins/broken/index.ts`,
        },
      ],
      diagnostics: [
        {
          ...metadata,
          level: "warn",
          source: `${displayedSourceDir}/plugins/unreadable`,
          message: "failed to inspect $OPENCLAW_HOME/plugins/unreadable",
        },
      ],
      sourceShadowing: [
        {
          pluginId: "broken",
          message:
            "duplicate plugin id resolved by explicit config-selected plugin; " +
            "global plugin will be overridden by config plugin ($OPENCLAW_HOME/plugins/broken/index.ts)",
          active: {
            source: `${displayedSourceDir}/plugins/broken/index.ts`,
            origin: "config",
            status: "error",
            error: "failed to load $OPENCLAW_HOME/plugins/broken/runtime.ts",
          },
          shadowedSource: `${displayedSourceDir}/plugins/shadowed/index.ts`,
          repair: [
            "openclaw plugins inspect broken",
            "edit or remove the config-selected plugin source",
            "openclaw plugins registry --refresh",
            "openclaw plugins reload broken",
          ],
        },
      ],
      compatibility: [],
      configurationWarnings: [],
    });

    pluginsCliRuntimeLogs.length = 0;
    await withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
      await runPluginsCommand(["plugins", "doctor"]);
    });
    const human = pluginsCliRuntimeLogs.join("\n");
    expect(human).toContain(`  active: ${displayedSourceDir}/plugins/broken/index.ts (config)`);
    expect(human).toContain(`  shadowed: ${displayedSourceDir}/plugins/shadowed/index.ts`);
  });
});
