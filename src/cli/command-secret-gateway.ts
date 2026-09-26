import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { validateSecretsResolveResult } from "../../packages/gateway-protocol/src/index.js";
import type { SecretsResolveResult } from "../../packages/gateway-protocol/src/schema/secrets.js";
import { bindAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import {
  cloneConfigWithResolutionFacts,
  copyConfigResolutionFactsExcept,
  resolveConfigSecretRef,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { gatewaySecretInputPathCanWin } from "../gateway/credentials-secret-inputs.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  readGatewaySecretInputValue,
  type SupportedGatewaySecretInputPath,
} from "../gateway/secret-input-paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry-contributions.js";
import {
  analyzeCommandSecretAssignmentsFromSnapshot,
  type UnresolvedCommandSecretAssignment,
} from "../secrets/command-config.js";
import { getPath, setPathExistingStrict } from "../secrets/path-utils.js";
import { resolveSecretRefValue } from "../secrets/resolve.js";
import { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import { resolveRuntimeWebTools } from "../secrets/runtime-web-tools.js";
import { assertExpectedResolvedSecretValue } from "../secrets/secret-value.js";
import {
  discoverConfigSecretTargetsByIds,
  type DiscoveredConfigSecretTarget,
} from "../secrets/target-registry.js";
import { formatConcreteConfigPath } from "../shared/dot-path.js";

type ResolveCommandSecretsResult = {
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
  targetStatesByPath: Record<string, CommandSecretTargetState>;
  hadUnresolvedTargets: boolean;
};

export type CommandSecretResolutionMode =
  | "enforce_resolved"
  | "read_only_status"
  | "read_only_operational";

type LegacyCommandSecretResolutionMode = "strict" | "summary" | "operational_readonly"; // pragma: allowlist secret

type CommandSecretResolutionModeInput =
  | CommandSecretResolutionMode
  | LegacyCommandSecretResolutionMode;

type CommandSecretTargetState =
  | "resolved_gateway"
  | "resolved_local"
  | "inactive_surface"
  | "unresolved";

type CommandSecretResolutionPolicy = {
  allowExecSecretRefs: boolean;
  scrubUnresolvedSecretRefs: boolean;
};

function normalizeCommandSecretResolutionMode(
  mode?: CommandSecretResolutionModeInput,
): CommandSecretResolutionMode {
  if (!mode || mode === "enforce_resolved" || mode === "strict") {
    return "enforce_resolved";
  }
  if (mode === "read_only_status" || mode === "summary") {
    return "read_only_status";
  }
  return "read_only_operational";
}

function enforcesResolvedSecrets(mode: CommandSecretResolutionMode): boolean {
  return mode === "enforce_resolved";
}

function classifyRuntimeWebTarget(params: { config: OpenClawConfig; path: string }): {
  state: "active" | "inactive" | "unknown";
  detail?: string;
} {
  const match = /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(
    params.path,
  );
  if (!match) {
    return { state: "unknown" };
  }
  const kind = match[2] === "webFetch" ? "fetch" : "search";
  const web = params.config.tools?.web?.[kind];
  if (web?.enabled === false) {
    return { state: "inactive", detail: `tools.web.${kind} is disabled.` };
  }
  const provider = normalizeLowercaseStringOrEmpty(web?.provider);
  if (!provider) {
    return { state: "active" };
  }
  const pluginId = resolveManifestContractOwnerPluginId({
    contract: kind === "fetch" ? "webFetchProviders" : "webSearchProviders",
    value: provider,
    origin: "bundled",
    config: params.config,
  });
  if (!pluginId) {
    return { state: "unknown" };
  }
  return pluginId === match[1]
    ? { state: "active" }
    : { state: "inactive", detail: `tools.web.${kind}.provider is "${provider}".` };
}

function targetsRuntimeWebPath(path: string): boolean {
  return path.startsWith("plugins.entries.");
}

function targetsRuntimeWebResolution(params: {
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
}): boolean {
  for (const path of params.allowedPaths ?? params.targetIds) {
    if (targetsRuntimeWebPath(path)) {
      return true;
    }
  }
  return false;
}

function collectConfiguredTargetRefPaths(params: {
  config: OpenClawConfig;
  targetIds: Set<string>;
  allowedPaths?: ReadonlySet<string>;
}): Set<string> {
  const defaults = params.config.secrets?.defaults;
  const configuredTargetRefPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(params.config, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: resolveConfigSecretRef({
        config: params.config,
        path: target.path,
        value: target.value,
        defaults,
      }),
      refValue: target.refValue,
      defaults,
    });
    if (ref) {
      configuredTargetRefPaths.add(target.path);
    }
  }
  return configuredTargetRefPaths;
}

