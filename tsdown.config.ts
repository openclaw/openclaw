import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsdown";
import pluginSdkEntryList from "./scripts/lib/plugin-sdk-entrypoints.json" with { type: "json" };

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
      // Suppress [EVAL] warnings from bottleneck's intentional eval usage
      // (obfuscation to prevent bundlers from inlining optional Redis modules).
      if (
        log.code === "EVAL" &&
        typeof (log as Record<string, unknown>).id === "string" &&
        ((log as Record<string, unknown>).id as string).includes("bottleneck")
      ) {
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

// Native binaries cannot be bundled by rolldown. These packages pull in .node
// files (e.g. @snazzah/davey as an optional dep of @discordjs/voice) that
// rolldown cannot load. Mark them as external so they are resolved at runtime.
const NEVER_BUNDLE = [
  "@snazzah/davey",
  "@snazzah/davey-darwin-arm64",
  "@snazzah/davey-darwin-x64",
  "@snazzah/davey-linux-x64-gnu",
  "@snazzah/davey-linux-arm64-gnu",
  "@discordjs/voice",
  "@discordjs/opus",
  "opusscript",
  "@lancedb/lancedb",
];

function nodeBuildConfig(config: Record<string, unknown>) {
  const existingDeps = (config.deps as Record<string, unknown> | undefined) ?? {};
  const existingNeverBundle = Array.isArray(existingDeps.neverBundle)
    ? (existingDeps.neverBundle as string[])
    : [];
  return {
    ...config,
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
    deps: {
      ...existingDeps,
      neverBundle: Array.from(new Set([...NEVER_BUNDLE, ...existingNeverBundle])),
    },
  };
}

// Derive entrypoints from the canonical JSON list, but only include entries
// that have a corresponding source file — entries added ahead of their source
// (e.g. device-bootstrap, imessage-core) are silently skipped until the
// source is created.
const pluginSdkEntrypoints = (pluginSdkEntryList as string[]).filter((e) =>
  existsSync(resolve("src/plugin-sdk", `${e}.ts`)),
);

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
      "channels/plugins/agent-tools/whatsapp-login":
        "src/channels/plugins/agent-tools/whatsapp-login.ts",
      "channels/plugins/actions/discord": "src/channels/plugins/actions/discord.ts",
      "channels/plugins/actions/signal": "src/channels/plugins/actions/signal.ts",
      "channels/plugins/actions/telegram": "src/channels/plugins/actions/telegram.ts",
      "telegram/audit": "extensions/telegram/src/audit.ts",
      "telegram/token": "extensions/telegram/src/token.ts",
      "line/accounts": "src/line/accounts.ts",
      "line/send": "src/line/send.ts",
      "line/template-messages": "src/line/template-messages.ts",
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
