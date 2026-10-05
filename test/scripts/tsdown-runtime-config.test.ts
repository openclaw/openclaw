// Covers bundling rules encoded in the root tsdown config.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import type { TsdownPluginOption } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginSdkPackageExports } from "../../scripts/lib/plugin-sdk-entries.mts";
import { importFreshModule } from "../../src/plugin-sdk/test-helpers/import-fresh.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../src/state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import tsdownConfig, {
  createStateSchemaInlinePlugin,
  STATE_SCHEMA_INLINE_PLUGIN_NAME,
} from "../../tsdown.config.ts";
import { stripNodeTypeScriptTypes } from "../helpers/node-toolchain.js";

type TsdownConfigEntry = {
  deps?: {
    alwaysBundle?: string[] | ((id: string) => boolean);
    neverBundle?: string[] | ((id: string) => boolean);
  };
  entry?: Record<string, string> | string[];
  inputOptions?: TsdownInputOptions;
  minify?: unknown;
  dts?: boolean | { emitDtsOnly?: boolean };
  define?: Record<string, unknown>;
  outputOptions?: { codeSplitting?: boolean; chunkFileNames?: string };
  outExtensions?: () => { js: string };
  outDir?: string;
  plugins?: TsdownPluginOption;
};

type TsdownLog = {
  code?: string;
  message?: string;
  id?: string;
  importer?: string;
  plugin?: string;
};

type TsdownOnLog = (
  level: string,
  log: TsdownLog,
  defaultHandler: (level: string, log: TsdownLog) => void,
) => void;

type TsdownInputOptions = (
  options: { external?: TsdownExternalOption; onLog?: TsdownOnLog },
  format?: unknown,
  context?: unknown,
) => { external?: TsdownExternalOption; onLog?: TsdownOnLog } | undefined;

type TsdownExternalOption = string | RegExp | Array<string | RegExp> | TsdownExternalFunction;

type TsdownExternalFunction = (
  id: string,
  parentId: string | undefined,
  isResolved: boolean,
) => boolean | null | undefined;

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

// Keep config assertions aligned with tsdown's nested, async plugin slots.
async function resolvePluginNames(plugins: TsdownPluginOption): Promise<string[]> {
  const resolved = await plugins;
  if (!resolved) {
    return [];
  }
  if (Array.isArray(resolved)) {
    return (await Promise.all(resolved.map(resolvePluginNames))).flat();
  }
  if (!("name" in resolved)) {
    throw new Error("expected a named plugin in build config assertions");
  }
  return [resolved.name];
}

function entryKeys(config: TsdownConfigEntry): string[] {
  if (!config.entry || Array.isArray(config.entry)) {
    return [];
  }
  return Object.keys(config.entry);
}

function entrySources(config: TsdownConfigEntry): Record<string, string> {
  if (!config.entry || Array.isArray(config.entry)) {
    return {};
  }
  return config.entry;
}

function requireStandaloneRuntimeGraph(entry: string): TsdownConfigEntry {
  const graphs = asConfigArray(tsdownConfig).filter(
    (config) =>
      !(typeof config.dts === "object" && config.dts.emitDtsOnly) &&
      entryKeys(config).includes(entry),
  );
  expect(graphs).toHaveLength(1);
  return expectDefined(graphs[0], `${entry} standalone graph`);
}

function requireNativeHookRelayGraph(): TsdownConfigEntry {
  const graphs = asConfigArray(tsdownConfig).filter((config) =>
    entryKeys(config).includes("native-hook-relay/entry"),
  );
  expect(graphs).toHaveLength(1);
  return expectDefined(graphs[0], "native hook relay graph");
}

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

function unifiedDistGraph(): TsdownConfigEntry | undefined {
  return asConfigArray(tsdownConfig).find((config) =>
    entryKeys(config).includes("plugins/runtime/index"),
  );
}

function requireUnifiedDistGraph(): TsdownConfigEntry {
  const distGraph = unifiedDistGraph();
  if (!distGraph) {
    throw new Error("expected unified dist graph");
  }
  return distGraph;
}

function readGatewayRunLoopSource(): string {
  return readFileSync(new URL("../../src/cli/gateway-cli/run-loop.ts", import.meta.url), "utf8");
}

function readAgentAuthDiscoverySource(): string {
  return readFileSync(new URL("../../src/agents/agent-auth-discovery.ts", import.meta.url), "utf8");
}

afterEach(() => vi.unstubAllEnvs());

