// Main CLI startup policy helpers for fast paths, proxy startup, aliases, and missing commands.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  getCommandPositionalsWithRootOptions,
} from "../infra/cli-root-options.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type {
  resolveManifestCommandAliasOwner,
  resolveManifestCliCommandSurfaceOwner,
  resolveManifestToolOwner,
} from "../plugins/manifest-command-aliases.runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isSimpleCommandHelpInvocation } from "./argv.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";
import { isReservedNonPluginCommandRoot } from "./command-registration-policy.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";
import { getCoreCliParentDefaultHelpCommands } from "./program/core-command-descriptors.js";
import { getSubCliParentDefaultHelpCommands } from "./program/subcli-descriptors.js";

const ROOT_HELP_ALIASES = new Set(["tools", "help"]);
const SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS = new Set(["setup", "onboard", "configure"]);
const BARE_PARENT_DEFAULT_HELP_COMMANDS = new Set([
  ...getCoreCliParentDefaultHelpCommands(),
  ...getSubCliParentDefaultHelpCommands(),
]);
const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        return false;
      }
      sawGateway = true;
      continue;
    }

    const rootConsumed = consumeGatewayFastPathRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  return sawGateway;
}

export function isRemoteAgentDispatchInvocation(argv: string[], primary: string | null): boolean {
  return primary === "agent" && !argv.includes("--local");
}

export function isAgentExecInvocation(commandPath: string[]): boolean {
  return commandPath[0] === "agent" && commandPath[1] === "exec";
}

function isBareParentDefaultHelpArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  const [primary, extra] = invocation.commandPath;
  return !invocation.hasHelpOrVersion && primary !== undefined && extra === undefined
    ? BARE_PARENT_DEFAULT_HELP_COMMANDS.has(primary)
    : false;
}

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  // Preserve the old root --update spelling by rewriting before Commander registration.
  // Only rewrite --update while scanning the root-option prefix; once a command
  // or `--` appears, later --update tokens belong to that command's arguments.
  const updateIndex = argv.indexOf("--update");
  if (updateIndex === -1) {
    return argv;
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      return argv;
    }
    if (i === updateIndex) {
      return argv.toSpliced(updateIndex, 1, "update");
    }
    const consumed = consumeRootOptionToken(argv, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return argv;
    }
  }
  return argv;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (
    invocation.hasHelpOrVersion ||
    shouldHandleBareRoot(argv) ||
    isBareParentDefaultHelpArgv(argv)
  ) {
    return false;
  }
  return resolveCliCommandPathPolicy(invocation.commandPath).ensureCliPath;
}

export function shouldUseRootHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH !== "1" &&
    (invocation.isRootHelpInvocation ||
      (invocation.commandPath.length === 1 &&
        ROOT_HELP_ALIASES.has(invocation.commandPath[0] ?? "") &&
        invocation.hasHelpOrVersion))
  );
}

export function shouldUseSetupOnboardConfigureHelpFastPath(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1") {
    return false;
  }
  return isSimpleCommandHelpInvocation(argv, SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS);
}

export function shouldHandleBareRoot(argv: string[]): boolean {
  return (
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: [],
      maxPositionals: 1,
      mode: "command-path",
    })?.length === 0
  );
}

export function shouldStartProxyForCli(argv: string[]): boolean {
  const policyArgv = rewriteUpdateFlagArgv(argv);
  const invocation = resolveCliArgvInvocation(policyArgv);
  const [primary] = invocation.commandPath;
  if (invocation.hasHelpOrVersion || !primary) {
    return false;
  }
  if (isBareParentDefaultHelpArgv(policyArgv)) {
    return false;
  }
  return resolveCliNetworkProxyPolicy(policyArgv) === "default";
}

export function isDebugProxyCaptureEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  );
}

export function shouldBootstrapCliProxyBeforeFastPath(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isDebugProxyCaptureEnvEnabled(env)) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => normalizeOptionalString(env[key]) !== undefined);
}

