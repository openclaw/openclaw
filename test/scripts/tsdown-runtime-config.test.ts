// Covers bundling rules encoded in the root tsdown config.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import type { TsdownPluginOption, UserConfig } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginSdkPackageExports } from "../../scripts/lib/plugin-sdk-entries.mts";
import { importFreshModule } from "../../src/plugin-sdk/test-helpers/import-fresh.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import tsdownConfig, {
  createStateSchemaInlinePlugin,
  STATE_SCHEMA_INLINE_PLUGIN_NAME,
} from "../../tsdown.config.ts";

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

function entrySources(config: UserConfig): Record<string, string | string[]> {
  if (!config.entry || typeof config.entry !== "object" || Array.isArray(config.entry)) {
    return {};
  }
  return config.entry;
}

function runtimeGraph(entry: string) {
  const graphs = tsdownConfig.filter(
    (config) =>
      !(typeof config.dts === "object" && config.dts.emitDtsOnly) &&
      Object.hasOwn(entrySources(config), entry),
  );
  expect(graphs).toHaveLength(1);
  return expectDefined(graphs[0], `${entry} runtime graph`);
}

async function inputOptions(config: UserConfig) {
  if (typeof config.inputOptions !== "function") {
    throw new Error("expected runtime input options factory");
  }
  return config.inputOptions({}, "es", { cjsDts: false });
}

afterEach(() => vi.unstubAllEnvs());

