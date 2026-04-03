import { describe, expect, it } from "vitest";
import { bundledPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  deps?: {
    neverBundle?: string[] | ((id: string) => boolean);
  };
  entry?: Record<string, string> | string[];
  inputOptions?: TsdownInputOptions;
  outDir?: string;
  outputOptions?: (options: unknown) => {
    chunkFileNames?: (chunkInfo: { name: string; moduleIds: string[] }) => string;
  };
};

type TsdownLog = {
  code?: string;
  message?: string;
  id?: string;
  importer?: string;
};

type TsdownOnLog = (
  level: string,
  log: TsdownLog,
  defaultHandler: (level: string, log: TsdownLog) => void,
) => void;

type TsdownInputOptions = (
  options: { onLog?: TsdownOnLog },
  format?: unknown,
  context?: unknown,
) => { onLog?: TsdownOnLog } | undefined;

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entryKeys(config: TsdownConfigEntry): string[] {
  if (!config.entry || Array.isArray(config.entry)) {
    return [];
  }
  return Object.keys(config.entry);
}

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

function unifiedDistGraph(): TsdownConfigEntry | undefined {
  return asConfigArray(tsdownConfig).find((config) =>
    entryKeys(config).includes("plugins/runtime/index"),
  );
}

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled root plugins, and bundled hooks in one dist graph", () => {
    const distGraph = unifiedDistGraph();

    expect(distGraph).toBeDefined();
    expect(entryKeys(distGraph as TsdownConfigEntry)).toEqual(
      expect.arrayContaining([
        "agents/auth-profiles.runtime",
        "agents/model-catalog.runtime",
        "agents/models-config.runtime",
        "subagent-registry.runtime",
        "agents/pi-model-discovery-runtime",
        "index",
        "commands/status.summary.runtime",
        "plugins/provider-discovery.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        bundledEntry("openai"),
        bundledEntry("msteams"),
        "bundled/boot-md/handler",
      ]),
    );
  });

  it("emits staged bundled plugins as separate extension graphs", () => {
    const stagedGraphs = asConfigArray(tsdownConfig).filter(
      (config) => typeof config.outDir === "string" && config.outDir.startsWith("dist/extensions/"),
    );

    expect(stagedGraphs.length).toBeGreaterThan(0);
    expect(stagedGraphs.every((config) => entryKeys(config).includes("index"))).toBe(true);
    expect(stagedGraphs.every((config) => !entryKeys(config).includes("plugin-sdk/index"))).toBe(
      true,
    );
    expect(stagedGraphs.some((config) => config.outDir === "dist/extensions/discord")).toBe(true);
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);

    expect(configs.some((config) => config.outDir === "dist/plugin-sdk")).toBe(false);
    expect(
      configs.some((config) =>
        Array.isArray(config.entry)
          ? config.entry.some((entry) => entry.includes("src/hooks/"))
          : false,
      ),
    ).toBe(false);
  });

  it("externalizes staged bundled plugin runtime dependencies", () => {
    const unifiedGraph = unifiedDistGraph();
    const neverBundle = unifiedGraph?.deps?.neverBundle;

    if (typeof neverBundle === "function") {
      expect(neverBundle("silk-wasm")).toBe(true);
      expect(neverBundle("ws")).toBe(true);
      expect(neverBundle("ws/lib/websocket.js")).toBe(true);
      expect(neverBundle("not-a-runtime-dependency")).toBe(false);
    } else {
      expect(neverBundle).toEqual(expect.arrayContaining(["silk-wasm", "ws"]));
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

    expect(handled).toEqual([]);
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

  it("routes bundled plugin shared chunks to their own directory", () => {
    const configs = asConfigArray(tsdownConfig);
    const unifiedGraph = configs.find((config) => entryKeys(config).includes("index"));
    expect(unifiedGraph).toBeDefined();

    // Extract the chunkFileNames function from outputOptions
    const outputOptionsFn = unifiedGraph!.outputOptions;
    expect(typeof outputOptionsFn).toBe("function");

    const outputOptions = outputOptionsFn!({});
    const chunkFileNames = outputOptions.chunkFileNames!;
    expect(typeof chunkFileNames).toBe("function");

    // Scenario 1: A chunk containing only slack files
    expect(
      chunkFileNames({
        name: "shared-slack-api",
        moduleIds: [
          "extensions/slack/src/api.ts",
          "extensions/slack/src/token.ts",
        ],
      }),
    ).toBe("extensions/slack/[name]-[hash].js");

    // Scenario 2: A chunk containing only telegram files
    expect(
      chunkFileNames({
        name: "shared-telegram-api",
        moduleIds: [
          "extensions/telegram/src/api.ts",
          "extensions/telegram/src/config.ts",
        ],
      }),
    ).toBe("extensions/telegram/[name]-[hash].js");

    // Scenario 3: A chunk containing mixed files (architectural violation)
    expect(
      chunkFileNames({
        name: "shared-mixed",
        moduleIds: [
          "extensions/slack/src/api.ts",
          "extensions/telegram/src/api.ts",
        ],
      }),
    ).toBe("[name]-[hash].js");

    // Scenario 4: A chunk containing only core files
    expect(
      chunkFileNames({
        name: "shared-core",
        moduleIds: [
          "src/gateway/server-http.ts",
          "src/gateway/client.ts",
        ],
      }),
    ).toBe("[name]-[hash].js");

    // Scenario 5: A chunk containing plugin and core files
    expect(
      chunkFileNames({
        name: "shared-plugin-and-core",
        moduleIds: [
          "extensions/slack/src/api.ts",
          "src/gateway/server-http.ts",
        ],
      }),
    ).toBe("[name]-[hash].js");

    // Scenario 5b: A chunk containing plugin files and virtual modules
    expect(
      chunkFileNames({
        name: "shared-plugin-with-virtual",
        moduleIds: [
          "extensions/slack/src/api.ts",
          "\0commonjsHelpers.js",
        ],
      }),
    ).toBe("extensions/slack/[name]-[hash].js");

    // Scenario 5c: A chunk containing plugin files and node_modules dependencies
    expect(
      chunkFileNames({
        name: "shared-plugin-with-deps",
        moduleIds: [
          "extensions/slack/src/api.ts",
          "node_modules/@slack/web-api/index.js",
        ],
      }),
    ).toBe("extensions/slack/[name]-[hash].js");

    // Scenario 6: Fallback to previous function
    const outputOptionsWithFn = outputOptionsFn!({
      chunkFileNames: () => "custom-fn-[hash].js",
    });
    expect(
      outputOptionsWithFn.chunkFileNames!({
        name: "shared-core",
        moduleIds: ["src/gateway/server-http.ts"],
      }),
    ).toBe("custom-fn-[hash].js");

    // Scenario 7: Fallback to previous string
    const outputOptionsWithStr = outputOptionsFn!({
      chunkFileNames: "custom-str-[hash].js",
    });
    expect(
      outputOptionsWithStr.chunkFileNames!({
        name: "shared-core",
        moduleIds: ["src/gateway/server-http.ts"],
      }),
    ).toBe("custom-str-[hash].js");
  });
});
