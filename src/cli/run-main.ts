// Main CLI entry orchestration: fast paths, env setup, plugin aliases, and Commander dispatch.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command as CommanderCommand, Option as CommanderOption } from "commander";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { FLAG_TERMINATOR, isValueToken } from "../infra/cli-root-options.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
} from "./argv.js";
import {
  isReservedNonPluginCommandRoot,
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import { hasJsonOutputFlag, withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { formatCliCommandSuggestions } from "./program/command-suggestions.js";
import { getCoreCliCommandNames } from "./program/core-command-descriptors.js";
import { getSubCliEntries } from "./program/subcli-descriptors.js";
import {
  resolvePrecomputedSubcommandHelpFastPath,
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseNodesHelpFastPath,
  shouldUseRootHelpFastPath,
  shouldUseSecretsHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { createGatewayStartupTrace } from "./startup-trace.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

export {
  resolvePrecomputedSubcommandHelpFastPath,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseNodesHelpFastPath,
  shouldUseRootHelpFastPath,
  shouldUseSecretsHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";

const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const loadRootHelpLiveConfigModule = async () => await import("./root-help-live-config.js");
const loadRootHelpMetadataModule = async () => await import("./root-help-metadata.js");
const loadLoggingModule = async () => await import("../logging.js");
const loadCliRegistryLoaderModule = async () => await import("../plugins/cli-registry-loader.js");
const loadManifestCommandAliasesRuntimeModule = async () =>
  await import("../plugins/manifest-command-aliases.runtime.js");
const loadProxyLifecycleModule = async () => await import("../infra/net/proxy/proxy-lifecycle.js");
const loadCrestodianModule = async () => await import("../crestodian/crestodian.js");
const loadProgressModule = async () => await import("./progress.js");

function isRemoteAgentDispatchInvocation(argv: string[], primary: string | null): boolean {
  return primary === "agent" && !argv.includes("--local");
}

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

function isGatewayRunInvocationArgv(argv: string[]): boolean {
  const commandPath = resolveGatewayCatalogCommandPath(argv);
  return (
    commandPath?.length === 1 ||
    (commandPath?.length === 2 && commandPath[0] === "gateway" && commandPath[1] === "run")
  );
}

async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
    { enableConsoleCapture },
    { ensureCliExecutionBootstrap },
    { defaultRuntime },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run-command.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
      loadLoggingModule(),
      import("./command-execution-startup.js"),
      import("../runtime.js"),
    ]),
  );
  const commandPath = resolveGatewayCatalogCommandPath(argv) ?? ["gateway"];
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
  });
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  const beforeRun = async (opts: { force?: boolean; reset?: boolean }) => {
    let beforeStateMigrations: ((snapshot?: ConfigFileSnapshot) => Promise<boolean>) | undefined;
    const shouldBootstrap = await startupTrace.measure("gateway-run-pre-bootstrap", async () => {
      const { prepareGatewayRunBootstrap, recheckGatewayRunBootstrap } =
        await import("./gateway-cli/pre-bootstrap.js");
      const prepared = await prepareGatewayRunBootstrap({ opts, runtime: defaultRuntime });
      if (prepared) {
        beforeStateMigrations = (snapshot) =>
          recheckGatewayRunBootstrap({
            opts,
            runtime: defaultRuntime,
            ...(snapshot ? { snapshot } : {}),
          });
      }
      return prepared;
    });
    if (!shouldBootstrap) {
      return;
    }
    await startupTrace.measure("gateway-run-bootstrap", async () => {
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath,
        startupPolicy,
        loadPlugins: false,
        ...(beforeStateMigrations ? { beforeStateMigrations } : {}),
      });
      const { reloadTrustedGatewayRunEnvironment } = await import("./gateway-cli/pre-bootstrap.js");
      await reloadTrustedGatewayRunEnvironment({ runtime: defaultRuntime });
    });
  };
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
    { beforeRun },
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
    { beforeRun },
  );
  enableConsoleCapture();
  try {
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
    if (!hasMemoryRuntime()) {
      return;
    }
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // Best-effort teardown for short-lived CLI processes. Package updates can
    // replace hashed chunks before this finalizer runs.
  }
}

