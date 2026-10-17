import path from "node:path";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  listAgentEntries,
  listAgentEntriesWithSource,
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveConfiguredAgentId,
  resolveAmbientOwnerAgentId,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope.js";
import { resolveSandboxDockerEnv, resolveSandboxScope } from "../agents/sandbox/config-contract.js";
import { LEGACY_AGENT_ROSTER_RULES } from "../commands/doctor/shared/legacy-config-migrations.runtime.entries.js";
import { collectLegacyToolsBySenderIssues } from "../commands/doctor/shared/legacy-tools-by-sender.js";
import { getContainerEnvFileEntryIssue } from "../infra/container-env-file.js";
import { isPathInside } from "../infra/path-guards.js";
import { LINEAR_MATCHER_SOURCES } from "../logging/redact-linear-matchers.js";
import { parseRedactPatternSource } from "../logging/redact-pattern-runtime.js";
import { PEM_REDACT_PATTERN_SOURCE } from "../logging/redact-pem.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { compileConfigRegex } from "../security/config-regex.js";
import {
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isAvatarWorkspacePath,
} from "../shared/avatar-policy.js";
import {
  formatUnsafeGatewayTailscaleNoAuthMessage,
  isUnsafeGatewayTailscaleNoAuth,
} from "../shared/gateway-tailscale-auth-policy.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { attachAgentListProjection } from "./agent-list-projection.js";
import { applyImplicitAgentRosterDefaults } from "./implicit-agent-roster.js";
import { findLegacyConfigRuleIssues } from "./legacy.js";
import { materializeRuntimeConfig } from "./materialize.js";
import {
  createModelPolicyRefValidator,
  parseOperatorModelPolicyWildcardRef,
} from "./model-policy-ref.js";
import { isBuiltInModelProviderOverlayId } from "./model-provider-overlay-ids.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { collectRawBundledChannelConfigIssues } from "./validation-channel-rules.js";
import {
  collectUnsupportedSecretRefPolicyIssues,
  mapZodIssueToConfigIssue,
  mergeUnsupportedMutableSecretRefIssues,
  withConfigIssuePath,
} from "./validation-issues.js";
import { OpenClawSchema } from "./zod-schema.js";
import { McpServerNameSchema, NodeHostMcpServerNameSchema } from "./zod-schema.root-support.js";

const EMPTY_ALLOW_POLICY_MESSAGE =
  'Empty allow list permits everything not denied; use deny:["*"] to deny all or omit allow to keep the default.';

function pushEmptyAllowWarning(
  warnings: ConfigValidationIssue[],
  policyPath: string,
  policy: unknown,
  opts?: { alsoAllowNarrows?: boolean },
): void {
  if (!isRecord(policy)) {
    return;
  }
  const allow: unknown = policy.allow;
  if (Array.isArray(allow) && allow.length === 0) {
    // Only the sub-agent resolver narrows `allow: [] + alsoAllow` to the
    // alsoAllow list. Global/sandbox resolvers stay permissive, so suppress
    // only where narrowing is proven.
    if (opts?.alsoAllowNarrows === true) {
      const alsoAllow: unknown = policy.alsoAllow;
      if (Array.isArray(alsoAllow) && alsoAllow.length > 0) {
        return;
      }
    }
    warnings.push({ path: policyPath, message: EMPTY_ALLOW_POLICY_MESSAGE });
  }
}

/**
 * Warns for explicit `allow: []` tool policies. An empty allow list reads as
 * "no tools" but the matcher treats it as allow-all (same as omitting
 * allow), so validation stays silent on a security UX trap. Warn-only: no
 * runtime semantics change. The `alsoAllow` suppression applies only to
 * `tools.subagents.tools`, the single scope where the runtime narrows instead
 * of staying permissive. Refs #147342.
 */
