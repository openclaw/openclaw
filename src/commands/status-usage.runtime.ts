// Optional status usage probes own credential and provider runtime imports.
import {
  resolveAmbientOwnerAgentId,
  resolveConfiguredAgentId,
} from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveModelAuthLabelAsync } from "../agents/model-auth-label.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  buildCodexSyntheticUsageAuth,
  mergeUsageSummaries,
  shouldUseCodexSyntheticUsageForRuntime,
  resolveUsageCredentialType,
} from "../status/codex-synthetic-usage.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { resolveStatusGatewayProbeTimeoutMs } from "./status.gateway-probe-budget.js";

export type StatusUsageSummaryOptions = {
  config: OpenClawConfig;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
  agentId?: string;
  agentDir?: string;
  onSecretDiagnostics?: (diagnostics: string[]) => void;
};

/** Loads provider usage for status output from an explicit or ambient system-agent scope. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await import("../infra/provider-usage.js");
  const rawAgentId = params.agentId?.trim();
  if (params.agentId !== undefined && !rawAgentId) {
    throw new Error("--agent must not be blank");
  }
  const agentId = rawAgentId ? normalizeAgentId(rawAgentId) : undefined;
  if (agentId) {
    resolveConfiguredAgentId(params.config, agentId);
  }
  let resolvedAgentId = agentId;
  let agentDir = params.agentDir;
  if (!agentDir) {
    resolvedAgentId ??= resolveAmbientOwnerAgentId(params.config, undefined, {
      surface: "status usage credentials",
      hint: "Set agents.defaults.systemAgent.agentId.",
    });
    agentDir = resolveAgentDir(params.config, resolvedAgentId);
  }
  const { resolveCommandConfigWithSecrets } = await import("../cli/command-config-resolution.js");
  // The status budget includes local fallback and joins any exec provider it owns.
  const prepared = await withCommandProcessScope(() =>
    awaitWithinDeadline(
      () =>
        resolveCommandConfigWithSecrets({
          config: params.config,
          commandName: "status --usage",
          targetIds: new Set(["models.providers.*.apiKey"]),
          mode: "read_only_status",
          gatewaySecretResolveTimeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
          ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        }),
      params.gatewayProbeDeadlineMs,
      () => performance.now(),
    ),
  );
  const config = prepared === ABSOLUTE_DEADLINE_EXPIRED ? params.config : prepared.resolvedConfig;
  if (prepared !== ABSOLUTE_DEADLINE_EXPIRED) {
    params.onSecretDiagnostics?.(prepared.diagnostics);
  }
  const usage = await loadProviderUsageSummary({
    timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
    config,
    agentDir,
  });
  if (resolveStatusGatewayProbeTimeoutMs(params) === 0) {
    return usage;
  }
  const configuredDefault = resolveDefaultModelForAgent({
    cfg: config,
    agentId: resolvedAgentId,
    allowPluginNormalization: false,
  });
  const policy = resolveAgentHarnessPolicy({
    config,
    agentId: resolvedAgentId,
    provider: configuredDefault.provider,
    modelId: configuredDefault.model,
  });
  if (
    !shouldUseCodexSyntheticUsageForRuntime({
      provider: configuredDefault.provider,
      effectiveHarness: policy.runtime,
    })
  ) {
    return usage;
  }
  const authLabel = await resolveModelAuthLabelAsync({
    provider: configuredDefault.provider,
    cfg: config,
    agentDir,
    includeExternalProfiles: false,
  });
  if (resolveUsageCredentialType(authLabel) === "api_key") {
    return usage;
  }
  const codexUsage = await loadProviderUsageSummary({
    timeoutMs: resolveStatusGatewayProbeTimeoutMs(params),
    providers: ["openai"],
    auth: [buildCodexSyntheticUsageAuth()],
    config,
    agentDir,
  });
  return mergeUsageSummaries(usage, codexUsage);
}