async function disposeCliAgentHarnesses(): Promise<void> {
  try {
    const { listRegisteredAgentHarnesses, disposeRegisteredAgentHarnesses } =
      await import("../agents/harness/registry.js");
    if (listRegisteredAgentHarnesses().length === 0) {
      return;
    }
    await disposeRegisteredAgentHarnesses();
  } catch {
    // Best-effort teardown for short-lived CLI commands. Harness plugins may
    // own subprocesses, but cleanup must not hide the command's real outcome.
  }
}

const UNCONFIGURED_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);

function isUnconfiguredConfigSnapshot(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig">,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.valid) {
    return false;
  }
  return Object.keys(snapshot.sourceConfig).every((key) =>
    UNCONFIGURED_CONFIG_IGNORED_KEYS.has(key),
  );
}

export async function shouldStartOnboardingForFreshInstall(argv: string[]): Promise<boolean> {
  if (!shouldStartCrestodianForBareRoot(argv)) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  return isUnconfiguredConfigSnapshot(snapshot);
}

type BareRootLaunchTarget =
  | { kind: "onboarding" }
  | { kind: "tui"; local: boolean; gatewayUrl?: string }
  | { kind: "crestodian" };

async function resolveBareRootLaunchTarget(argv: string[]): Promise<BareRootLaunchTarget | null> {
  if (!shouldStartCrestodianForBareRoot(argv)) {
    return null;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (isUnconfiguredConfigSnapshot(snapshot)) {
    return { kind: "onboarding" };
  }
  if (!snapshot.valid) {
    return { kind: "crestodian" };
  }
  return resolveConfiguredTuiLaunchTarget(snapshot.config ?? snapshot.sourceConfig);
}

async function resolveConfiguredTuiLaunchTarget(
  config: OpenClawConfig,
): Promise<BareRootLaunchTarget> {
  const gatewayUrl = await resolveReachableGatewayUrl(config);
  if (gatewayUrl) {
    return { kind: "tui", local: false, gatewayUrl };
  }
  return { kind: "tui", local: true };
}

async function resolveReachableGatewayUrl(config: OpenClawConfig): Promise<string | null> {
  const target = await resolveGatewayProbeTarget(config);
  if (!target) {
    return null;
  }
  const gateway = config.gateway;
  const remoteAuth = target.auth === "remote";
  const [token, password] = await Promise.all([
    resolveGatewayProbeSecret({
      config,
      value: remoteAuth ? gateway?.remote?.token : gateway?.auth?.token,
      path: remoteAuth ? "gateway.remote.token" : "gateway.auth.token",
    }),
    resolveGatewayProbeSecret({
      config,
      value: remoteAuth ? gateway?.remote?.password : gateway?.auth?.password,
      path: remoteAuth ? "gateway.remote.password" : "gateway.auth.password",
    }),
  ]);
  const { probeGatewayReachable } = await import("../commands/onboard-helpers.js");
  const probe = await probeGatewayReachable({
    url: target.url,
    ...(token ? { token } : {}),
    ...(password ? { password } : {}),
  });
  return probe.ok ? target.url : null;
}

async function resolveGatewayProbeTarget(
  config: OpenClawConfig,
): Promise<{ url: string; auth: "local" | "remote" } | null> {
  const remoteUrl = normalizeOptionalString(config.gateway?.remote?.url);
  if (normalizeOptionalString(config.gateway?.mode) === "remote" && remoteUrl) {
    const url = await resolveValidatedRemoteGatewayUrl(config);
    return url ? { url, auth: "remote" } : null;
  }
  return { url: await resolveLocalGatewayWebSocketUrl(config), auth: "local" };
}

async function resolveValidatedRemoteGatewayUrl(config: OpenClawConfig): Promise<string | null> {
  try {
    const { buildGatewayConnectionDetailsWithResolvers } =
      await import("../gateway/connection-details.js");
    return buildGatewayConnectionDetailsWithResolvers({
      config,
      ignoreEnvUrlOverride: true,
    }).url;
  } catch {
    return null;
  }
}

async function resolveGatewayProbeSecret(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    const { resolveSetupSecretInputString } = await import("../wizard/setup.secret-input.js");
    return await resolveSetupSecretInputString(params);
  } catch {
    return undefined;
  }
}

