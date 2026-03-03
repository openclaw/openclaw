/**
 * IMAP Hook Operations
 *
 * Setup wizard and long-running service for the himalaya-based IMAP watcher.
 */

import { hasBinary } from "../agents/skills.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  type OpenClawConfig,
  CONFIG_PATH,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { displayPath } from "../utils.js";
import { generateHookToken, mergeHookPresets, normalizeHooksPath } from "./gmail.js";
import { checkAccount } from "./imap-himalaya.js";
import {
  buildDefaultImapHookUrl,
  DEFAULT_IMAP_FOLDER,
  DEFAULT_IMAP_MAX_BYTES,
  DEFAULT_IMAP_POLL_INTERVAL_SECONDS,
  DEFAULT_IMAP_QUERY,
  type ImapHookOverrides,
  resolveImapHookRuntimeConfig,
} from "./imap.js";

export type ImapSetupOptions = {
  account: string;
  folder?: string;
  pollInterval?: number;
  includeBody?: boolean;
  maxBytes?: number;
  markSeen?: boolean;
  hookUrl?: string;
  hookToken?: string;
  himalayaConfig?: string;
  query?: string;
  json?: boolean;
};

export type ImapRunOptions = {
  account?: string;
  folder?: string;
  pollInterval?: number;
  includeBody?: boolean;
  maxBytes?: number;
  markSeen?: boolean;
  hookUrl?: string;
  hookToken?: string;
  himalayaConfig?: string;
  query?: string;
};

export async function runImapSetup(opts: ImapSetupOptions) {
  // Check himalaya is installed.
  if (!hasBinary("himalaya")) {
    throw new Error(
      "himalaya not installed; install it and retry (https://github.com/pimalaya/himalaya)",
    );
  }

  // Validate account connectivity.
  const accountCheck = await checkAccount({
    account: opts.account,
    config: opts.himalayaConfig,
  });
  if (!accountCheck.ok) {
    throw new Error(
      `himalaya account check failed: ${accountCheck.error}\nRun 'himalaya account configure ${opts.account}' to set up the account.`,
    );
  }

  const configSnapshot = await readConfigFileSnapshot();
  if (!configSnapshot.valid) {
    throw new Error(`Config invalid: ${CONFIG_PATH}`);
  }

  const baseConfig = configSnapshot.config;
  const hooksPath = normalizeHooksPath(baseConfig.hooks?.path);
  const hookToken = opts.hookToken ?? baseConfig.hooks?.token ?? generateHookToken();

  const folder = opts.folder ?? DEFAULT_IMAP_FOLDER;
  const pollIntervalSeconds = opts.pollInterval ?? DEFAULT_IMAP_POLL_INTERVAL_SECONDS;
  const includeBody = opts.includeBody ?? true;
  const maxBytes = opts.maxBytes ?? DEFAULT_IMAP_MAX_BYTES;
  const markSeen = opts.markSeen ?? true;
  const query = opts.query ?? DEFAULT_IMAP_QUERY;

  const hookUrl =
    opts.hookUrl ??
    baseConfig.hooks?.imap?.hookUrl ??
    buildDefaultImapHookUrl(hooksPath, resolveGatewayPort(baseConfig));

  const nextConfig: OpenClawConfig = {
    ...baseConfig,
    hooks: {
      ...baseConfig.hooks,
      enabled: true,
      path: hooksPath,
      token: hookToken,
      presets: mergeHookPresets(baseConfig.hooks?.presets, "imap"),
      imap: {
        ...baseConfig.hooks?.imap,
        account: opts.account,
        folder,
        pollIntervalSeconds,
        includeBody,
        maxBytes,
        markSeen,
        hookUrl,
        himalayaConfig: opts.himalayaConfig?.trim() || undefined,
        query,
      },
    },
  };

  const validated = validateConfigObjectWithPlugins(nextConfig);
  if (!validated.ok) {
    throw new Error(`Config validation failed: ${validated.issues[0]?.message ?? "invalid"}`);
  }
  await writeConfigFile(validated.config);

  const summary = {
    account: opts.account,
    folder,
    pollIntervalSeconds,
    hookUrl,
    hookToken,
    markSeen,
    includeBody,
    maxBytes,
    query,
  };

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(summary, null, 2));
    return;
  }

  defaultRuntime.log("IMAP hooks configured:");
  defaultRuntime.log(`- account: ${opts.account}`);
  defaultRuntime.log(`- folder: ${folder}`);
  defaultRuntime.log(`- poll interval: ${pollIntervalSeconds}s`);
  defaultRuntime.log(`- hook url: ${hookUrl}`);
  defaultRuntime.log(`- config: ${displayPath(CONFIG_PATH)}`);
  defaultRuntime.log(`Next: ${formatCliCommand("openclaw webhooks imap run")}`);
}

export async function runImapService(opts: ImapRunOptions) {
  if (!hasBinary("himalaya")) {
    throw new Error(
      "himalaya not installed; install it and retry (https://github.com/pimalaya/himalaya)",
    );
  }

  const config = loadConfig();

  const overrides: ImapHookOverrides = {
    account: opts.account,
    folder: opts.folder,
    pollIntervalSeconds: opts.pollInterval,
    includeBody: opts.includeBody,
    maxBytes: opts.maxBytes,
    markSeen: opts.markSeen,
    hookUrl: opts.hookUrl,
    hookToken: opts.hookToken,
    himalayaConfig: opts.himalayaConfig,
    query: opts.query,
  };

  const resolved = resolveImapHookRuntimeConfig(config, overrides);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  const runtimeConfig = resolved.value;

  defaultRuntime.log(
    `Starting IMAP watcher for ${runtimeConfig.account} (poll every ${runtimeConfig.pollIntervalSeconds}s)`,
  );

  // Import and start the watcher directly.
  const { startImapWatcher, stopImapWatcher } = await import("./imap-watcher.js");
  await startImapWatcher(config, overrides);

  // Keep process alive and handle signals for graceful shutdown.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void stopImapWatcher().then(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
