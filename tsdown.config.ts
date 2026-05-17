import fs from "node:fs";
import path from "node:path";
import { defineConfig, type UserConfig } from "tsdown";
import {
  listBundledPluginBuildEntries,
  listBundledPluginRuntimeDependencies,
} from "./scripts/lib/bundled-plugin-build-entries.mjs";
import { buildPluginSdkEntrySources } from "./scripts/lib/plugin-sdk-entries.mjs";

type InputOptionsFactory = Extract<NonNullable<UserConfig["inputOptions"]>, Function>;
type InputOptionsArg = InputOptionsFactory extends (
  options: infer Options,
  format: infer _Format,
  context: infer _Context,
) => infer _Return
  ? Options
  : never;
type InputOptionsReturn = InputOptionsFactory extends (
  options: infer _Options,
  format: infer _Format,
  context: infer _Context,
) => infer Return
  ? Return
  : never;
type OnLogFunction = InputOptionsArg extends { onLog?: infer OnLog } ? NonNullable<OnLog> : never;

const env = {
  NODE_ENV: "production",
};

const SUPPRESSED_EVAL_WARNING_PATHS = [
  "@protobufjs/inquire/index.js",
  "bottleneck/lib/IORedisConnection.js",
  "bottleneck/lib/RedisConnection.js",
] as const;

function buildInputOptions(options: InputOptionsArg): InputOptionsReturn {
  if (process.env.OPENCLAW_BUILD_VERBOSE === "1") {
    return undefined;
  }

  const previousOnLog = typeof options.onLog === "function" ? options.onLog : undefined;

  function isSuppressedLog(log: {
    code?: string;
    message?: string;
    id?: string;
    importer?: string;
  }) {
    if (log.code === "PLUGIN_TIMINGS") {
      return true;
    }
    if (log.code !== "EVAL") {
      return false;
    }
    const haystack = [log.message, log.id, log.importer].filter(Boolean).join("\n");
    return SUPPRESSED_EVAL_WARNING_PATHS.some((path) => haystack.includes(path));
  }

  return {
    ...options,
    onLog(...args: Parameters<OnLogFunction>) {
      const [level, log, defaultHandler] = args;
      if (isSuppressedLog(log)) {
        return;
      }
      if (typeof previousOnLog === "function") {
        previousOnLog(level, log, defaultHandler);
        return;
      }
      defaultHandler(level, log);
    },
  };
}

function nodeBuildConfig(config: UserConfig): UserConfig {
  return {
    ...config,
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
  };
}

const bundledPluginBuildEntries = listBundledPluginBuildEntries();
const bundledPluginRuntimeDependencies = listBundledPluginRuntimeDependencies();

function buildBundledHookEntries(): Record<string, string> {
  const hooksRoot = path.join(process.cwd(), "src", "hooks", "bundled");
  const entries: Record<string, string> = {};

  if (!fs.existsSync(hooksRoot)) {
    return entries;
  }

  for (const dirent of fs.readdirSync(hooksRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const hookName = dirent.name;
    const handlerPath = path.join(hooksRoot, hookName, "handler.ts");
    if (!fs.existsSync(handlerPath)) {
      continue;
    }

    entries[`bundled/${hookName}/handler`] = handlerPath;
  }

  return entries;
}

const bundledHookEntries = buildBundledHookEntries();
const bundledPluginRoot = (pluginId: string) => ["extensions", pluginId].join("/");
const bundledPluginFile = (pluginId: string, relativePath: string) =>
  `${bundledPluginRoot(pluginId)}/${relativePath}`;

function buildCoreDistEntries(): Record<string, string> {
  const minimalCore = process.env.OPENCLAW_BUILD_CORE_MINIMAL === "1";
  if (minimalCore) {
    return {
      index: "src/index.ts",
    };
  }
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    "cli/daemon-cli": "src/cli/daemon-cli.ts",
    // Keep long-lived lazy runtime boundaries on stable filenames so rebuilt
    // dist/ trees do not strand already-running gateways on stale hashed chunks.
    "agents/auth-profiles.runtime": "src/agents/auth-profiles.runtime.ts",
    "agents/pi-model-discovery-runtime": "src/agents/pi-model-discovery-runtime.ts",
    "commands/status.summary.runtime": "src/commands/status.summary.runtime.ts",
    "plugins/provider-runtime.runtime": "src/plugins/provider-runtime.runtime.ts",
    "plugins/runtime/runtime-line.contract": "src/plugins/runtime/runtime-line.contract.ts",
    extensionAPI: "src/extensionAPI.ts",
    "infra/warning-filter": "src/infra/warning-filter.ts",
    "telegram/audit": bundledPluginFile("telegram", "src/audit.ts"),
    "telegram/token": bundledPluginFile("telegram", "src/token.ts"),
    "plugins/build-smoke-entry": "src/plugins/build-smoke-entry.ts",
    "plugins/runtime/index": "src/plugins/runtime/index.ts",
    "llm-slug-generator": "src/hooks/llm-slug-generator.ts",
    "mcp/plugin-tools-serve": "src/mcp/plugin-tools-serve.ts",
  };
}