function collectEmptyAllowPolicyWarnings(config: OpenClawConfig): ConfigValidationIssue[] {
  const warnings: ConfigValidationIssue[] = [];
  pushEmptyAllowWarning(warnings, "tools", config.tools);
  const globalBySender: unknown = config.tools?.toolsBySender;
  if (isRecord(globalBySender)) {
    for (const [sender, policy] of Object.entries(globalBySender)) {
      pushEmptyAllowWarning(warnings, `tools.toolsBySender.${sender}`, policy);
    }
  }
  const globalByProvider: unknown = config.tools?.byProvider;
  if (isRecord(globalByProvider)) {
    for (const [provider, policy] of Object.entries(globalByProvider)) {
      pushEmptyAllowWarning(warnings, `tools.byProvider.${provider}`, policy);
    }
  }
  const toolsNode: unknown = config.tools;
  if (isRecord(toolsNode)) {
    const subagentsNode: unknown = toolsNode.subagents;
    if (isRecord(subagentsNode)) {
      pushEmptyAllowWarning(warnings, "tools.subagents.tools", subagentsNode.tools, {
        alsoAllowNarrows: true,
      });
    }
    const sandboxNode: unknown = toolsNode.sandbox;
    if (isRecord(sandboxNode)) {
      pushEmptyAllowWarning(warnings, "tools.sandbox.tools", sandboxNode.tools);
    }
  }
  for (const entry of listAgentEntries(config)) {
    const base = `agents.entries.${entry.id}.tools`;
    pushEmptyAllowWarning(warnings, base, entry.tools);
    const toolsRecord: unknown = entry.tools;
    const bySender: unknown = isRecord(toolsRecord) ? toolsRecord.toolsBySender : undefined;
    if (isRecord(bySender)) {
      for (const [sender, policy] of Object.entries(bySender)) {
        pushEmptyAllowWarning(warnings, `${base}.toolsBySender.${sender}`, policy);
      }
    }
    const byProvider: unknown = isRecord(toolsRecord) ? toolsRecord.byProvider : undefined;
    if (isRecord(byProvider)) {
      for (const [provider, policy] of Object.entries(byProvider)) {
        pushEmptyAllowWarning(warnings, `${base}.byProvider.${provider}`, policy);
      }
    }
    const sandboxNode: unknown = isRecord(toolsRecord) ? toolsRecord.sandbox : undefined;
    if (isRecord(sandboxNode)) {
      pushEmptyAllowWarning(warnings, `${base}.sandbox.tools`, sandboxNode.tools);
    }
  }
  return warnings;
}

/**
 * Combined snapshot warnings for `openclaw config validate`: heartbeat owner
 * plus explicit empty `allow: []` tool policies. Single call-site keeps
 * validation within its max-lines budget. Refs #147342.
 */
export function collectConfigValidationWarnings(config: OpenClawConfig): ConfigValidationIssue[] {
  return [...collectHeartbeatOwnerWarnings(config), ...collectEmptyAllowPolicyWarnings(config)];
}

function collectHeartbeatOwnerWarnings(config: OpenClawConfig): ConfigValidationIssue[] {
  const agentEntries = listAgentEntries(config);
  // Match heartbeat enrollment so validation never warns for an owner the runner can use.
  const unresolved =
    listAgentIds(config).length > 1 &&
    !agentEntries.some((entry) => Boolean(entry.heartbeat)) &&
    !config.agents?.defaults?.heartbeat &&
    tryResolveAmbientOwnerAgentId(config) === undefined;
  return unresolved
    ? [
        {
          path: "agents.defaults.heartbeat.agentId",
          message:
            "Multi-agent config has no ambient heartbeat owner; heartbeats stay disabled until agents.defaults.heartbeat.agentId or agents.defaults.systemAgent.agentId is set.",
        },
      ]
    : [];
}

// The schema accepts any string, but log redaction drops entries the safe-regex compiler
// rejects; warn so operators do not rely on a mask that never applies.
export function collectRedactPatternWarnings(config: OpenClawConfig): ConfigValidationIssue[] {
  const patterns = config.logging?.redactPatterns;
  if (!Array.isArray(patterns)) {
    return [];
  }
  const warnings: ConfigValidationIssue[] = [];
  patterns.forEach((raw, index) => {
    // Built-in sources resolve to their own matchers before regex compilation.
    if (raw === PEM_REDACT_PATTERN_SOURCE || LINEAR_MATCHER_SOURCES.has(raw)) {
      return;
    }
    const compiled = compileConfigRegex(...parseRedactPatternSource(raw));
    if (compiled?.reason) {
      const repair =
        compiled.reason === "invalid-regex"
          ? "Fix the regex syntax"
          : "Rewrite the nested repetition, for example (a+)+ as a+";
      warnings.push({
        path: `logging.redactPatterns.${index}`,
        message: `Redaction pattern is ignored (${compiled.reason}); values it should mask stay visible in logs and diagnostics. ${repair}, then run openclaw config validate again.`,
      });
    }
  });
  return warnings;
}

