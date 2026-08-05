import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigFileSnapshot } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import { attachConfigIssueDiagnostics } from "../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  resolveSecretInputRef,
  type PluginIntegrationSecretProviderConfig,
  type SecretRef,
} from "../config/types.secrets.js";
import { validateConfigObjectRawWithPlugins } from "../config/validation.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { type RuntimeEnv, defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { assertSecureExecCommandPath } from "../secrets/exec-provider-path-validation.js";
import {
  isPluginIntegrationSecretProviderConfig,
  resolveSecretProviderIntegrationConfig,
} from "../secrets/provider-integrations.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  secretRefKey,
} from "../secrets/ref-contract.js";
import { resolveSecretRefValue } from "../secrets/resolve.js";
import { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import type { ConfigSetOperation } from "./config-cli-input.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "./config-recovery-hints.js";
import type { ConfigSetDryRunError } from "./config-set-dryrun.js";

function formatInvalidConfigRepairHint(
  snapshot: Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings" | "legacyIssues">,
  doctorMessage: string,
): string {
  return isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
    ? formatPluginPackagingRuntimeOutputRecoveryHint()
    : `Run \`${formatCliCommand("openclaw doctor --fix")}\` ${doctorMessage}`;
}

export async function loadValidConfig(
  runtime: RuntimeEnv = defaultRuntime,
  options: { observe?: boolean; json?: boolean } = {},
) {
  const snapshot =
    options.observe === false
      ? await readConfigFileSnapshot({ observe: false })
      : await readConfigFileSnapshot();
  if (snapshot.valid) {
    return snapshot;
  }
  if (options.json) {
    writeRuntimeJson(runtime, {
      error: `OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`,
      issues: normalizeConfigIssues(snapshot.issues),
    });
    runtime.exit(1);
    return snapshot;
  }
  runtime.error(`OpenClaw config is invalid: ${shortenHomePath(snapshot.path)}`);
  const displayIssues = attachConfigIssueDiagnostics(snapshot.issues, {
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    effective: snapshot.sourceConfig,
    configPath: snapshot.path,
    formatPathForDisplay: true,
    includeReceivedValueHint: true,
  });
  for (const line of formatConfigIssueLines(displayIssues, "-", { normalizeRoot: true })) {
    runtime.error(line);
  }
  runtime.error(formatInvalidConfigRepairHint(snapshot, "to repair, then retry."));
  runtime.exit(1);
  return snapshot;
}

export { formatInvalidConfigRepairHint };

function collectSecretRefsFromUnknown(value: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  const visit = (candidate: unknown) => {
    const ref = coerceSecretRef(candidate);
    if (ref) {
      refs.push(ref);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
    } else if (isPlainRecord(candidate)) {
      Object.values(candidate).forEach(visit);
    }
  };
  visit(value);
  return refs;
}

/**
 * Discovers every active SecretRef a config would resolve at startup, by reusing
 * the runtime secret-assignment collector walk — the same code path
 * {@link prepareSecretsRuntimeSnapshot} uses to decide which refs to materialize.
 * Collectors drop refs on inactive surfaces (disabled model providers, disabled
 * channels/accounts, non-ssh sandbox backends, disabled plugins, inactive gateway
 * auth surfaces, etc.) via {@link collectRuntimeSecretInputAssignment}'s `active`
 * gate, so a ref that startup would skip is not returned here. This keeps the
 * exec-provider preflight selector aligned with startup's ref-driven resolution
 * instead of the static target registry (which lists every configured surface
 * regardless of activity) — see ClawSweeper P1 review on #117128.
 *
 * Non-executing and side-effect free: collection only populates
 * `context.assignments` with {@link SecretAssignment} objects; it never resolves
 * refs or spawns providers. The config is cloned because collectors capture
 * `apply` closures that write resolved values back into the config object, and
 * preflight must not mutate the caller's config.
 */
export function discoverActiveSecretRefs(
  config: OpenClawConfig,
  options?: { env?: NodeJS.ProcessEnv },
): SecretRef[] {
  const resolvedConfig = structuredClone(config);
  const context = createResolverContext({
    sourceConfig: config,
    env: options?.env ?? process.env,
  });
  collectConfigAssignments({ config: resolvedConfig, context });
  const refsByKey = new Map<string, SecretRef>();
  for (const assignment of context.assignments) {
    refsByKey.set(secretRefKey(assignment.ref), assignment.ref);
  }
  return [...refsByKey.values()];
}

/**
 * Active provider aliases startup will resolve, derived from the resulting
 * config's active SecretRefs. On the write path, refs a write explicitly
 * assigns (`operation.assignedRef` and refs embedded in `operation.value`) are
 * folded in so a write that points a SecretRef at a provider prefights that
 * provider even when the target path is not yet a registry-known secret target
 * (matching {@link collectDryRunRefs}'s assigned-ref handling). This keeps the
 * preflight selector aligned with startup's ref-driven resolution while still
 * catching unsafe commands an operator is actively wiring up
 * (see ClawSweeper P1 review on #117128).
 */
export function collectActiveSecretRefProviders(params: {
  config: OpenClawConfig;
  operations?: ConfigSetOperation[];
}): Set<string> {
  const aliases = new Set<string>();
  for (const ref of discoverActiveSecretRefs(params.config)) {
    aliases.add(ref.provider);
  }
  if (params.operations) {
    for (const operation of params.operations) {
      if (operation.assignedRef) {
        aliases.add(operation.assignedRef.provider);
      }
      for (const ref of collectSecretRefsFromUnknown(operation.value)) {
        aliases.add(ref.provider);
      }
    }
  }
  return aliases;
}

export function collectDryRunRefs(params: {
  config: OpenClawConfig;
  operations: ConfigSetOperation[];
}): SecretRef[] {
  const refsByKey = new Map<string, SecretRef>();
  const targetPaths = new Set<string>();
  const providerAliases = new Set<string>();
  let includeAllDiscoveredRefs = false;

  for (const operation of params.operations) {
    if (operation.assignedRef) {
      refsByKey.set(secretRefKey(operation.assignedRef), operation.assignedRef);
    }
    for (const ref of collectSecretRefsFromUnknown(operation.value)) {
      refsByKey.set(secretRefKey(ref), ref);
    }
    if (operation.touchedSecretTargetPath) {
      targetPaths.add(operation.touchedSecretTargetPath);
    }
    if (operation.touchedProviderAlias) {
      providerAliases.add(operation.touchedProviderAlias);
    }
    includeAllDiscoveredRefs ||= operation.touchesAllSecretRefs === true;
  }

  if (!includeAllDiscoveredRefs && targetPaths.size === 0 && providerAliases.size === 0) {
    return [...refsByKey.values()];
  }

  const defaults = params.config.secrets?.defaults;
  for (const target of discoverConfigSecretTargets(params.config)) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (
      ref &&
      (includeAllDiscoveredRefs ||
        targetPaths.has(target.path) ||
        providerAliases.has(ref.provider))
    ) {
      refsByKey.set(secretRefKey(ref), ref);
    }
  }
  return [...refsByKey.values()];
}

