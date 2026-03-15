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
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
  "msteams",
  "acpx",
  "bluebubbles",
  "campfire",
  "copilot-proxy",
  "device-pair",
  "diagnostics-otel",
  "diffs",
  "feishu",
  "google-gemini-cli-auth",
  "googlechat",
  "irc",
  "llm-task",
  "lobster",
  "matrix",
  "mattermost",
  "memory-core",
  "memory-lancedb",
  "minimax-portal-auth",
  "nextcloud-talk",
  "nostr",
  "open-prose",
  "phone-control",
  "qwen-portal-auth",
  "synology-chat",
  "talk-voice",
  "test-utils",
  "thread-ownership",
  "tlon",
  "twitch",
  "voice-call",
  "zalo",
  "zalouser",
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