describe("tsdown config", () => {
  it("builds the public runtime-artifacts export", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.exports["./runtime-artifacts"]).toEqual({
      types: "./dist/runtime-artifacts.d.ts",
      default: "./dist/runtime-artifacts.js",
    });
    expect(entrySources(runtimeGraph("runtime-artifacts"))["runtime-artifacts"]).toBe(
      "src/runtime-artifacts.ts",
    );
  });

  it("keeps isolated and unselected plugin workers out of the host build graph", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "0");
    const { default: selectedConfigs } = await importFreshModule<
      typeof import("../../tsdown.config.ts")
    >(import.meta.url, "../../tsdown.config.ts?isolated-worker-build");
    const host = expectDefined(
      selectedConfigs.find((config) =>
        Object.hasOwn(entrySources(config), "plugins/runtime/index"),
      ),
      "host build graph",
    );
    const sources = Object.values(entrySources(host))
      .flat()
      .map((source) =>
        path.relative(process.cwd(), path.resolve(source)).replaceAll(path.sep, "/"),
      );
    for (const plugin of [
      "codex",
      "discord",
      "imessage",
      "memory-lancedb",
      "onnx",
      "team-reports",
      "qa-lab",
    ]) {
      expect(sources.filter((source) => source.startsWith(`extensions/${plugin}/`))).toEqual([]);
    }
  });

  it.each(["0", "1"])(
    "emits QA transport facades only for private QA builds (%s)",
    async (mode) => {
      vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", mode);
      const { default: selectedConfigs } = await importFreshModule<
        typeof import("../../tsdown.config.ts")
      >(import.meta.url, `../../tsdown.config.ts?private-qa=${mode}`);
      const runtimeEntries = selectedConfigs
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

  it("inlines canonical schema bytes and invalidates the transform cache", () => {
    const rootDir = process.cwd();
    const modulePath = path.resolve("src/state/openclaw-state-schema.ts");
    const schemaPath = path.resolve("src/state/openclaw-state-schema.sql");
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
      modulePath,
    );
    const canonicalSql = readFileSync(schemaPath, "utf8");

    const match = result?.code.match(/^export const OPENCLAW_STATE_SCHEMA_SQL = (.*);\n$/su);
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "null")).toBe(canonicalSql);
    expect(OPENCLAW_STATE_SCHEMA_SQL).toBe(canonicalSql);
    expect(watchedPaths).toEqual([schemaPath]);
    expect(cacheKeyGenerator?.({ id: modulePath })).toBe(canonicalSql);
    expect(cacheKeyGenerator?.({ id: path.resolve(rootDir, "src/index.ts") })).toBeUndefined();
  });

  it("installs schema inlining only on executable runtime graphs", async () => {
    for (const entry of [
      "plugins/runtime/index",
      "worker/worker",
      "managed-handoff-runtime",
      "package-update-activation-recovery",
      "native-hook-relay/entry",
      "infra/sqlite-readonly-location.worker",
      // Regression: the transcript reader moved out of the shared graph (#182259).
      "config/sessions/session-transcript.worker",
    ]) {
      const inlinePlugins = (await resolvePluginNames(runtimeGraph(entry).plugins)).filter(
        (name) => name === STATE_SCHEMA_INLINE_PLUGIN_NAME,
      );
      expect(inlinePlugins, entry).toHaveLength(1);
    }
    for (const config of tsdownConfig.filter(
      (candidate) => typeof candidate.dts === "object" && candidate.dts.emitDtsOnly,
    )) {
      expect(await resolvePluginNames(config.plugins)).not.toContain(
        STATE_SCHEMA_INLINE_PLUGIN_NAME,
      );
    }
  });

  it("isolates relay startup from shared runtime chunks while retaining lazy fallback", async () => {
    const relay = runtimeGraph("native-hook-relay/entry");
    expect(entrySources(relay)).toEqual({
      "native-hook-relay/entry": "src/cli/native-hook-relay-entry.ts",
    });
    expect(relay).not.toBe(runtimeGraph("plugins/runtime/index"));
    expect(relay.dts).toBe(false);
    expect(relay.outputOptions).not.toHaveProperty("codeSplitting", false);
    expect(relay.outputOptions).toHaveProperty(
      "chunkFileNames",
      "native-hook-relay/[name]-[hash].mjs",
    );
    // Only the shared graph may publish the global plugin ownership manifest.
    expect(await resolvePluginNames(relay.plugins)).not.toContain(
      "openclaw:runtime-dependency-ownership",
    );
  });

  it.each([
    "plugins/plugin-generation-preparation.worker",
    "infra/sqlite-readonly-location.worker",
    "infra/sqlite-source-revision.worker",
  ])("emits %s once without sealing its package loaders", (entry) => {
    const child = runtimeGraph(entry);
    expect(entrySources(child)).toEqual({ [entry]: path.resolve(`src/${entry}.ts`) });
    expect(child.outputOptions).toMatchObject({
      codeSplitting:
        entry === "infra/sqlite-readonly-location.worker" ||
        entry === "plugins/plugin-generation-preparation.worker",
    });
    if (entry === "plugins/plugin-generation-preparation.worker") {
      expect(child.outputOptions).toHaveProperty(
        "chunkFileNames",
        "plugins/plugin-preparation-[name]-[hash].mjs",
      );
    }
    expect(child.outExtensions?.({ options: {}, format: "es" })?.js).toBe(".js");
    expect(child.define?.SEALED_RUNTIME_BUILD).toBeUndefined();
  });

  it.each([
    [
      "config/sessions/session-transcript-reconcile",
      "src/config/sessions/session-transcript-reconcile.ts",
    ],
    [
      "telegram-ingress-worker.runtime",
      "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
    ],
  ])("keeps %s behind its stable root dist entry", (entry, source) => {
    const actual = entrySources(runtimeGraph("plugins/runtime/index"))[entry];
    if (typeof actual !== "string") {
      throw new Error(`expected one source for ${entry}`);
    }
    expect(path.resolve(actual)).toBe(path.resolve(source));
  });

  it("bundles SDK-owned helpers while retaining native package ownership", async () => {
    for (const [graph, bundleFsSafe] of [
      [runtimeGraph("plugins/runtime/index"), false],
      [runtimeGraph("infra/sqlite-readonly-location.worker"), true],
    ] as const) {
      const alwaysBundle = graph.deps?.alwaysBundle;
      const external = (await inputOptions(graph))?.external;
      if (typeof alwaysBundle !== "function" || typeof external !== "function") {
        throw new Error("expected runtime graph dependency predicates");
      }

      expect(alwaysBundle("@openclaw/fs-safe/path", undefined)).toBe(bundleFsSafe);
      expect(external("@openclaw/fs-safe/path", undefined, false)).toBe(!bundleFsSafe);
      for (const specifier of ["@openclaw/proc-safe/windows-job"]) {
        expect(alwaysBundle(specifier.split("/").slice(0, 2).join("/"), undefined)).toBe(false);
        expect(alwaysBundle(specifier, undefined)).toBe(false);
        expect(external(specifier, undefined, false)).toBe(true);
      }
      expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime-internal", undefined)).toBe(true);
      expect(alwaysBundle("openclaw/plugin-sdk/ssrf-runtime", undefined)).toBe(false);
      expect(alwaysBundle("zod", undefined)).toBe(true);
      expect(alwaysBundle("zod/v4/core", undefined)).toBe(true);
      for (const id of ["typebox", "typebox/schema"]) {
        expect(alwaysBundle(id, undefined)).toBe(false);
        expect(external(id, undefined, false)).toBe(true);
      }
      expect(alwaysBundle("not-a-runtime-dependency", undefined)).toBe(false);
    }
  });

  it("suppresses unresolved imports from extension source", async () => {
    const configured = (await inputOptions(runtimeGraph("plugins/runtime/index")))?.onLog;
    const handled: unknown[] = [];

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
});