async function resolveLocalGatewayWebSocketUrl(config: OpenClawConfig): Promise<string> {
  const [{ resolveGatewayPort }, { resolveControlUiLinks }] = await Promise.all([
    import("../config/paths.js"),
    import("../gateway/control-ui-links.js"),
  ]);
  const gateway = config.gateway;
  const links = resolveControlUiLinks({
    port: resolveGatewayPort(config),
    bind: "loopback",
    basePath: gateway?.controlUi?.basePath,
    tlsEnabled: gateway?.tls?.enabled === true,
  });
  return links.wsUrl;
}

function pauseNonTtyStdinForCliExit(): void {
  const stdin = process.stdin;
  if (stdin.isTTY) {
    return;
  }
  try {
    stdin.pause();
  } catch {
    // Best-effort cleanup for command paths that only inspected stdin.
  }
}

export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

function findCommandOption(command: CommanderCommand, token: string): CommanderOption | undefined {
  const equalsIndex = token.indexOf("=");
  const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  return command.options.find((option) => option.long === flag || option.short === flag);
}

function findSubcommand(command: CommanderCommand, name: string): CommanderCommand | undefined {
  return command.commands.find(
    (subcommand) => subcommand.name() === name || subcommand.aliases().includes(name),
  );
}

function shouldOptionConsumeFollowingToken(
  option: CommanderOption | undefined,
  token: string,
  next: string | undefined,
): boolean {
  if (!option || token.includes("=")) {
    return false;
  }
  if (option.required) {
    return true;
  }
  return option.optional && isValueToken(next);
}

function isNoColorConsumedAsCommandOptionValue(
  program: CommanderCommand,
  remainingArgs: readonly string[],
  noColorIndex: number,
): boolean {
  let command = program;
  let pendingValue = false;
  for (let index = 0; index < noColorIndex; index += 1) {
    const arg = remainingArgs[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = findCommandOption(command, arg);
      if (!option && index === noColorIndex - 1 && !arg.includes("=")) {
        // Unknown option surfaces may allow arbitrary flags; keep the value-safe behavior there.
        return true;
      }
      pendingValue = shouldOptionConsumeFollowingToken(option, arg, remainingArgs[index + 1]);
      continue;
    }
    command = findSubcommand(command, arg) ?? command;
  }
  return pendingValue;
}

function isLogLevelConsumedAsCommandOption(
  program: CommanderCommand,
  remainingArgs: readonly string[],
  logLevelIndex: number,
): boolean {
  let command = program;
  let pendingValue = false;
  for (let index = 0; index < logLevelIndex; index += 1) {
    const arg = remainingArgs[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const option = findCommandOption(command, arg);
      if (!option && index === logLevelIndex - 1 && !arg.includes("=")) {
        return true;
      }
      pendingValue = shouldOptionConsumeFollowingToken(option, arg, remainingArgs[index + 1]);
      continue;
    }
    command = findSubcommand(command, arg) ?? command;
  }

  if (pendingValue) {
    return true;
  }

  const arg = remainingArgs[logLevelIndex];
  return command !== program && arg !== undefined && findCommandOption(command, arg) !== undefined;
}

function normalizeRootNoColorArgvForProgram(argv: string[], program: CommanderCommand): string[] {
  return normalizeRootNoColorArgv(argv, {
    shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
      isNoColorConsumedAsCommandOptionValue(program, remainingArgs, noColorIndex),
  });
}