function classifyConfiguredTargetRefs(params: {
  config: OpenClawConfig;
  configuredTargetRefPaths: Set<string>;
  agentId?: string;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
}): {
  hasActiveConfiguredRef: boolean;
  hasUnknownConfiguredRef: boolean;
  diagnostics: string[];
} {
  if (params.configuredTargetRefPaths.size === 0) {
    return {
      hasActiveConfiguredRef: false,
      hasUnknownConfiguredRef: false,
      diagnostics: [],
    };
  }
  const context = createResolverContext({
    sourceConfig: params.config,
    env: process.env,
  });
  collectConfigAssignments({
    config: cloneConfigWithResolutionFacts(params.config),
    context,
    agentId: params.agentId,
  });

  const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
  const inactiveWarningsByPath = new Map<string, string>();
  for (const warning of context.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarningsByPath.set(warning.path, warning.message);
  }

  const diagnostics = new Set<string>();
  let hasActiveConfiguredRef = false;
  let hasUnknownConfiguredRef = false;

  for (const path of params.configuredTargetRefPaths) {
    if (
      activePaths.has(path) ||
      params.forcedActivePaths?.has(path) ||
      params.optionalActivePaths?.has(path)
    ) {
      hasActiveConfiguredRef = true;
      continue;
    }
    const inactiveWarning = inactiveWarningsByPath.get(path);
    if (inactiveWarning) {
      diagnostics.add(inactiveWarning);
      continue;
    }
    hasUnknownConfiguredRef = true;
  }

  return {
    hasActiveConfiguredRef,
    hasUnknownConfiguredRef,
    diagnostics: [...diagnostics],
  };
}

function parseGatewaySecretsResolveResult(payload: unknown) {
  if (!validateSecretsResolveResult(payload)) {
    throw new Error("gateway returned invalid secrets.resolve payload.");
  }
  return {
    assignments: payload.assignments ?? [],
    diagnostics: (payload.diagnostics ?? []).filter((entry) => entry.trim().length > 0),
    inactiveRefPaths: (payload.inactiveRefPaths ?? []).filter((entry) => entry.trim().length > 0),
  };
}

function collectInactiveSurfacePathsFromDiagnostics(diagnostics: string[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of diagnostics) {
    const marker = ": secret ref is configured on an inactive surface;";
    const markerIndex = entry.indexOf(marker);
    if (markerIndex <= 0) {
      continue;
    }
    const path = entry.slice(0, markerIndex).trim();
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return paths;
}

function filterAllowedGatewayDiagnostics(params: {
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  diagnostics: string[];
}): string[] {
  return params.diagnostics.filter((diagnostic) => {
    const markerIndex = diagnostic.indexOf(":");
    if (markerIndex <= 0) {
      return true;
    }
    const path = diagnostic.slice(0, markerIndex).trim();
    if (!path.includes(".")) {
      return true;
    }
    if (params.forcedActivePaths?.has(path) || params.optionalActivePaths?.has(path)) {
      return false;
    }
    return !params.allowedPaths || params.allowedPaths.has(path);
  });
}

function isUnsupportedSecretsResolveError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  if (!message.includes("secrets.resolve")) {
    return false;
  }
  return (
    message.includes("does not support required method") ||
    message.includes("unknown method") ||
    message.includes("method not found") ||
    message.includes("invalid request")
  );
}