function materializeBundledModelProviderOverlays(config: OpenClawConfig): OpenClawConfig {
  const providers = config.models?.providers;
  if (!providers) {
    return config;
  }
  let nextProviders: typeof providers | undefined;
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (
      !isBuiltInModelProviderOverlayId(providerId) ||
      (providerConfig.baseUrl && Array.isArray(providerConfig.models))
    ) {
      continue;
    }
    nextProviders ??= { ...providers };
    nextProviders[providerId] = {
      ...providerConfig,
      baseUrl: providerConfig.baseUrl ?? "",
      models: providerConfig.models ?? [],
    };
  }
  return nextProviders
    ? { ...config, models: { ...config.models, providers: nextProviders } }
    : config;
}

function stripPreservedLegacyRootKeysForValidation(
  raw: unknown,
  keys?: readonly string[],
): unknown {
  if (!keys || keys.length === 0 || !isRecord(raw)) {
    return raw;
  }
  const next = { ...raw };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function collectMcpServerNameIssues(raw: unknown): ConfigValidationIssue[] {
  if (!isRecord(raw)) {
    return [];
  }
  const mcp = isRecord(raw.mcp) ? raw.mcp : undefined;
  const nodeHost = isRecord(raw.nodeHost) ? raw.nodeHost : undefined;
  const nodeHostMcp = isRecord(nodeHost?.mcp) ? nodeHost.mcp : undefined;
  const locations = [
    {
      path: ["mcp", "servers"] as const,
      servers: isRecord(mcp?.servers) ? mcp.servers : undefined,
      schema: McpServerNameSchema,
    },
    {
      path: ["nodeHost", "mcp", "servers"] as const,
      servers: isRecord(nodeHostMcp?.servers) ? nodeHostMcp.servers : undefined,
      schema: NodeHostMcpServerNameSchema,
    },
  ];
  const issues: ConfigValidationIssue[] = [];
  for (const location of locations) {
    for (const serverName of Object.keys(location.servers ?? {})) {
      const result = location.schema.safeParse(serverName);
      if (result.success) {
        continue;
      }
      const pathSegments = [...location.path, serverName];
      for (const issue of result.error.issues) {
        issues.push(
          withConfigIssuePath(
            { path: pathSegments.join("."), message: issue.message },
            pathSegments,
          ),
        );
      }
    }
  }
  return issues;
}

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathInside(workspaceRoot, resolved);
}

function createIdentityAvatarIssue(
  source: ReturnType<typeof listAgentEntriesWithSource>[number]["source"],
  message: string,
): ConfigValidationIssue {
  const pathSegments =
    source.kind === "entries"
      ? (["agents", "entries", source.key, "identity", "avatar"] as const)
      : (["agents", "list", source.index, "identity", "avatar"] as const);
  return withConfigIssuePath({ path: pathSegments.join("."), message }, pathSegments);
}

function validateIdentityAvatar(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): ConfigValidationIssue[] {
  const agents = listAgentEntriesWithSource(config);
  const issues: ConfigValidationIssue[] = [];
  for (const { entry, source } of agents) {
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar || isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (!isAvatarWorkspacePath(avatar)) {
      issues.push(
        createIdentityAvatarIssue(
          source,
          "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
        ),
      );
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveAmbientOwnerAgentId(config),
      env,
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push(
        createIdentityAvatarIssue(source, "identity.avatar must stay within the agent workspace."),
      );
    }
  }
  return issues;
}

function validateGatewayTailscaleBind(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return [];
  }
  const bindMode = config.gateway?.bind ?? "loopback";
  if (bindMode === "loopback") {
    return [];
  }
  const customBindHost = config.gateway?.customBindHost;
  if (
    bindMode === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return [];
  }
  return [
    {
      path: "gateway.bind",
      message:
        `gateway.bind must resolve to loopback when gateway.tailscale.mode=${tailscaleMode} ` +
        '(use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
    },
  ];
}

function validateGatewayTailscaleAuth(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (!isUnsafeGatewayTailscaleNoAuth({ authMode: config.gateway?.auth?.mode, tailscaleMode })) {
    return [];
  }
  return [
    {
      path: "gateway.auth.mode",
      message: formatUnsafeGatewayTailscaleNoAuthMessage(tailscaleMode),
    },
  ];
}