function normalizeRootLogLevelArgvForProgram(argv: string[], program: CommanderCommand): string[] {
  return normalizeRootLogLevelArgv(argv, {
    shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
      isLogLevelConsumedAsCommandOption(program, remainingArgs, logLevelIndex),
  });
}

async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

function shouldBootstrapCliProxyBeforeFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  ) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isKnownBuiltInCommandRoot(primary: string): boolean {
  return (
    getCoreCliCommandNames().includes(primary) ||
    getSubCliEntries().some((entry) => entry.name === primary)
  );
}

async function isPluginCliRoot(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<boolean | null> {
  try {
    const { resolvePluginCliRootOwnerIds } = await loadCliRegistryLoaderModule();
    const ownerIds = await resolvePluginCliRootOwnerIds({
      cfg: params.config,
      env: process.env,
      primaryCommand: params.primary,
    });
    return ownerIds === null ? null : ownerIds.length > 0;
  } catch {
    return null;
  }
}

function createAllowlistAgnosticCliLookupConfig(config: OpenClawConfig): OpenClawConfig {
  if (!Array.isArray(config.plugins?.allow) || config.plugins.allow.length === 0) {
    return config;
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      allow: [],
    },
  };
}

async function resolveCliCommandSurfaceOwner(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string | undefined> {
  const { resolveManifestCliCommandSurfaceOwner } = await loadManifestCommandAliasesRuntimeModule();
  const manifestOwner = resolveManifestCliCommandSurfaceOwner({
    command: params.primary,
    config: params.config,
    env: process.env,
  });
  if (manifestOwner) {
    return manifestOwner;
  }
  try {
    const { resolvePluginCliRootOwnerIds } = await loadCliRegistryLoaderModule();
    return (
      await resolvePluginCliRootOwnerIds({
        cfg: createAllowlistAgnosticCliLookupConfig(params.config),
        env: process.env,
        primaryCommand: params.primary,
      })
    )?.[0];
  } catch {
    return undefined;
  }
}

function resolveUnownedCliPrimaryCandidate(argv: string[]): string | null {
  const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(argv));
  const { primary } = invocation;
  if (
    !primary ||
    primary === "help" ||
    isReservedNonPluginCommandRoot(primary) ||
    isKnownBuiltInCommandRoot(primary)
  ) {
    return null;
  }
  return primary;
}

async function resolveUnownedCliPrimary(params: {
  argv: string[];
  config: OpenClawConfig;
}): Promise<string | null> {
  const primary = resolveUnownedCliPrimaryCandidate(params.argv);
  if (!primary) {
    return null;
  }
  const pluginRoot = await isPluginCliRoot({ primary, config: params.config });
  if (pluginRoot !== false) {
    return null;
  }
  return primary;
}

async function resolveUnownedCliPrimaryMessage(params: {
  primary: string;
  config: OpenClawConfig;
}): Promise<string> {
  const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
    await loadManifestCommandAliasesRuntimeModule();
  const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner(params);
  const pluginPolicyMessage = resolveMissingPluginCommandMessageFromPolicy(
    params.primary,
    params.config,
    {
      resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
      resolveToolOwner: resolveManifestToolOwner,
      resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
    },
  );
  if (pluginPolicyMessage) {
    return pluginPolicyMessage;
  }
  const suggestion = formatCliCommandSuggestions(params.primary);
  return [
    `Unknown command: openclaw ${params.primary}. No built-in command or plugin CLI metadata owns "${params.primary}".`,
    suggestion,
  ]
    .filter(Boolean)
    .join("\n");
}