function isAllowedPathsSecretsResolveCompatError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  if (!message.includes("secrets.resolve")) {
    return false;
  }
  return message.includes("invalid request") || message.includes("invalid secrets.resolve params");
}

function hasForcedActivePaths(paths: ReadonlySet<string> | undefined): boolean {
  return paths !== undefined && paths.size > 0;
}

function resolveLocalResolutionPolicy(params: {
  allowLocalExecSecretRefs?: boolean;
  scrubUnresolvedSecretRefs?: boolean;
}): CommandSecretResolutionPolicy {
  return {
    allowExecSecretRefs: params.allowLocalExecSecretRefs !== false,
    scrubUnresolvedSecretRefs: params.scrubUnresolvedSecretRefs !== false,
  };
}

function collectActiveGatewayExecSecretRefCredentialPaths(
  config: OpenClawConfig,
): SupportedGatewaySecretInputPath[] {
  const defaults = config.secrets?.defaults;
  return ALL_GATEWAY_SECRET_INPUT_PATHS.filter((path) => {
    const { ref } = resolveSecretInputRef({
      value: readGatewaySecretInputValue(config, path),
      defaults,
    });
    return (
      ref?.source === "exec" &&
      gatewaySecretInputPathCanWin({
        config,
        path,
        env: process.env,
      })
    );
  });
}

async function callGatewaySecretsResolve(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  timeoutMs?: number;
}): Promise<SecretsResolveResult> {
  const callGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const request = {
    config: params.config,
    method: "secrets.resolve",
    requiredMethods: ["secrets.resolve"],
    params: {
      commandName: params.commandName,
      targetIds: [...params.targetIds],
      ...(params.allowedPaths ? { allowedPaths: [...params.allowedPaths] } : {}),
      ...(params.forcedActivePaths ? { forcedActivePaths: [...params.forcedActivePaths] } : {}),
      ...(params.optionalActivePaths
        ? { optionalActivePaths: [...params.optionalActivePaths] }
        : {}),
    },
    timeoutMs: params.timeoutMs ?? 30_000,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  };
  try {
    return await callGateway(request);
  } catch (err) {
    if (
      (!params.allowedPaths && !params.forcedActivePaths && !params.optionalActivePaths) ||
      hasForcedActivePaths(params.forcedActivePaths) ||
      !isAllowedPathsSecretsResolveCompatError(err)
    ) {
      throw err;
    }
    return callGateway({
      ...request,
      params: {
        commandName: params.commandName,
        targetIds: [...params.targetIds],
      },
    });
  }
}

function isDirectRuntimeWebTargetPath(path: string): boolean {
  return /^plugins\.entries\.[^.]+\.config\.(webSearch|webFetch)\.apiKey$/.test(path);
}