const coreDistEntries = buildCoreDistEntries();

function buildUnifiedDistEntries(): Record<string, string> {
  const includeBundledPluginEntries = process.env.OPENCLAW_BUILD_BUNDLED_PLUGINS !== "0";
  const includeDockerE2eHarnessEntries = process.env.OPENCLAW_BUILD_DOCKER_E2E !== "0";
  const coreOnlyMode = process.env.OPENCLAW_BUILD_CORE_ONLY === "1";

  return {
    ...coreDistEntries,
    ...(includeDockerE2eHarnessEntries ? dockerE2eHarnessEntries : {}),
    ...(coreOnlyMode
      ? {}
      : {
          // Internal compat artifact for the root-alias.cjs lazy loader.
          "plugin-sdk/compat": "src/plugin-sdk/compat.ts",
          // Private bundled Codex helper for app-server native subagent task mirroring.
          "plugin-sdk/codex-native-task-runtime": "src/plugin-sdk/codex-native-task-runtime.ts",
          // Private bundled Codex helper for app-server user MCP config projection.
          "plugin-sdk/codex-mcp-projection": "src/plugin-sdk/codex-mcp-projection.ts",
          ...Object.fromEntries(
            Object.entries(buildPluginSdkEntrySources()).map(([entry, source]) => [
              `plugin-sdk/${entry}`,
              source,
            ]),
          ),
          ...(shouldBuildPrivateQaEntries
            ? {
                "plugin-sdk/qa-lab": "src/plugin-sdk/qa-lab.ts",
                "plugin-sdk/qa-runtime": "src/plugin-sdk/qa-runtime.ts",
              }
            : {}),
          ...(includeBundledPluginEntries
            ? listBundledPluginEntrySources(rootBundledPluginBuildEntries)
            : {}),
          ...bundledHookEntries,
        }),
  };
}

const splitCoreOnly = process.env.OPENCLAW_BUILD_CORE_ONLY === "1" && process.env.OPENCLAW_BUILD_CORE_SPLIT === "1";
const unifiedEntries = buildUnifiedDistEntries();
function splitEntries(entries: Record<string, string>) {
  const keys = Object.keys(entries).sort((a, b) => a.localeCompare(b));
  const mid = Math.ceil(keys.length / 2);
  const pick = (ks: string[]) => Object.fromEntries(ks.map((k) => [k, entries[k]!]));
  return [pick(keys.slice(0, mid)), pick(keys.slice(mid))] as const;
}
const configs = splitCoreOnly
  ? (() => {
      const [entriesA, entriesB] = splitEntries(unifiedEntries);
      return [
        nodeBuildConfig({
          clean: true,
          entry: entriesA,
          deps: {
            alwaysBundle: shouldAlwaysBundleDependency,
            neverBundle: shouldNeverBundleDependency,
          },
        }),
        nodeBuildConfig({
          clean: false,
          entry: entriesB,
          deps: {
            alwaysBundle: shouldAlwaysBundleDependency,
            neverBundle: shouldNeverBundleDependency,
          },
        }),
      ];
    })()
  : [
      nodeBuildConfig({
        // Build core entrypoints, plugin-sdk subpaths, bundled plugin entrypoints,
        // and bundled hooks in one graph so runtime singletons are emitted once.
        clean: true,
        entry: unifiedEntries,
        deps: {
          alwaysBundle: shouldAlwaysBundleDependency,
          neverBundle: shouldNeverBundleDependency,
        },
      }),
    ];

export default defineConfig(configs);