async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayStartupTrace>,
  options: { ensureDispatcher?: boolean } = {},
): Promise<void> {
  const [
    { initializeDebugProxyCapture, finalizeDebugProxyCapture },
    { maybeWarnAboutDebugProxyCoverage },
  ] = await startupTrace.measure("proxy-imports", () =>
    Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
  );
  initializeDebugProxyCapture("cli");
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  if (options.ensureDispatcher !== false) {
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  }
  maybeWarnAboutDebugProxyCoverage();
}

export async function runCli(argv: string[] = process.argv) {
  const originalArgv = normalizeWindowsArgv(argv);
  const startupTrace = createGatewayStartupTrace(originalArgv, "cli.main");
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }
  const normalizedArgv = normalizeRootHelpTargetArgv(normalizeRootNoColorArgv(parsedProfile.argv));
  const normalizedInvocation = resolveCliArgvInvocation(normalizedArgv);
  const isHelpOrVersionInvocation = normalizedInvocation.hasHelpOrVersion;
  const isGatewayRunInvocation = isGatewayRunInvocationArgv(normalizedArgv);
  startupTrace.mark("argv");

  // Enforce the minimum supported runtime before gateway selection can read or recover config.
  assertSupportedRuntime();

  if (!isHelpOrVersionInvocation && (isGatewayRunInvocation || shouldLoadCliDotEnv())) {
    await startupTrace.measure("dotenv", async () => {
      if (isRemoteAgentDispatchInvocation(normalizedArgv, normalizedInvocation.primary)) {
        const { loadGatewayDispatchCliDotEnv } = await import("./gateway-dispatch-dotenv.js");
        await loadGatewayDispatchCliDotEnv({ quiet: true });
      } else {
        const { loadCliDotEnv } = await import("./dotenv.js");
        loadCliDotEnv({ loadGlobalEnv: !isGatewayRunInvocation, quiet: true });
      }
    });
  }
  if (!isHelpOrVersionInvocation && isGatewayRunInvocation) {
    await startupTrace.measure("gateway-run-select-environment", async () => {
      const [{ selectGatewayRunEnvironment }, { defaultRuntime }] = await Promise.all([
        import("./gateway-cli/pre-bootstrap.js"),
        import("../runtime.js"),
      ]);
      const opts = resolveGatewayRunPreBootstrapOptions(normalizedArgv) ?? {};
      await selectGatewayRunEnvironment({ opts, runtime: defaultRuntime });
    });
  }
  normalizeEnv();
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // Activate operator-managed proxy routing for network-capable commands.
  // Local Gateway/control-plane commands keep direct loopback access while
  // runtime, provider, plugin, update, and manifest/metadata-owned plugin commands route egress.
  let proxyHandle: ProxyHandle | null = null;
  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;
  let bestEffortConfigPromise: Promise<OpenClawConfig> | null = null;
  const isolateProxyConfigEnv = isGatewayRunInvocation;
  const readBestEffortCliConfig = async (): Promise<OpenClawConfig> => {
    if (!bestEffortConfigPromise) {
      bestEffortConfigPromise = import("../config/io.js").then(({ readBestEffortConfig }) =>
        readBestEffortConfig(
          isolateProxyConfigEnv ? { isolateEnv: true, observe: false } : undefined,
        ),
      );
    }
    return await bestEffortConfigPromise;
  };
  const uninstallProxySignalHandlers = () => {
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
      onSigterm = null;
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
      onSigint = null;
    }
    if (onExit) {
      process.off("exit", onExit);
      onExit = null;
    }
  };
  const stopStartedProxy = async () => {
    uninstallProxySignalHandlers();
    const handle = proxyHandle;
    proxyHandle = null;
    if (handle) {
      const { stopProxy } = await loadProxyLifecycleModule();
      await stopProxy(handle);
    }
  };
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };
  const installProxySignalHandlers = () => {
    if (!proxyHandle || onSigterm || onSigint || onExit) {
      return;
    }
    const shutdown = (exitCode: number) => {
      void stopStartedProxy().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  };
  const replaceStartedProxy = async (config: OpenClawConfig["proxy"]) => {
    await stopStartedProxy();
    const { startProxy } = await loadProxyLifecycleModule();
    proxyHandle = await startProxy(config);
    installProxySignalHandlers();
  };
  if (!isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv)) {
    const config = await readBestEffortCliConfig();
    const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
    if (unownedPrimary) {
      throw new Error(await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }));
    }
    await replaceStartedProxy(config?.proxy ?? undefined);
  }

  let uninstallGatewayRunRuntimeHooks: (() => void) | null = null;
  if (!isHelpOrVersionInvocation && isGatewayRunInvocation) {
    const { installGatewayRunRuntimeHooks } = await import("./gateway-cli/runtime-hooks.js");
    uninstallGatewayRunRuntimeHooks = installGatewayRunRuntimeHooks({
      releaseManagedProxy: stopStartedProxy,
      refreshManagedProxy: replaceStartedProxy,
    });
  }

  try {
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { loadRootHelpRenderOptionsForConfigSensitivePlugins } =
        await loadRootHelpLiveConfigModule();
      const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(
        process.env,
      );
      if (!liveRootHelpOptions) {
        const { outputPrecomputedRootHelpText } = await loadRootHelpMetadataModule();
        if (outputPrecomputedRootHelpText()) {
          return;
        }
      }
      const { outputRootHelp } = await import("./program/root-help.js");
      await outputRootHelp(liveRootHelpOptions ?? undefined);
      return;
    }

    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    if (shouldUseSetupOnboardConfigureHelpFastPath(normalizedArgv)) {
      const { tryOutputSetupOnboardConfigureHelp } =
        await import("./setup-onboard-configure-help-fast-path.js");
      if (await tryOutputSetupOnboardConfigureHelp(normalizedArgv)) {
        return;
      }
    }

    if (shouldUseSecretsHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedSecretsHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedSecretsHelpText()) {
        return;
      }
    }

    const precomputedSubcommandHelp = resolvePrecomputedSubcommandHelpFastPath(normalizedArgv);
    if (precomputedSubcommandHelp) {
      const { outputPrecomputedSubcommandHelpText } = await loadRootHelpMetadataModule();
      if (outputPrecomputedSubcommandHelpText(precomputedSubcommandHelp)) {
        return;
      }
    }

    if (shouldUseNodesHelpFastPath(normalizedArgv)) {
      const { loadRootHelpRenderOptionsForConfigSensitivePlugins } =
        await loadRootHelpLiveConfigModule();
      const liveRootHelpOptions = await loadRootHelpRenderOptionsForConfigSensitivePlugins(
        process.env,
      );
      if (!liveRootHelpOptions) {
        const { outputPrecomputedNodesHelpText } = await loadRootHelpMetadataModule();
        if (outputPrecomputedNodesHelpText()) {
          return;
        }
      }
    }

    // Reject unowned command roots before help/version routing, so that
    // `openclaw <typo> --help` surfaces the same Unknown command error as
    // `openclaw <typo>` instead of silently showing generic top-level help.
    // Runs after legitimate precomputed help fast paths so known help commands
    // still dispatch normally. See #81077.
    {
      const unownedPrimaryCandidate = resolveUnownedCliPrimaryCandidate(normalizedArgv);
      if (unownedPrimaryCandidate) {
        const config = await readBestEffortCliConfig();
        const unownedPrimary = await resolveUnownedCliPrimary({ argv: normalizedArgv, config });
        if (unownedPrimary) {
          throw new Error(
            await resolveUnownedCliPrimaryMessage({ primary: unownedPrimary, config }),
          );
        }
      }
    }

    const shouldRunBareRootCommand = shouldStartCrestodianForBareRoot(normalizedArgv);
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
    if (shouldRunBareRootCommand || shouldRunModernOnboardCrestodian) {
      await ensureCliEnvProxyDispatcher();
    }
    const bareRootLaunchTarget = shouldRunBareRootCommand
      ? await resolveBareRootLaunchTarget(normalizedArgv)
      : null;

    if (bareRootLaunchTarget) {
      if (bareRootLaunchTarget.kind === "onboarding") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
          );
          process.exitCode = 1;
          return;
        }
        const { setupWizardCommand } = await import("../commands/onboard.js");
        await setupWizardCommand({});
        return;
      }
      if (bareRootLaunchTarget.kind === "tui") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error(
            "OpenClaw TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.",
          );
          process.exitCode = 1;
          return;
        }
        const { launchTuiCli } = await import("../tui/tui-launch.js");
        await launchTuiCli(
          {
            deliver: false,
            ...(bareRootLaunchTarget.local ? { local: true } : {}),
          },
          {
            ...(bareRootLaunchTarget.gatewayUrl
              ? { gatewayUrl: bareRootLaunchTarget.gatewayUrl, authSource: "config" as const }
              : {}),
          },
        );
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await loadCrestodianModule();
      const { createCliProgress } = await loadProgressModule();
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return;
    }

    if (shouldRunModernOnboardCrestodian) {
      const { runCrestodian } = await loadCrestodianModule();
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"),
        interactive: !nonInteractive,
      });
      return;
    }

    const shouldUseCliEnvProxy =
      !isHelpOrVersionInvocation && shouldStartProxyForCli(normalizedArgv);
    const bootstrapProxyBeforeFastPath =
      shouldUseCliEnvProxy && shouldBootstrapCliProxyBeforeFastPath();
    if (
      !bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    if (!isHelpOrVersionInvocation) {
      await bootstrapCliProxyCaptureAndDispatcher(startupTrace, {
        ensureDispatcher: shouldUseCliEnvProxy,
      });
    }

    if (
      bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    let parseArgv = normalizeGeneratedHelpCommandArgv(rewriteUpdateFlagArgv(normalizedArgv));
    const suppressStartupProgress = hasJsonOutputFlag(parseArgv);
    const { createCliProgress } = await loadProgressModule();
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      ...(suppressStartupProgress ? { enabled: false } : {}),
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      // Capture all console output into structured logs while keeping stdout/stderr behavior.
      const { enableConsoleCapture } = await loadLoggingModule();
      enableConsoleCapture();

      const [
        { buildProgram },
        { formatUncaughtError },
        { formatCliFailureLines },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("./failure-output.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../../packages/terminal-core/src/restore.js"),
        ]),
      );
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
      // These log the error and exit gracefully instead of crashing without trace.
      installUnhandledRejectionHandler();

      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        for (const line of formatCliFailureLines({
          title: "OpenClaw hit an unexpected runtime error.",
          error,
          argv: normalizedArgv,
        })) {
          console.error(line);
        }
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      const invocation = resolveCliArgvInvocation(parseArgv);
      // Register the primary command (builtin or subcli) so help and command parsing
      // are correct even with lazy command registration.
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
      }

      const hasBuiltinPrimary =
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });
      if (!shouldSkipPluginRegistration) {
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          return await withConsoleLogsRoutedToStderrForJson(parseArgv, () =>
            registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
              mode: "lazy",
              primary,
            }),
          );
        });
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner, resolveManifestToolOwner } =
              await loadManifestCommandAliasesRuntimeModule();
            const cliCommandSurfaceOwner = await resolveCliCommandSurfaceOwner({
              primary,
              config,
            });
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
                resolveToolOwner: resolveManifestToolOwner,
                resolveCliCommandSurfaceOwner: () => cliCommandSurfaceOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      parseArgv = normalizeRootLogLevelArgvForProgram(
        normalizeRootNoColorArgvForProgram(parseArgv, program),
        program,
      );
      stopStartupProgress();

      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    uninstallGatewayRunRuntimeHooks?.();
    await stopStartedProxy();
    await disposeCliAgentHarnesses();
    await closeCliMemoryManagers();
    pauseNonTtyStdinForCliExit();
  }
}