async function resolveCommandSecretRefsLocally(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  agentId?: string;
  preflightDiagnostics: string[];
  mode: CommandSecretResolutionMode;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  resolutionPolicy: CommandSecretResolutionPolicy;
}): Promise<ResolveCommandSecretsResult> {
  const sourceConfig = params.config;
  const resolvedConfig = cloneConfigWithResolutionFacts(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: process.env,
  });
  const localResolutionDiagnostics: string[] = [];
  const discoveredTargets = discoverConfigSecretTargetsByIds(sourceConfig, params.targetIds).filter(
    (target) => !params.allowedPaths || params.allowedPaths.has(target.path),
  );
  const runtimeWebTargets = discoveredTargets.filter((target) =>
    targetsRuntimeWebPath(target.path),
  );
  collectConfigAssignments({
    config: cloneConfigWithResolutionFacts(params.config),
    context,
    agentId: params.agentId,
  });
  if (
    targetsRuntimeWebResolution({
      targetIds: params.targetIds,
      allowedPaths: params.allowedPaths,
    }) &&
    !runtimeWebTargets.every((target) => isDirectRuntimeWebTargetPath(target.path))
  ) {
    try {
      await resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      });
    } catch (error) {
      if (enforcesResolvedSecrets(params.mode)) {
        throw error;
      }
      localResolutionDiagnostics.push(
        `${params.commandName}: failed to resolve web tool secrets locally (${formatErrorMessage(error)}).`,
      );
    }
  }
  const inactiveWarnings = context.warnings.filter(
    (warning) =>
      warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
      (!params.allowedPaths || params.allowedPaths.has(warning.path)) &&
      !params.forcedActivePaths?.has(warning.path) &&
      !params.optionalActivePaths?.has(warning.path),
  );
  const inactiveRefPaths = new Set(inactiveWarnings.map((warning) => warning.path));
  const runtimeWebActivePaths = new Set<string>();
  const runtimeWebInactiveDiagnostics: string[] = [];
  for (const target of runtimeWebTargets) {
    if (
      params.forcedActivePaths?.has(target.path) ||
      params.optionalActivePaths?.has(target.path)
    ) {
      runtimeWebActivePaths.add(target.path);
      continue;
    }
    const runtimeState = classifyRuntimeWebTarget({
      config: sourceConfig,
      path: target.path,
    });
    if (runtimeState.state === "inactive") {
      inactiveRefPaths.add(target.path);
      if (runtimeState.detail) {
        runtimeWebInactiveDiagnostics.push(`${target.path}: ${runtimeState.detail}`);
      }
      continue;
    }
    if (runtimeState.state === "active") {
      runtimeWebActivePaths.add(target.path);
    }
  }
  const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
  for (const target of discoveredTargets) {
    await resolveTargetSecretLocally({
      target,
      sourceConfig,
      resolvedConfig,
      env: context.env,
      cache: context.cache,
      activePaths,
      runtimeWebActivePaths,
      inactiveRefPaths,
      forcedActivePaths: params.forcedActivePaths,
      optionalActivePaths: params.optionalActivePaths,
      mode: params.mode,
      commandName: params.commandName,
      localResolutionDiagnostics,
      resolutionPolicy: params.resolutionPolicy,
    });
  }
  const analyzed = analyzeCommandSecretTargets({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths,
    allowedPaths: params.allowedPaths,
    optionalActivePaths: params.optionalActivePaths,
  });
  const targetStatesByPath = buildTargetStatesByPath({
    analyzed,
    resolvedState: "resolved_local",
  });
  if (analyzed.unresolved.length > 0) {
    if (enforcesResolvedSecrets(params.mode)) {
      throw new Error(
        `${params.commandName}: ${analyzed.unresolved[0]?.path ?? "target"} is unresolved in the active runtime snapshot.`,
      );
    }
    if (params.resolutionPolicy.scrubUnresolvedSecretRefs) {
      scrubUnresolvedAssignments(resolvedConfig, analyzed.unresolved);
    }
  }

  return {
    resolvedConfig,
    diagnostics: normalizeUniqueStringEntries([
      ...params.preflightDiagnostics,
      ...runtimeWebInactiveDiagnostics,
      ...inactiveWarnings.map((warning) => warning.message),
      ...filterInactiveSurfaceDiagnostics({
        diagnostics: analyzed.diagnostics,
        inactiveRefPaths,
      }),
      ...localResolutionDiagnostics,
      ...buildUnresolvedDiagnostics(params.commandName, analyzed.unresolved, params.mode),
    ]),
    targetStatesByPath,
    hadUnresolvedTargets: analyzed.unresolved.length > 0,
  };
}

function analyzeCommandSecretTargets(
  params: Parameters<typeof analyzeCommandSecretAssignmentsFromSnapshot>[0] & {
    inactiveRefPaths: Set<string>;
    optionalActivePaths?: ReadonlySet<string>;
  },
) {
  const { optionalActivePaths, ...snapshot } = params;
  const analyzed = analyzeCommandSecretAssignmentsFromSnapshot(snapshot);
  const optionalUnresolvedPaths = analyzed.unresolved.filter((entry) =>
    optionalActivePaths?.has(entry.path),
  );
  if (optionalUnresolvedPaths.length === 0) {
    return analyzed;
  }
  for (const { path } of optionalUnresolvedPaths) {
    snapshot.inactiveRefPaths.add(path);
  }
  return analyzeCommandSecretAssignmentsFromSnapshot(snapshot);
}