function collectModelPolicyAllowIssues(config: OpenClawConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const defaultModels = config.agents?.defaults?.models;
  const validateRefs = (
    refs: readonly string[] | undefined,
    configPath: string,
    agentModels?: typeof defaultModels,
    allowModelPrefix = false,
  ) => {
    if (!refs?.length) {
      return;
    }
    const isValidRef = createModelPolicyRefValidator(defaultModels, agentModels);
    for (const [index, raw] of refs.entries()) {
      if (isValidRef(raw) || (allowModelPrefix && parseOperatorModelPolicyWildcardRef(raw))) {
        continue;
      }
      issues.push({
        path: `${configPath}.${index}`,
        message:
          `invalid model policy ref: ${sanitizeForLog(JSON.stringify(raw))}. ` +
          'Use a configured alias, an exact "provider/model" ref, or a trailing prefix wildcard such as "provider/*" or "provider/namespace/*".' +
          (allowModelPrefix
            ? ' Role policies also accept a model-name prefix such as "provider/family-*".'
            : ""),
      });
    }
  };

  validateRefs(config.agents?.defaults?.modelPolicy?.allow, "agents.defaults.modelPolicy.allow");
  for (const { entry: agent, source } of listAgentEntriesWithSource(config)) {
    const pathPrefix =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    validateRefs(agent.modelPolicy?.allow, `${pathPrefix}.modelPolicy.allow`, agent.models);
  }
  for (const [role, definition] of Object.entries(config.gateway?.roles?.definitions ?? {})) {
    const policy = definition.modelPolicy;
    if (!policy) {
      continue;
    }
    const pathPrefix = `gateway.roles.definitions.${role}.modelPolicy`;
    let sourceAgent: string;
    try {
      sourceAgent = resolveConfiguredAgentId(
        config,
        resolveAmbientOwnerAgentId(config, policy.sourceAgent),
      );
    } catch {
      issues.push({
        path: `${pathPrefix}.sourceAgent`,
        message: "Choose a configured source agent for this role's model policy.",
      });
      continue;
    }
    const models = listAgentEntries(config).find((agent) => agent.id === sourceAgent)?.models;
    validateRefs(policy.allow, `${pathPrefix}.allow`, models, true);
    validateRefs(policy.deny, `${pathPrefix}.deny`, models, true);
  }
  return issues;
}