function formatExcludedPluginCommand(command: string, owner: string): string {
  return owner === command
    ? `The \`openclaw ${command}\` command is unavailable because ` +
        `\`plugins.allow\` excludes "${command}". Add "${command}" to ` +
        `\`plugins.allow\` if you want that bundled plugin CLI surface.`
    : `"${command}" is not a plugin; it is a command provided by the ` +
        `"${owner}" plugin. Add "${owner}" to \`plugins.allow\` ` +
        `instead of "${command}".`;
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: {
    resolveCommandAliasOwner?: typeof resolveManifestCommandAliasOwner;
    resolveToolOwner?: typeof resolveManifestToolOwner;
    resolveCliCommandSurfaceOwner?: typeof resolveManifestCliCommandSurfaceOwner;
  },
): string | null {
  const normalizedPluginId = normalizeLowercaseStringOrEmpty(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const allow =
    Array.isArray(config?.plugins?.allow) && config.plugins.allow.length > 0
      ? config.plugins.allow
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeOptionalLowercaseString(entry))
          .filter(Boolean)
      : [];
  const commandAlias = options?.resolveCommandAliasOwner?.({
    command: normalizedPluginId,
    config,
  });
  const parentPluginId = commandAlias?.pluginId;
  if (parentPluginId) {
    if (allow.length > 0 && !allow.includes(parentPluginId)) {
      return formatExcludedPluginCommand(normalizedPluginId, parentPluginId);
    }
    if (config?.plugins?.entries?.[parentPluginId]?.enabled === false) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
        `\`plugins.entries.${parentPluginId}.enabled=false\`. Re-enable that entry if you want ` +
        "the bundled plugin command surface."
      );
    }
    if (
      commandAlias.kind !== "runtime-slash" &&
      commandAlias.enabledByDefault !== true &&
      config?.plugins?.entries?.[parentPluginId]?.enabled !== true
    ) {
      return (
        `The \`openclaw ${normalizedPluginId}\` command is provided by the ` +
        `"${parentPluginId}" plugin, but that bundled plugin is disabled by default. Run ` +
        `\`openclaw plugins enable ${parentPluginId}\` to enable that CLI surface.`
      );
    }
    if (commandAlias.kind === "runtime-slash") {
      const cliHint = commandAlias.cliCommand
        ? `Use \`openclaw ${commandAlias.cliCommand}\` for related CLI operations, or `
        : "Use ";
      return (
        `"${normalizedPluginId}" is a runtime slash command (/${normalizedPluginId}), not a CLI command. ` +
        `It is provided by the "${parentPluginId}" plugin. ` +
        `${cliHint}\`/${normalizedPluginId}\` in a chat session.`
      );
    }
  }

  if (isReservedNonPluginCommandRoot(normalizedPluginId)) {
    return null;
  }

  const toolOwner = options?.resolveToolOwner?.({
    toolName: normalizedPluginId,
    config,
  });
  if (toolOwner) {
    // Availability metadata does not override the owning plugin's allowlist or disablement.
    const ownerEnabled =
      config?.plugins?.entries?.[toolOwner.pluginId]?.enabled !== false &&
      (allow.length === 0 || allow.includes(toolOwner.pluginId));
    if (ownerEnabled) {
      // Per-account / per-tool runtime gates (e.g. Feishu's
      // channels.feishu.enabled / tools.<x> toggles) are not declarable as
      // manifest configSignals, so a positive manifest-availability signal
      // proves "could be loaded if config permits", not "currently registered".
      // Soften the wording when the runtime resolver could only prove
      // manifest-level ownership.
      if (toolOwner.availability === "manifest-only") {
        return (
          `"${normalizedPluginId}" may be provided by the "${toolOwner.pluginId}" plugin ` +
          `as an agent tool, not a CLI subcommand. ` +
          "Run `openclaw --help` to see available CLI subcommands."
        );
      }
      return (
        `"${normalizedPluginId}" is an agent tool available from the "${toolOwner.pluginId}" plugin, ` +
        `not a CLI subcommand. Use it from an agent turn (model tool-use), not the CLI. ` +
        "Run `openclaw --help` to see available CLI subcommands."
      );
    }
  }

  if (allow.length > 0 && !allow.includes(normalizedPluginId)) {
    if (parentPluginId && allow.includes(parentPluginId)) {
      return null;
    }
    const cliCommandSurfaceOwner = options?.resolveCliCommandSurfaceOwner?.({
      command: normalizedPluginId,
      config,
    });
    const normalizedCliCommandSurfaceOwner =
      normalizeOptionalLowercaseString(cliCommandSurfaceOwner);
    if (!normalizedCliCommandSurfaceOwner) {
      return null;
    }
    if (allow.includes(normalizedCliCommandSurfaceOwner)) {
      return null;
    }
    return formatExcludedPluginCommand(normalizedPluginId, normalizedCliCommandSurfaceOwner);
  }
  if (config?.plugins?.entries?.[normalizedPluginId]?.enabled === false) {
    return (
      `The \`openclaw ${normalizedPluginId}\` command is unavailable because ` +
      `\`plugins.entries.${normalizedPluginId}.enabled=false\`. Re-enable that entry if you want ` +
      "the bundled plugin CLI surface."
    );
  }
  return null;
}