function buildTargetStatesByPath(params: {
  analyzed: ReturnType<typeof analyzeCommandSecretAssignmentsFromSnapshot>;
  resolvedState: Extract<CommandSecretTargetState, "resolved_gateway" | "resolved_local">;
}): Record<string, CommandSecretTargetState> {
  const states: Record<string, CommandSecretTargetState> = {};
  for (const assignment of params.analyzed.assignments) {
    states[assignment.path] = params.resolvedState;
  }
  for (const entry of params.analyzed.inactive) {
    states[entry.path] = "inactive_surface";
  }
  for (const entry of params.analyzed.unresolved) {
    states[entry.path] = "unresolved";
  }
  return states;
}

function buildUnresolvedDiagnostics(
  commandName: string,
  unresolved: UnresolvedCommandSecretAssignment[],
  mode: CommandSecretResolutionMode,
): string[] {
  if (enforcesResolvedSecrets(mode)) {
    return [];
  }
  return unresolved.map(
    (entry) =>
      `${commandName}: ${entry.path} is unavailable in this command path; continuing with degraded read-only config.`,
  );
}

function scrubUnresolvedAssignments(
  config: OpenClawConfig,
  unresolved: UnresolvedCommandSecretAssignment[],
): void {
  for (const entry of unresolved) {
    setPathExistingStrict(config, entry.pathSegments, undefined);
  }
}

function filterInactiveSurfaceDiagnostics(params: {
  diagnostics: readonly string[];
  inactiveRefPaths: ReadonlySet<string>;
}): string[] {
  return params.diagnostics.filter((entry) => {
    const marker = ": secret ref is configured on an inactive surface;";
    const markerIndex = entry.indexOf(marker);
    if (markerIndex <= 0) {
      return true;
    }
    const path = entry.slice(0, markerIndex).trim();
    return !params.inactiveRefPaths.has(path);
  });
}

async function resolveTargetSecretLocally(params: {
  target: DiscoveredConfigSecretTarget;
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: ReturnType<typeof createResolverContext>["cache"];
  activePaths: ReadonlySet<string>;
  runtimeWebActivePaths: ReadonlySet<string>;
  inactiveRefPaths: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  mode: CommandSecretResolutionMode;
  commandName: string;
  localResolutionDiagnostics: string[];
  resolutionPolicy: CommandSecretResolutionPolicy;
}): Promise<void> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: resolveConfigSecretRef({
      config: params.sourceConfig,
      path: params.target.path,
      value: params.target.value,
      defaults,
    }),
    refValue: params.target.refValue,
    defaults,
  });
  if (
    !ref ||
    params.inactiveRefPaths.has(params.target.path) ||
    (!params.activePaths.has(params.target.path) &&
      !params.runtimeWebActivePaths.has(params.target.path) &&
      !params.forcedActivePaths?.has(params.target.path) &&
      !params.optionalActivePaths?.has(params.target.path))
  ) {
    return;
  }
  if (ref.source === "exec" && !params.resolutionPolicy.allowExecSecretRefs) {
    if (!enforcesResolvedSecrets(params.mode)) {
      params.localResolutionDiagnostics.push(
        `${params.commandName}: skipped local exec SecretRef resolution for ${params.target.path}; rerun with --allow-exec to execute configured exec providers.`,
      );
    }
    return;
  }

  try {
    const resolved = await resolveSecretRefValue(ref, {
      config: params.sourceConfig,
      env: params.env,
      cache: params.cache,
    });
    assertExpectedResolvedSecretValue({
      value: resolved,
      expected: params.target.entry.expectedResolvedValue,
      errorMessage:
        params.target.entry.expectedResolvedValue === "string"
          ? `${params.target.path} resolved to a non-string or empty value.`
          : `${params.target.path} resolved to an unsupported value type.`,
    });
    setPathExistingStrict(params.resolvedConfig, params.target.pathSegments, resolved);
    copyConfigResolutionFactsExcept(params.resolvedConfig, params.resolvedConfig, [
      params.target.path,
    ]);
  } catch (error) {
    if (!enforcesResolvedSecrets(params.mode)) {
      params.localResolutionDiagnostics.push(
        `${params.commandName}: failed to resolve ${params.target.path} locally (${formatErrorMessage(error)}).`,
      );
    }
  }
}