function collectSandboxContainerEnvIssues(
  config: OpenClawConfig,
  sourceRaw?: unknown,
): ConfigValidationIssue[] {
  const agents = listAgentEntriesWithSource(config);
  if (
    !config.agents?.defaults?.sandbox?.docker?.env &&
    !agents.some(({ entry }) => entry.sandbox?.docker?.env)
  ) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  const seen = new Set<string>();
  const authoredAgents = isRecord(sourceRaw) ? listAgentEntriesWithSource(sourceRaw) : agents;
  const authoredById = new Map(authoredAgents.map((agent) => [agent.entry.id, agent]));

  const defaultSandbox = config.agents?.defaults?.sandbox;
  const effectiveAgents = agents.length > 0 ? agents : [undefined];
  for (const agent of effectiveAgents) {
    const agentSandbox = agent?.entry.sandbox;
    const scope = resolveSandboxScope({ scope: agentSandbox?.scope ?? defaultSandbox?.scope });
    const backend = agentSandbox?.backend?.trim() || defaultSandbox?.backend?.trim() || "docker";
    if (backend !== "docker" && backend !== "podman") {
      continue;
    }
    const env = resolveSandboxDockerEnv({
      scope,
      globalEnv: defaultSandbox?.docker?.env,
      agentEnv: agentSandbox?.docker?.env,
    });
    const authoredAgent = agent ? (authoredById.get(agent.entry.id) ?? agent) : undefined;
    for (const [key, value] of Object.entries(env)) {
      const reason = getContainerEnvFileEntryIssue(key, value);
      if (!reason) {
        continue;
      }
      const agentOwnsValue =
        scope !== "shared" &&
        authoredAgent !== undefined &&
        Object.hasOwn(authoredAgent.entry.sandbox?.docker?.env ?? {}, key);
      const pathSegments =
        agentOwnsValue && authoredAgent
          ? authoredAgent.source.kind === "entries"
            ? ["agents", "entries", authoredAgent.source.key, "sandbox", "docker", "env", key]
            : ["agents", "list", authoredAgent.source.index, "sandbox", "docker", "env", key]
          : ["agents", "defaults", "sandbox", "docker", "env", key];
      const issuePath = pathSegments.join(".");
      const issueIdentity = JSON.stringify([issuePath, reason]);
      if (seen.has(issueIdentity)) {
        continue;
      }
      seen.add(issueIdentity);
      const backendName = backend === "podman" ? "Podman" : "Docker";
      const remediation =
        reason === "invalid-name"
          ? `Rename key ${JSON.stringify(key)} to use letters, digits, and underscores without a leading digit.`
          : `Use a single-line, non-NUL value for key ${JSON.stringify(key)}, or deliver multiline material through a mounted file or custom image.`;
      issues.push(
        withConfigIssuePath(
          {
            path: issuePath,
            message:
              `${backendName} sandbox backend requires portable environment names and single-line, non-NUL values because the secure env-file transport is line-delimited. ` +
              `${remediation} SSH/OpenShell backends may keep multiline values. Run openclaw doctor to report the invalid path; manual remediation is required.`,
          },
          pathSegments,
        ),
      );
    }
  }
  return issues;
}

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export function validateConfigObjectRaw(
  raw: unknown,
  opts?: {
    sourceRaw?: unknown;
    touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
    validateBundledChannels?: boolean;
    preservedLegacyRootKeys?: readonly string[];
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const normalizedRaw = stripPreservedLegacyRootKeysForValidation(
    raw,
    opts?.preservedLegacyRootKeys,
  );
  const rosterIssues = findLegacyConfigRuleIssues(normalizedRaw, LEGACY_AGENT_ROSTER_RULES);
  if (rosterIssues.length > 0) {
    return { ok: false, issues: rosterIssues };
  }
  // Generic config transforms can rebuild records before schema validation, so
  // validate authored MCP names from the parsed source when it is available.
  const normalizedMcpServerNameIssueKeys = new Set(
    collectMcpServerNameIssues(normalizedRaw).map((issue) =>
      JSON.stringify([issue.path, issue.message]),
    ),
  );
  const mcpServerNameIssues = collectMcpServerNameIssues(opts?.sourceRaw).filter(
    (issue) => !normalizedMcpServerNameIssueKeys.has(JSON.stringify([issue.path, issue.message])),
  );
  const senderPolicyIssues = collectLegacyToolsBySenderIssues(normalizedRaw);
  if (senderPolicyIssues.length > 0) {
    return { ok: false, issues: senderPolicyIssues };
  }
  const policyIssues = collectUnsupportedSecretRefPolicyIssues(normalizedRaw);
  const validated = OpenClawSchema.safeParse(normalizedRaw);
  if (!validated.success || mcpServerNameIssues.length > 0) {
    const schemaIssues = validated.success
      ? mcpServerNameIssues
      : [...mcpServerNameIssues, ...validated.error.issues.map(mapZodIssueToConfigIssue)];
    return {
      ok: false,
      issues: mergeUnsupportedMutableSecretRefIssues(policyIssues, schemaIssues),
    };
  }
  const parsedConfig = validated.data as OpenClawConfig;
  const validatedConfig = attachAgentListProjection(
    materializeBundledModelProviderOverlays(parsedConfig),
  );
  const channelIssues =
    policyIssues.length > 0 || opts?.validateBundledChannels
      ? collectRawBundledChannelConfigIssues(validatedConfig)
      : [];
  if (channelIssues.length > 0) {
    return {
      ok: false,
      issues: mergeUnsupportedMutableSecretRefIssues(policyIssues, channelIssues),
    };
  }
  if (policyIssues.length > 0) {
    return { ok: false, issues: policyIssues };
  }
  const sandboxContainerEnvIssues = collectSandboxContainerEnvIssues(
    validatedConfig,
    opts?.sourceRaw,
  );
  if (sandboxContainerEnvIssues.length > 0) {
    return { ok: false, issues: sandboxContainerEnvIssues };
  }
  const duplicates = findDuplicateAgentDirs(validatedConfig, opts);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [{ path: "agents.entries", message: formatDuplicateAgentDirError(duplicates) }],
    };
  }
  for (const validate of [
    () => validateIdentityAvatar(validatedConfig, opts?.env),
    () => validateGatewayTailscaleBind(validatedConfig),
    () => validateGatewayTailscaleAuth(validatedConfig),
    () => collectModelPolicyAllowIssues(validatedConfig),
  ]) {
    const issues = validate();
    if (issues.length > 0) {
      return { ok: false, issues };
    }
  }
  return { ok: true, config: validatedConfig };
}

export function validateConfigObject(
  raw: unknown,
  opts?: {
    manifestRegistry?: Pick<PluginMetadataSnapshot, "manifestRegistry">["manifestRegistry"];
    sourceRaw?: unknown;
  },
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(applyImplicitAgentRosterDefaults(raw), opts);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: attachAgentListProjection(
      materializeRuntimeConfig(result.config, {
        manifestRegistry: opts?.manifestRegistry,
      }),
    ),
  };
}