export async function collectDryRunResolvabilityErrors(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): Promise<ConfigSetDryRunError[]> {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    try {
      await resolveSecretRefValue(ref, { config: params.config, env: process.env });
    } catch (err) {
      failures.push({
        kind: "resolvability",
        message: String(err),
        ref: `${ref.source}:${ref.provider}:${ref.id}`,
      });
    }
  }
  return failures;
}

export function collectDryRunStaticErrorsForSkippedExecRefs(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): ConfigSetDryRunError[] {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    const id = ref.id.trim();
    const refLabel = `${ref.source}:${ref.provider}:${id}`;
    if (!id) {
      failures.push({
        kind: "resolvability",
        message: "Error: Secret reference id is empty.",
        ref: refLabel,
      });
      continue;
    }
    if (!isValidExecSecretRefId(id)) {
      failures.push({
        kind: "resolvability",
        message: `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    const providerConfig = params.config.secrets?.providers?.[ref.provider];
    if (!providerConfig) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" is not configured (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    if (providerConfig.source !== ref.source) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
        ref: refLabel,
      });
    }
  }
  return failures;
}

export function selectDryRunRefsForResolution(params: {
  refs: SecretRef[];
  allowExecInDryRun: boolean;
}): { refsToResolve: SecretRef[]; skippedExecRefs: SecretRef[] } {
  const refsToResolve: SecretRef[] = [];
  const skippedExecRefs: SecretRef[] = [];
  for (const ref of params.refs) {
    (ref.source === "exec" && !params.allowExecInDryRun ? skippedExecRefs : refsToResolve).push(
      ref,
    );
  }
  return { refsToResolve, skippedExecRefs };
}

export function collectDryRunSchemaErrors(config: OpenClawConfig): ConfigSetDryRunError[] {
  const validated = validateConfigObjectRawWithPlugins(config);
  if (validated.ok) {
    return [];
  }
  return formatConfigIssueLines(validated.issues, "-", { normalizeRoot: true }).map((message) => ({
    kind: "schema",
    message,
  }));
}

/**
 * Runs the same non-executing command-path trust checks over materialized
 * plugin-integration providers that startup applies, scoped to the providers
 * the resulting configuration's active SecretRefs will resolve. See
 * {@link collectManualExecProviderCommandPathErrors} for the active-ref
 * derivation rationale (ClawSweeper P1 review on #117128).
 */
export async function collectPluginIntegrationProviderErrors(params: {
  config: OpenClawConfig;
  operations?: ConfigSetOperation[];
}): Promise<{ errors: ConfigSetDryRunError[]; preflightRan: boolean }> {
  const providers = params.config.secrets?.providers ?? {};
  const activeProviderAliases = collectActiveSecretRefProviders({
    config: params.config,
    operations: params.operations,
  });
  if (activeProviderAliases.size === 0) {
    return { errors: [], preflightRan: false };
  }
  const integrationProviders: Array<{
    alias: string;
    provider: PluginIntegrationSecretProviderConfig;
  }> = [];
  for (const [alias, provider] of Object.entries(providers)) {
    if (activeProviderAliases.has(alias) && isPluginIntegrationSecretProviderConfig(provider)) {
      integrationProviders.push({ alias, provider });
    }
  }
  if (integrationProviders.length === 0) {
    return { errors: [], preflightRan: false };
  }
  const manifestRegistry = loadPluginMetadataSnapshot({
    config: params.config,
    env: process.env,
  }).manifestRegistry;
  const errors: ConfigSetDryRunError[] = [];
  let preflightRan = false;
  for (const { alias, provider } of integrationProviders) {
    // Any integration selected for preflight counts as "ran" regardless of
    // whether materialization succeeds or the command-path check fails, so
    // checks.schema reflects that the plugin-integration preflight executed
    // (see ClawSweeper review on #117128).
    preflightRan = true;
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry,
      providerAlias: alias,
      providerConfig: provider,
      config: params.config,
      env: process.env,
    });
    if (!resolved.ok) {
      errors.push({ kind: "schema", message: `secrets.providers.${alias}: ${resolved.reason}` });
      continue;
    }
    // The integration materialized into a manual exec provider; run the same
    // non-executing command-path trust checks that startup applies so a config
    // cannot pass validation/write and then fail cold start when the
    // materialized command is spawned (see ClawSweeper review on #117128).
    try {
      await assertSecureExecCommandPath({
        command: resolved.providerConfig.command,
        label: `secrets.providers.${alias}.command`,
        ...(resolved.providerConfig.trustedDirs
          ? { trustedDirs: resolved.providerConfig.trustedDirs }
          : {}),
      });
    } catch (err) {
      errors.push({
        kind: "schema",
        message: `secrets.providers.${alias}: ${String(err)}`,
      });
    }
  }
  return { errors, preflightRan };
}

/**
 * Runs the non-executing exec-provider command-path trust checks (the same
 * rules startup activation applies) over the providers that the resulting
 * configuration's active SecretRefs will actually resolve at cold start. A
 * candidate that passes here is structurally equivalent to what cold start will
 * accept, closing the validate/write/startup mismatch (see #117051).
 *
 * Targets are derived from the active SecretRef assignments of `config` (the
 * post-mutation `nextConfig` on the write path, the loaded config on validate),
 * not from every configured provider nor only the aliases a write touched. This
 * matches startup, which resolves providers only after grouping active
 * SecretRefs: an unused integration is not falsely rejected, and a write that
 * disables a plugin or changes `secrets.defaults.exec` can no longer persist an
 * active ref that fails only at startup (see ClawSweeper P1 review on #117128).
 */
export async function collectManualExecProviderCommandPathErrors(params: {
  config: OpenClawConfig;
  operations?: ConfigSetOperation[];
}): Promise<{ errors: ConfigSetDryRunError[]; preflightRan: boolean }> {
  const providers = params.config.secrets?.providers ?? {};
  const activeProviderAliases = collectActiveSecretRefProviders({
    config: params.config,
    operations: params.operations,
  });
  if (activeProviderAliases.size === 0) {
    return { errors: [], preflightRan: false };
  }

  const errors: ConfigSetDryRunError[] = [];
  let preflightRan = false;
  for (const [alias, provider] of Object.entries(providers)) {
    if (!activeProviderAliases.has(alias)) {
      continue;
    }
    if (isPluginIntegrationSecretProviderConfig(provider)) {
      continue;
    }
    // A value-mode write can set a provider to `null` or a primitive without
    // triggering full schema validation; guard the `in` check so malformed
    // provider values fall through to the normal config error path instead of
    // throwing a raw TypeError (see ClawSweeper review on #117128).
    if (provider === null || typeof provider !== "object") {
      continue;
    }
    if (!("command" in provider)) {
      continue;
    }
    preflightRan = true;
    try {
      await assertSecureExecCommandPath({
        command: provider.command,
        label: `secrets.providers.${alias}.command`,
        trustedDirs: provider.trustedDirs,
      });
    } catch (err) {
      errors.push({
        kind: "schema",
        message: `secrets.providers.${alias}: ${String(err)}`,
      });
    }
  }
  return { errors, preflightRan };
}

export function dedupeDryRunErrors(errors: ConfigSetDryRunError[]): ConfigSetDryRunError[] {
  const deduped: ConfigSetDryRunError[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const key =
      error.kind === "resolvability"
        ? `${error.kind}\u0000${error.ref ?? ""}\u0000${error.message}`
        : `${error.kind}\u0000${error.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(error);
    }
  }
  return deduped;
}

export function formatDryRunFailureMessage(params: {
  errors: ConfigSetDryRunError[];
  skippedExecRefs: number;
}): string {
  const missingPathErrors = params.errors.filter((error) => error.kind === "missing-path");
  const schemaErrors = params.errors.filter((error) => error.kind === "schema");
  const resolveErrors = params.errors.filter((error) => error.kind === "resolvability");
  const modelErrors = params.errors.filter((error) => error.kind === "model");
  const lines: string[] = missingPathErrors.map((error) => error.message);
  if (schemaErrors.length > 0) {
    lines.push(
      "Dry run failed: config schema validation failed.",
      ...schemaErrors.map((error) => `- ${error.message}`),
    );
  }
  if (resolveErrors.length > 0) {
    lines.push(
      `Dry run failed: ${resolveErrors.length} SecretRef assignment(s) could not be resolved.`,
      ...resolveErrors
        .slice(0, 5)
        .map((error) => `- ${error.ref ?? "<unknown-ref>"} -> ${error.message}`),
    );
    if (resolveErrors.length > 5) {
      lines.push(`- ... ${resolveErrors.length - 5} more`);
    }
  }
  if (modelErrors.length > 0) {
    lines.push(
      "Dry run failed: model reference validation failed.",
      ...modelErrors.map((error) => `- ${error.message}`),
    );
  }
  if (params.skippedExecRefs > 0) {
    lines.push(
      `Dry run note: skipped ${params.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`,
    );
  }
  return lines.join("\n");
}