export async function resolveCommandSecretRefsViaGateway(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  agentId?: string;
  mode?: CommandSecretResolutionModeInput;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  allowLocalExecSecretRefs?: boolean;
  scrubUnresolvedSecretRefs?: boolean;
  gatewaySecretResolveTimeoutMs?: number;
}): Promise<ResolveCommandSecretsResult> {
  const mode = normalizeCommandSecretResolutionMode(params.mode);
  const resolutionPolicy = resolveLocalResolutionPolicy({
    allowLocalExecSecretRefs: params.allowLocalExecSecretRefs,
    scrubUnresolvedSecretRefs: params.scrubUnresolvedSecretRefs,
  });
  const configuredTargetRefPaths = collectConfiguredTargetRefPaths({
    config: params.config,
    targetIds: params.targetIds,
    allowedPaths: params.allowedPaths,
  });
  if (configuredTargetRefPaths.size === 0) {
    return {
      resolvedConfig: params.config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    };
  }
  const preflight = classifyConfiguredTargetRefs({
    config: params.config,
    configuredTargetRefPaths,
    agentId: params.agentId,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
  });
  if (!preflight.hasActiveConfiguredRef && !preflight.hasUnknownConfiguredRef) {
    return {
      resolvedConfig: params.config,
      diagnostics: preflight.diagnostics,
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    };
  }
  const gatewayExecSecretRefCredentialPaths = resolutionPolicy.allowExecSecretRefs
    ? []
    : collectActiveGatewayExecSecretRefCredentialPaths(params.config);
  if (gatewayExecSecretRefCredentialPaths.length > 0) {
    const fallback = await resolveCommandSecretRefsLocally({
      config: params.config,
      commandName: params.commandName,
      targetIds: params.targetIds,
      agentId: params.agentId,
      preflightDiagnostics: preflight.diagnostics,
      mode,
      allowedPaths: params.allowedPaths,
      forcedActivePaths: params.forcedActivePaths,
      optionalActivePaths: params.optionalActivePaths,
      resolutionPolicy,
    });
    return {
      ...fallback,
      diagnostics: normalizeUniqueStringEntries([
        ...fallback.diagnostics,
        `${params.commandName}: skipped gateway secrets.resolve because gateway credentials use exec SecretRefs at ${gatewayExecSecretRefCredentialPaths.join(", ")}; rerun with --allow-exec to execute configured exec providers.`,
      ]),
    };
  }

  let payload: SecretsResolveResult;
  try {
    payload = await callGatewaySecretsResolve({
      config: params.config,
      commandName: params.commandName,
      targetIds: params.targetIds,
      allowedPaths: params.allowedPaths,
      forcedActivePaths: params.forcedActivePaths,
      optionalActivePaths: params.optionalActivePaths,
      ...(params.gatewaySecretResolveTimeoutMs !== undefined
        ? { timeoutMs: params.gatewaySecretResolveTimeoutMs }
        : {}),
    });
  } catch (err) {
    let forcedActiveCompatFailure: Error | undefined;
    try {
      const fallback = await resolveCommandSecretRefsLocally({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        agentId: params.agentId,
        preflightDiagnostics: preflight.diagnostics,
        mode,
        allowedPaths: params.allowedPaths,
        forcedActivePaths: params.forcedActivePaths,
        optionalActivePaths: params.optionalActivePaths,
        resolutionPolicy,
      });
      const recoveredLocally = Object.values(fallback.targetStatesByPath).some(
        (state) => state === "resolved_local",
      );
      if (
        hasForcedActivePaths(params.forcedActivePaths) &&
        isAllowedPathsSecretsResolveCompatError(err) &&
        (!recoveredLocally || fallback.hadUnresolvedTargets)
      ) {
        forcedActiveCompatFailure = new Error(
          `${params.commandName}: active gateway does not support command-scoped secret resolution (${formatErrorMessage(err)}). Update the gateway or run this command where the configured SecretRefs can be resolved locally.`,
          { cause: err },
        );
      } else {
        const fallbackMessage =
          recoveredLocally && !fallback.hadUnresolvedTargets
            ? "resolved command secrets locally."
            : "attempted local command-secret resolution.";
        return {
          resolvedConfig: fallback.resolvedConfig,
          diagnostics: normalizeUniqueStringEntries([
            ...fallback.diagnostics,
            `${params.commandName}: gateway secrets.resolve unavailable (${formatErrorMessage(err)}); ${fallbackMessage}`,
          ]),
          targetStatesByPath: fallback.targetStatesByPath,
          hadUnresolvedTargets: fallback.hadUnresolvedTargets,
        };
      }
    } catch {
      // Fall through to original gateway-specific error reporting.
    }
    if (forcedActiveCompatFailure) {
      throw forcedActiveCompatFailure;
    }
    if (
      hasForcedActivePaths(params.forcedActivePaths) &&
      isAllowedPathsSecretsResolveCompatError(err)
    ) {
      throw new Error(
        `${params.commandName}: active gateway does not support command-scoped secret resolution (${formatErrorMessage(err)}). Update the gateway or run this command where the configured SecretRefs can be resolved locally.`,
        { cause: err },
      );
    }
    if (isUnsupportedSecretsResolveError(err)) {
      throw new Error(
        `${params.commandName}: active gateway does not support secrets.resolve (${formatErrorMessage(err)}). Update the gateway or run without SecretRefs.`,
        { cause: err },
      );
    }
    throw new Error(
      `${params.commandName}: failed to resolve secrets from the active gateway snapshot (${formatErrorMessage(err)}). Local resolution also failed. Check the configured secret sources and gateway access, then retry.`,
      { cause: err },
    );
  }

  const parsed = parseGatewaySecretsResolveResult(payload);
  const gatewayDiagnostics = filterAllowedGatewayDiagnostics({
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
    diagnostics: parsed.diagnostics,
  });
  const gatewayInactiveRefPaths = params.allowedPaths
    ? parsed.inactiveRefPaths.filter((path) => params.allowedPaths?.has(path))
    : parsed.inactiveRefPaths;
  const resolvedConfig = cloneConfigWithResolutionFacts(params.config);
  const resolvedAssignmentPaths: string[] = [];
  for (const { pathSegments, value } of parsed.assignments) {
    if (pathSegments.length === 0) {
      continue;
    }
    const path = formatConcreteConfigPath(pathSegments, resolvedConfig);
    if (params.allowedPaths && !params.allowedPaths.has(path)) {
      continue;
    }
    try {
      setPathExistingStrict(resolvedConfig, pathSegments, value);
      resolvedAssignmentPaths.push(path);
    } catch (err) {
      throw new Error(
        `${params.commandName}: failed to apply resolved secret assignment at ${path} (${formatErrorMessage(err)}).`,
        { cause: err },
      );
    }
  }
  copyConfigResolutionFactsExcept(resolvedConfig, resolvedConfig, resolvedAssignmentPaths);
  const inactiveRefPaths = new Set(
    gatewayInactiveRefPaths.length > 0
      ? gatewayInactiveRefPaths
      : collectInactiveSurfacePathsFromDiagnostics(gatewayDiagnostics),
  );
  for (const path of params.forcedActivePaths ?? []) {
    inactiveRefPaths.delete(path);
  }
  for (const path of params.optionalActivePaths ?? []) {
    inactiveRefPaths.delete(path);
  }
  const analyzed = analyzeCommandSecretTargets({
    sourceConfig: params.config,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths,
    allowedPaths: params.allowedPaths,
    optionalActivePaths: params.optionalActivePaths,
  });
  let diagnostics = normalizeUniqueStringEntries(gatewayDiagnostics);
  const targetStatesByPath = buildTargetStatesByPath({
    analyzed,
    resolvedState: "resolved_gateway",
  });
  if (analyzed.unresolved.length > 0) {
    try {
      const localFallback = await resolveCommandSecretRefsLocally({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        agentId: params.agentId,
        preflightDiagnostics: [],
        mode,
        allowedPaths: new Set(analyzed.unresolved.map((entry) => entry.path)),
        forcedActivePaths: params.forcedActivePaths,
        optionalActivePaths: params.optionalActivePaths,
        resolutionPolicy,
      });
      const handledPaths = new Set<string>();
      const locallyResolvedPaths = new Set<string>();
      for (const unresolved of analyzed.unresolved) {
        const localState = localFallback.targetStatesByPath[unresolved.path];
        if (localState === "inactive_surface") {
          // A partial gateway snapshot can omit inactive refs as well as unresolved refs.
          // Local inactive classification is terminal even though it materializes no value.
          targetStatesByPath[unresolved.path] = localState;
          handledPaths.add(unresolved.path);
          continue;
        }
        if (localState !== "resolved_local") {
          continue;
        }
        setPathExistingStrict(
          resolvedConfig,
          unresolved.pathSegments,
          getPath(localFallback.resolvedConfig, unresolved.pathSegments),
        );
        targetStatesByPath[unresolved.path] = localState;
        handledPaths.add(unresolved.path);
        locallyResolvedPaths.add(unresolved.path);
      }
      copyConfigResolutionFactsExcept(resolvedConfig, resolvedConfig, [...locallyResolvedPaths]);
      diagnostics = normalizeUniqueStringEntries([...diagnostics, ...localFallback.diagnostics]);
      const stillUnresolved = analyzed.unresolved.filter((entry) => !handledPaths.has(entry.path));
      if (stillUnresolved.length > 0) {
        if (enforcesResolvedSecrets(mode)) {
          throw new Error(
            `${params.commandName}: ${stillUnresolved[0]?.path ?? "target"} is unresolved in the active runtime snapshot.`,
          );
        }
        if (resolutionPolicy.scrubUnresolvedSecretRefs) {
          scrubUnresolvedAssignments(resolvedConfig, stillUnresolved);
        }
        diagnostics = normalizeUniqueStringEntries([
          ...diagnostics,
          ...buildUnresolvedDiagnostics(params.commandName, stillUnresolved, mode),
        ]);
        for (const unresolved of stillUnresolved) {
          targetStatesByPath[unresolved.path] = "unresolved";
        }
      } else if (locallyResolvedPaths.size > 0) {
        diagnostics = normalizeUniqueStringEntries([
          ...diagnostics,
          `${params.commandName}: resolved ${locallyResolvedPaths.size} secret ${
            locallyResolvedPaths.size === 1 ? "path" : "paths"
          } locally after the gateway snapshot was incomplete.`,
        ]);
      }
    } catch (error) {
      if (enforcesResolvedSecrets(mode)) {
        throw error;
      }
      if (resolutionPolicy.scrubUnresolvedSecretRefs) {
        scrubUnresolvedAssignments(resolvedConfig, analyzed.unresolved);
      }
      diagnostics = normalizeUniqueStringEntries([
        ...diagnostics,
        `${params.commandName}: local fallback after incomplete gateway snapshot failed (${formatErrorMessage(error)}).`,
        ...buildUnresolvedDiagnostics(params.commandName, analyzed.unresolved, mode),
      ]);
    }
  }

  return {
    resolvedConfig,
    diagnostics,
    targetStatesByPath,
    hadUnresolvedTargets: Object.values(targetStatesByPath).includes("unresolved"),
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
