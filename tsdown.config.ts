import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";
import { buildPluginSdkEntrySources } from "./scripts/lib/plugin-sdk-entries.mjs";

const env = {
  NODE_ENV: "production",
};

function buildInputOptions(options: { onLog?: unknown; [key: string]: unknown }) {
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
    return haystack.includes("@protobufjs/inquire/index.js");
  }

  return {
    ...options,
    onLog(
      level: string,
      log: { code?: string; message?: string; id?: string; importer?: string },
      defaultHandler: (level: string, log: { code?: string }) => void,
    ) {
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

function nodeBuildConfig(config: Record<string, unknown>) {
  return {
    ...config,
    env,
    fixedExtension: false,
    platform: "node",
    inputOptions: buildInputOptions,
  };
}

function listBundledPluginBuildEntries(): Record<string, string> {
  const extensionsRoot = path.join(process.cwd(), "extensions");
  const entries: Record<string, string> = {};

  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    const packageJsonPath = path.join(pluginDir, "package.json");
    let packageEntries: string[] = [];
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: { extensions?: unknown; setupEntry?: unknown };
        };
        packageEntries = Array.isArray(packageJson.openclaw?.extensions)
          ? packageJson.openclaw.extensions.filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
            )
          : [];
        const setupEntry =
          typeof packageJson.openclaw?.setupEntry === "string" &&
          packageJson.openclaw.setupEntry.trim().length > 0
            ? packageJson.openclaw.setupEntry
            : undefined;
        if (setupEntry) {
          packageEntries = Array.from(new Set([...packageEntries, setupEntry]));
        }
      } catch {
        packageEntries = [];
      }
    }

    const sourceEntries = packageEntries.length > 0 ? packageEntries : ["./index.ts"];
    for (const entry of sourceEntries) {
      const normalizedEntry = entry.replace(/^\.\//, "");
      const entryKey = `extensions/${dirent.name}/${normalizedEntry.replace(/\.[^.]+$/u, "")}`;
      entries[entryKey] = path.join("extensions", dirent.name, normalizedEntry);
    }
  }

  return entries;
}

const bundledPluginBuildEntries = listBundledPluginBuildEntries();

function buildCoreDistEntries(): Record<string, string> {
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    "cli/daemon-cli": "src/cli/daemon-cli.ts",
    "infra/warning-filter": "src/infra/warning-filter.ts",
    // Keep sync lazy-runtime channel modules as concrete dist files.
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
  };
}

const coreDistEntries = buildCoreDistEntries();

export default defineConfig([
  nodeBuildConfig({
    // Build the root dist entrypoints together so they can share hashed chunks
    // instead of emitting near-identical copies across separate builds.
    entry: coreDistEntries,
  }),
  nodeBuildConfig({
    // Bundle all plugin-sdk entries in a single build so the bundler can share
    // common chunks instead of duplicating them per entry (~712MB heap saved).
    entry: buildPluginSdkEntrySources(),
    outDir: "dist/plugin-sdk",
  }),
  nodeBuildConfig({
    // Bundle bundled plugin entrypoints so built gateway startup can load JS
    // directly from dist/extensions instead of transpiling extensions/*.ts via Jiti.
    entry: bundledPluginBuildEntries,
    outDir: "dist",
    deps: {
      neverBundle: ["@lancedb/lancedb"],
    },
  }),
  nodeBuildConfig({
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
  }),
]);