describe("tsdown config", () => {
  it.each(["0", "1"])(
    "emits QA transport facades only for private QA builds (%s)",
    async (mode) => {
      vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", mode);
      const { default: selectedConfigs } = await importFreshModule<
        typeof import("../../tsdown.config.ts")
      >(import.meta.url, `../../tsdown.config.ts?private-qa=${mode}`);
      const runtimeEntries = asConfigArray(selectedConfigs)
        .filter((config) => !(typeof config.dts === "object" && config.dts.emitDtsOnly))
        .flatMap((config) => Object.entries(entrySources(config)));
      const packageExports = buildPluginSdkPackageExports();
      for (const subpath of ["qa-channel", "qa-channel-protocol", "qa-lab", "qa-runtime"]) {
        const matches = runtimeEntries.filter(([name]) => name === `plugin-sdk/${subpath}`);
        expect(matches).toEqual(
          mode === "1" ? [[`plugin-sdk/${subpath}`, `src/plugin-sdk/${subpath}.ts`]] : [],
        );
        expect(Object.hasOwn(packageExports, `./plugin-sdk/${subpath}`)).toBe(false);
      }
    },
  );

  it("minifies only the sealed deploy worker while preserving runtime names", () => {
    const configs = asConfigArray(tsdownConfig);
    const deployWorker = configs.find((config) => entryKeys(config).includes("worker/worker"));
    const rsyncReceiver = configs.find((config) =>
      entryKeys(config).includes("worker/workspace-rsync-receiver"),
    );
    const githubExecLauncher = configs.find((config) =>
      entryKeys(config).includes("worker/github-exec-launcher"),
    );

    expect(deployWorker?.minify).toEqual({
      codegen: true,
      compress: true,
      mangle: { keepNames: true },
    });
    expect(rsyncReceiver?.minify).toBeUndefined();
    expect(githubExecLauncher?.minify).toBeUndefined();
    expect(requireUnifiedDistGraph().minify).toBeUndefined();
  });

  it.each([
    {
      exportName: "OPENCLAW_STATE_SCHEMA_SQL",
      modulePath: "src/state/openclaw-state-schema.ts",
      schemaPath: "src/state/openclaw-state-schema.sql",
      sourceValue: OPENCLAW_STATE_SCHEMA_SQL,
    },
    {
      exportName: "OPENCLAW_AGENT_SCHEMA_SQL",
      modulePath: "src/state/openclaw-agent-schema.ts",
      schemaPath: "src/state/openclaw-agent-schema.sql",
      sourceValue: OPENCLAW_AGENT_SCHEMA_SQL,
    },
  ])("inlines canonical schema bytes for $modulePath", (schema) => {
    const rootDir = process.cwd();
    const watchedPaths: string[] = [];
    const plugin = createStateSchemaInlinePlugin(rootDir);
    let cacheKeyGenerator: ((context: { id: string }) => string | undefined) | undefined;
    plugin.configureVitest({
      defineCacheKeyGenerator: (generator) => {
        cacheKeyGenerator = generator;
      },
    });
    const result = plugin.load.call(
      { addWatchFile: (filePath: string) => watchedPaths.push(filePath) },
      path.resolve(rootDir, schema.modulePath),
    );
    const schemaPath = path.resolve(rootDir, schema.schemaPath);
    const canonicalSql = readFileSync(schemaPath, "utf8");

    expect(result).not.toBeNull();
    const match = result?.code.match(
      new RegExp(`^export const ${schema.exportName} = (.*);\\n$`, "su"),
    );
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "null")).toBe(canonicalSql);
    expect(schema.sourceValue).toBe(canonicalSql);
    expect(watchedPaths).toEqual([schemaPath]);
    expect(cacheKeyGenerator?.({ id: path.resolve(rootDir, schema.modulePath) })).toBe(
      canonicalSql,
    );
    expect(cacheKeyGenerator?.({ id: path.resolve(rootDir, "src/index.ts") })).toBeUndefined();
  });

  it("installs schema inlining only on executable runtime graphs", async () => {
    const configs = asConfigArray(tsdownConfig);
    const unifiedGraph = requireUnifiedDistGraph();
    const workerGraph = configs.find(
      (config) => entrySources(config)["worker/worker"] === "src/worker/worker-deploy-entry.ts",
    );
    const handoffGraph = configs.find((config) =>
      entryKeys(config).includes("managed-handoff-runtime"),
    );
    const activationGraph = configs.find((config) =>
      entryKeys(config).includes("package-update-activation-recovery"),
    );
    const executableGraphs = new Set([
      unifiedGraph,
      expectDefined(workerGraph, "deploy worker graph"),
      requireStandaloneRuntimeGraph("worker/code-mode-node.worker"),
      requireStandaloneRuntimeGraph("worker/file-tool-planning.worker"),
      requireStandaloneRuntimeGraph("worker/image-processor.worker"),
      requireStandaloneRuntimeGraph("worker/owner-dacl-batch-worker"),
      requireStandaloneRuntimeGraph("worker/sqlite-store.worker"),
      requireStandaloneRuntimeGraph("worker/openclaw-state-read.worker"),
      requireStandaloneRuntimeGraph("worker/worker-native-lifecycle.worker"),
      expectDefined(handoffGraph, "managed handoff graph"),
      expectDefined(activationGraph, "package activation graph"),
      requireNativeHookRelayGraph(),
      requireStandaloneRuntimeGraph("infra/sqlite-readonly-location.worker"),
      requireStandaloneRuntimeGraph("infra/sqlite-source-revision.worker"),
      requireStandaloneRuntimeGraph("state/openclaw-state-read.worker"),
      requireStandaloneRuntimeGraph("agents/harness/native-hook-relay-client.worker"),
      requireStandaloneRuntimeGraph("process/spawn-broker/worker"),
      requireStandaloneRuntimeGraph("state/openclaw-state-lease-heartbeat.worker"),
      requireStandaloneRuntimeGraph("infra/gateway-state-owner-heartbeat.worker"),
      requireStandaloneRuntimeGraph("process/supervisor/service-child-relay"),
      requireStandaloneRuntimeGraph("process/supervisor/service-child-group-anchor"),
      requireStandaloneRuntimeGraph("tooling/managed-memory-launcher"),
    ]);

    for (const config of configs) {
      const inlinePlugins = (await resolvePluginNames(config.plugins)).filter(
        (name) => name === STATE_SCHEMA_INLINE_PLUGIN_NAME,
      );
      expect(inlinePlugins, entryKeys(config).join(", ")).toHaveLength(
        executableGraphs.has(config) ? 1 : 0,
      );
    }
  });

  it("isolates relay startup from shared runtime chunks while retaining lazy fallback", async () => {
    const relay = requireNativeHookRelayGraph();
    expect(entrySources(relay)).toEqual({
      "native-hook-relay/entry": "src/cli/native-hook-relay-entry.ts",
    });
    expect(relay).not.toBe(requireUnifiedDistGraph());
    expect(relay.dts).toBe(false);
    expect(relay.outputOptions?.codeSplitting).not.toBe(false);
    expect(relay.outputOptions?.chunkFileNames).toBe("native-hook-relay/[name]-[hash].mjs");
    // Only the shared graph may publish the global plugin ownership manifest.
    expect(await resolvePluginNames(relay.plugins)).not.toContain(
      "openclaw:runtime-dependency-ownership",
    );
  });

  it("keeps core, plugin runtime, plugin-sdk, bundled root plugins, and bundled hooks in one dist graph", () => {
    const distGraph = requireUnifiedDistGraph();

    const keys = entryKeys(distGraph);
    for (const entry of [
      "acp/control-plane/manager",
      "agents/auth-profiles.runtime",
      "agents/model-catalog.runtime",
      "agents/models-config.runtime",
      "cli/gateway-lifecycle.runtime",
      "agents/compaction-planning.worker",
      "config/sessions/session-accessor.sqlite-archive.worker",
      "plugin-sdk/sqlite-runtime",
      "state/openclaw-database-verify.worker",
      "plugins/memory-state",
      "subagent-registry.runtime",
      "link-understanding/apply.runtime",
      "media-understanding/apply.runtime",
      "index",
      "commands/status.summary.runtime",
      "docker-healthcheck",
      "provider-dispatcher.runtime",
      "plugins/hook-runner-global",
      "plugins/provider-discovery.runtime",
      "plugins/provider-runtime.runtime",
      "plugins/runtime/index",
      "plugins/synthetic-auth.runtime",
      "web-fetch/runtime",
      "mcp/openclaw-tools-serve",
      "mcp/plugin-tools-serve",
      bundledEntry("active-memory"),
      "bundled/boot-md/handler",
    ]) {
      expect(keys).toContain(entry);
    }
  });

  it.each([
    {
      label: "read-only snapshot child",
      entry: "infra/sqlite-readonly-location.worker",
      source: "src/infra/sqlite-readonly-location.worker.ts",
    },
    {
      label: "raw source revision child",
      entry: "infra/sqlite-source-revision.worker",
      source: "src/infra/sqlite-source-revision.worker.ts",
    },
    {
      label: "shared-state reader",
      entry: "state/openclaw-state-read.worker",
      source: "src/state/openclaw-state-read.worker.ts",
    },
    {
      label: "native hook locator worker",
      entry: "agents/harness/native-hook-relay-client.worker",
      source: "src/agents/harness/native-hook-relay-client.worker.ts",
    },
    {
      label: "spawn broker",
      entry: "process/spawn-broker/worker",
      source: "src/process/spawn-broker/worker.ts",
    },
    {
      label: "state lease heartbeat",
      entry: "state/openclaw-state-lease-heartbeat.worker",
      source: "src/state/openclaw-state-lease-heartbeat.worker.ts",
    },
  ])("emits the $label once without sealing its package loaders", ({ entry, source }) => {
    const child = requireStandaloneRuntimeGraph(entry);
    expect(entrySources(child)).toEqual({ [entry]: path.resolve(source) });
    expect(child.outputOptions).toEqual({ codeSplitting: false });
    expect(child.outExtensions?.().js).toBe(".js");
    expect(child.define?.SEALED_RUNTIME_BUILD).toBeUndefined();
  });

  it.each([
    ["docker-healthcheck", "src/docker-healthcheck.ts"],
    ["cli/gateway-lifecycle.runtime", "src/cli/gateway-cli/lifecycle.runtime.ts"],
    [
      "config/sessions/session-transcript-reconcile",
      "src/config/sessions/session-transcript-reconcile.ts",
    ],
    ["provider-dispatcher.runtime", "src/auto-reply/reply/provider-dispatcher.runtime.ts"],
    ["plugins/hook-runner-global", "src/plugins/hook-runner-global.ts"],
    ["gateway/worker-environments/runtime", "src/gateway/worker-environments/runtime.ts"],
    // Already-running v2026.9.1 Gateways lazily load this reload entry.
    ["gateway/plugin-channel-reload-targets", "src/gateway/plugin-channel-reload-targets.ts"],
    [
      "telegram-ingress-worker.runtime",
      "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
    ],
  ])("keeps %s behind its stable root dist entry", (entry, source) => {
    expect(entrySources(requireUnifiedDistGraph())[entry]).toBe(source);
  });

  it("emits the dist modules referenced by every Docker client", () => {
    const emittedPaths = new Set(
      asConfigArray(tsdownConfig)
        .filter((config) => !(typeof config.dts === "object" && config.dts.emitDtsOnly))
        .flatMap((config) =>
          entryKeys(config).map((entry) =>
            path.resolve(
              config.outDir ?? "dist",
              `${entry}${config.outExtensions?.().js ?? ".js"}`,
            ),
          ),
        ),
    );
    const clients = ["test/e2e", "scripts/e2e"].flatMap((root) => {
      const clientRoot = new URL(`../../${root}/`, import.meta.url);
      return readdirSync(clientRoot, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith("-docker-client.ts"))
        .map((file) => new URL(file, clientRoot));
    });
    expect(clients.length).toBeGreaterThan(0);
    for (const clientUrl of clients) {
      const runtimeSource = stripNodeTypeScriptTypes(readFileSync(clientUrl, "utf8"));
      // Include literal paths assigned to variables used by dynamic imports, but not erased types.
      for (const match of runtimeSource.matchAll(
        /["'`]((?:\.{1,2}\/)+dist\/[^"'`\s]+\.[cm]?js)["'`]/gu,
      )) {
        const specifier = expectDefined(match[1], "Docker dist module path");
        expect(emittedPaths, `${fileURLToPath(clientUrl)}: ${specifier}`).toContain(
          fileURLToPath(new URL(specifier, clientUrl)),
        );
      }
    }
  });

  it("keeps root-package-excluded external plugins out of the root dist graph", () => {
    const distGraph = requireUnifiedDistGraph();
    const keys = entryKeys(distGraph);
    const hasPluginEntry = (pluginId: string) =>
      keys.some((entry) => entry.startsWith(`${bundledPluginRoot(pluginId)}/`));

    expect(hasPluginEntry("amazon-bedrock")).toBe(false);
    expect(hasPluginEntry("amazon-bedrock-mantle")).toBe(false);
  });

  it("keeps PI model discovery synthetic auth refs behind one stable runtime dist entry", () => {
    const distGraph = requireUnifiedDistGraph();
    const importSpecifiers = [
      ...readAgentAuthDiscoverySource().matchAll(
        /from ["']([^"']*synthetic-auth\.runtime\.js)["']/gu,
      ),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual(["../plugins/synthetic-auth.runtime.js"]);
    expect(entrySources(distGraph)["plugins/synthetic-auth.runtime"]).toBe(
      "src/plugins/synthetic-auth.runtime.ts",
    );
  });

  it("routes gateway run-loop lifecycle imports through the stable runtime boundary", () => {
    const importSpecifiers = [
      ...readGatewayRunLoopSource().matchAll(/import\(["']([^"']+)["']\)/gu),
    ].map((match) => match[1]);

    expect(new Set(importSpecifiers)).toEqual(new Set(["./lifecycle.runtime.js"]));
  });

  it("keeps bundled plugins out of separate dependency-staging graphs", () => {
    const extensionGraphs = asConfigArray(tsdownConfig).filter(
      (config) => typeof config.outDir === "string" && config.outDir.startsWith("dist/extensions/"),
    );

    expect(extensionGraphs).toStrictEqual([]);
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const hookEntries = configs.flatMap((config) =>
      Array.isArray(config.entry)
        ? config.entry.filter((entry) => entry.includes("src/hooks/"))
        : [],
    );

    expect(configs.map((config) => config.outDir)).not.toContain("dist/plugin-sdk");
    expect(hookEntries).toStrictEqual([]);
  });

  it("bundles SDK-owned helpers while retaining native package ownership", () => {
    for (const graph of [
      requireUnifiedDistGraph(),
      requireStandaloneRuntimeGraph("infra/sqlite-readonly-location.worker"),
    ]) {
      const alwaysBundle = graph.deps?.alwaysBundle;
      const external = graph.inputOptions?.({})?.external;
      if (typeof alwaysBundle !== "function" || typeof external !== "function") {
        throw new Error("expected runtime graph dependency predicates");
      }

      expect(alwaysBundle("@openclaw/fs-safe")).toBe(false);
      expect(alwaysBundle("@openclaw/fs-safe/path")).toBe(false);
      expect(external("@openclaw/fs-safe/path", undefined, false)).toBe(true);
      expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime-internal")).toBe(true);
      expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime")).toBe(false);
      expect(alwaysBundle("zod")).toBe(true);
      expect(alwaysBundle("zod/v4/core")).toBe(true);
      for (const id of ["typebox", "typebox/schema", "typebox/format", "typebox/system"]) {
        expect(alwaysBundle(id)).toBe(false);
        expect(external(id, undefined, false)).toBe(true);
      }
      expect(alwaysBundle("not-a-runtime-dependency")).toBe(false);
    }
  });

  it("suppresses unresolved imports from extension source", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];

    configured?.(
      "warn",
      {
        code: "UNRESOLVED_IMPORT",
        message: "Could not resolve '@azure/identity' in extensions/msteams/src/sdk.ts",
      },
      (_level, log) => handled.push(log),
    );

    expect(handled).toStrictEqual([]);
  });

  it("keeps unresolved imports outside extension source visible", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];
    const log = {
      code: "UNRESOLVED_IMPORT",
      message: "Could not resolve 'missing-dependency' in src/index.ts",
    };

    configured?.("warn", log, (_level, forwardedLog) => handled.push(forwardedLog));

    expect(handled).toEqual([log]);
  });

  it("suppresses rolldown-plugin-dts CommonJS dts warnings from bundled zod locales", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];

    configured?.(
      "warn",
      {
        code: "PLUGIN_WARNING",
        plugin: "rolldown-plugin-dts:fake-js",
        message:
          "/abs/path/node_modules/zod/v4/locales/ur.d.cts uses CommonJS dts syntax. CommonJS dts modules cannot be reliably bundled by rolldown-plugin-dts. Please mark this module as external in your Rolldown config.",
      },
      (_level, log) => handled.push(log),
    );

    expect(handled).toStrictEqual([]);
  });

  it("keeps other rolldown-plugin-dts warnings visible", () => {
    const configured = unifiedDistGraph()?.inputOptions?.({})?.onLog;
    const handled: TsdownLog[] = [];
    const log = {
      code: "PLUGIN_WARNING",
      plugin: "rolldown-plugin-dts:fake-js",
      message: "some other dts warning that should not be hidden",
    };

    configured?.("warn", log, (_level, forwardedLog) => handled.push(forwardedLog));

    expect(handled).toEqual([log]);
  });
});
