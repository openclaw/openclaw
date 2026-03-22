import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

function buildInputOptions(options: { onLog?: unknown; [key: string]: unknown }) {
  if (process.env.OPENCLAW_BUILD_VERBOSE === "1") {
    return undefined;
  }

  const previousOnLog = typeof options.onLog === "function" ? options.onLog : undefined;

  return {
    ...options,
    onLog(
      level: string,
      log: { code?: string },
      defaultHandler: (level: string, log: { code?: string }) => void,
    ) {
      if (log.code === "PLUGIN_TIMINGS") {
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

function nodeBuildConfig(config: Record<string, unknown>) {
  return {
    ...config,
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
  };
}

const pluginSdkEntrypoints = [
  "index",
  "core",
  "compat",
  "telegram",
  "feishu",
  "diagnostics-otel",
  "diffs",
  "llm-task",
  "lobster",
  "memory-core",
  "memory-lancedb",
  "thread-ownership",
  "account-id",
  "keyed-async-queue",
] as const;

export default defineConfig([
  nodeBuildConfig({
    entry: "src/index.ts",
  }),
  nodeBuildConfig({
    entry: "src/entry.ts",
  }),
  nodeBuildConfig({
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    entry: "src/cli/daemon-cli.ts",
  }),
  nodeBuildConfig({
    entry: "src/infra/warning-filter.ts",
  }),
  nodeBuildConfig({
    // Keep sync lazy-runtime channel modules as concrete dist files.
    entry: {
      "channels/plugins/actions/telegram": "src/channels/plugins/actions/telegram.ts",
      "telegram/audit": "src/telegram/audit.ts",
      "telegram/token": "src/telegram/token.ts",
    },
  }),
  nodeBuildConfig({
    // Bundle all plugin-sdk entries in a single build so the bundler can share
    // common chunks instead of duplicating them per entry (~712MB heap saved).
    entry: Object.fromEntries(pluginSdkEntrypoints.map((e) => [e, `src/plugin-sdk/${e}.ts`])),
    outDir: "dist/plugin-sdk",
  }),
  nodeBuildConfig({
    entry: "src/extensionAPI.ts",
  }),
  nodeBuildConfig({
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
  }),
]);
