// Doctor runtime checks inspect tool names, browser residue, and runtime state.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { formatUnsupportedNodeVersionMessage } from "../../node-version.mjs";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import type {
  BundleMcpToolRuntime,
  McpToolCatalogDiagnostic,
} from "../agents/agent-bundle-mcp-types.js";
import { tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { partitionMcpServersByConnectionScope } from "../agents/mcp-connection-resolver.js";
import { collectExplicitAllowlist, normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { projectDoctorSecretRuntimeDegradations } from "../commands/doctor-secret-runtime-degradation.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import { isUpdateDoctorLintPass } from "../commands/doctor/shared/update-phase.js";
import {
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  gatewayConnectErrorWasRateLimited,
} from "../commands/gateway-health-auth-diagnostic.js";
import { formatSqliteWalHealthWarning } from "../commands/sqlite-wal-health.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import {
  getSystemdCgroupHygieneSummary,
  type GatewayServiceRuntime,
} from "../daemon/service-runtime.js";
import { resolveGatewayService, readGatewayServiceState } from "../daemon/service.js";
import {
  buildGatewayProbeConnectionDetails,
  callGateway,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatLocalAudioSelection,
  inspectLocalAudioSelection,
} from "../media-understanding/local-audio.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "../plugins/types.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import type { StatusSummary } from "../status/summary.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import type { DoctorToolSchemaOptions } from "./doctor-tool-schema-frames.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

const PROVIDER_CATALOG_ORDERS = ["simple", "profile", "paired", "late"] as const;
const PROVIDER_CATALOG_ORDER_SET = new Set<ProviderCatalogOrder>(PROVIDER_CATALOG_ORDERS);

function formatGatewayHealthDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return scrubDoctorErrorMessage(sanitizeTerminalText(redactSensitiveUrlLikeString(raw)));
}

export function detectUnavailableSkills(cfg: OpenClawConfig, workspaceDir: string) {
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId: tryResolveSoleAgentId(cfg),
  });
  return collectUnavailableAgentSkills(report);
}

export async function collectLocalAudioAccelerationFindings(): Promise<readonly HealthFinding[]> {
  const selection = await inspectLocalAudioSelection();
  const available = selection.candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return [];
  }
  const summary = formatLocalAudioSelection(selection);
  if (summary) {
    return [
      {
        checkId: "core/doctor/local-audio-acceleration",
        severity: "info",
        message: `Local STT auto-selection: ${summary}.`,
        path: "tools.media.models",
      },
    ];
  }
  const blockers = available
    .map((candidate) => `${candidate.command}: ${candidate.reason}`)
    .join("; ");
  return [
    {
      checkId: "core/doctor/local-audio-acceleration",
      severity: "info",
      message: `Local STT commands were found but none are ready for auto-selection: ${blockers}.`,
      path: "tools.media.models",
      fixHint:
        "Install the matching local model/runtime, or configure an audio-capable tools.media.models CLI entry.",
    },
  ];
}

export async function collectGatewayHealthFindings(
  ctx: Pick<HealthCheckContext, "cfg" | "configPath" | "env" | "allowExecSecretRefs">,
): Promise<readonly HealthFinding[]> {
  const mode = ctx.cfg.gateway?.mode === "remote" ? "remote" : "local";
  const gatewayPath = mode === "remote" ? "gateway.remote.url" : "gateway.mode";
  let probeDetails: Awaited<ReturnType<typeof buildGatewayProbeConnectionDetails>> | undefined;
  const warning = (message: string, fixHint: string): HealthFinding => ({
    checkId: "core/doctor/gateway-health",
    severity: "warning",
    message,
    path: probeDetails || mode === "remote" ? gatewayPath : "gateway",
    ...(probeDetails ? { target: formatGatewayHealthDiagnostic(probeDetails.url) } : {}),
    fixHint,
  });
  try {
    probeDetails = await buildGatewayProbeConnectionDetails({
      config: ctx.cfg,
      configPath: ctx.configPath,
    });
    if (
      ctx.allowExecSecretRefs !== true &&
      (await hasActiveGatewayExecCredential({
        cfg: ctx.cfg,
        env: ctx.env,
        targetUrl: probeDetails.url,
      }))
    ) {
      return [
        warning(
          "Authenticated Gateway health inspection was intentionally skipped because an active credential uses an exec SecretRef.",
          "Rerun `openclaw doctor --lint --only core/doctor/gateway-health --allow-exec` to permit configured secret execution.",
        ),
      ];
    }
    const status = await callGateway<StatusSummary>({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      sharedStateMode: "read-only",
      config: ctx.cfg,
      configPath: ctx.configPath,
      tlsFingerprint: probeDetails.tlsFingerprint,
      preauthHandshakeTimeoutMs: probeDetails.preauthHandshakeTimeoutMs,
    });
    const findings: HealthFinding[] = projectDoctorSecretRuntimeDegradations(status).map(
      (owner) => ({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: `Secret runtime degradation: ${owner.message}`,
        path: owner.path,
        target: owner.target,
        fixHint: `Retry: ${owner.retryHint}`,
      }),
    );
    const sqliteWalWarning = formatSqliteWalHealthWarning(status.sqliteWal);
    if (sqliteWalWarning) {
      findings.push(
        warning(`SQLite WAL: ${sqliteWalWarning}`, "Inspect openclaw status --deep output."),
      );
    }
    return findings;
  } catch (error) {
    if (!probeDetails) {
      return [
        warning(
          `Gateway health inspection could not be prepared: ${formatGatewayHealthDiagnostic(error)}`,
          "Fix Gateway connection configuration, then rerun `openclaw doctor --lint --only core/doctor/gateway-health`.",
        ),
      ];
    }
    const diagnostic = gatewayConnectErrorWasRateLimited(error)
      ? {
          message: GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
          fixHint: "Wait for the temporary authentication lockout to expire, then rerun doctor.",
        }
      : isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error)
        ? {
            message:
              "Gateway status could not be inspected because this CLI has no usable token/password or paired device token for read-scope RPCs.",
            fixHint:
              "Configure the Gateway token/password or pair this device, then rerun the selected health check.",
          }
        : {
            message: `Gateway status could not be inspected: ${formatGatewayHealthDiagnostic(error)}`,
            fixHint:
              mode === "remote"
                ? "Verify the remote Gateway URL, network path, TLS settings, and credentials."
                : "Inspect the service with `openclaw gateway status --deep`, or run `openclaw doctor` for guided checks.",
          };
    return [warning(diagnostic.message, diagnostic.fixHint)];
  }
}

function gatewayRuntimeStatus(runtime: GatewayServiceRuntime | undefined): string | undefined {
  return runtime?.status ?? runtime?.state ?? runtime?.subState;
}

export async function collectGatewayDaemonFindings(
  ctx: Pick<HealthCheckContext, "cfg">,
): Promise<readonly HealthFinding[]> {
  if (ctx.cfg.gateway?.mode === "remote" || !(await shouldManageGatewayService())) {
    return [];
  }
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  const findings: HealthFinding[] = [];
  if (state.loadState.status === "unknown") {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: `Gateway service status could not be determined: ${state.loadState.detail}`,
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Run `openclaw gateway status --deep`, restore service-manager access, and retry.",
    });
    return findings;
  }
  if (!state.installed) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      target: service.label,
      fixHint: "Run `openclaw gateway install` to install the service.",
    });
    return findings;
  }
  const nodePath = state.command?.programArguments[0];
  if (nodePath && isNodeRuntime(nodePath)) {
    const runtime = await resolveNodeRuntimeInfo(nodePath, state.env);
    const message =
      runtime.status === "probe-failed"
        ? runtime.error.message
        : (runtime.capabilityError ?? runtime.note);
    if (message) {
      findings.push({
        checkId: "core/doctor/gateway-daemon",
        severity: runtime.status === "supported" ? "info" : "warning",
        message,
        path: state.command?.sourcePath,
        target: nodePath,
        ...(runtime.status !== "supported"
          ? {
              fixHint: [
                ...(runtime.status === "unsupported"
                  ? [formatUnsupportedNodeVersionMessage(runtime.version)]
                  : []),
                "Repair the Node runtime, then run `openclaw gateway install`.",
              ].join("\n"),
            }
          : {}),
      });
    }
  }
  if (state.loadState.status === "not-loaded") {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is installed but not loaded.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Start the installed service with `openclaw gateway start`.",
    });
  }
  const status = gatewayRuntimeStatus(state.runtime);
  if (state.loadState.status === "loaded" && !state.running) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: status
        ? `Gateway service runtime is ${status}, not running.`
        : "Gateway service is loaded but runtime status could not confirm it is running.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint:
        "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    });
  }
  if (state.runtime?.missingGuiSession) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service cannot attach to the user GUI session.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Log into a GUI session, then rerun doctor.",
    });
  }
  if (state.runtime?.missingUnit) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service supervision metadata is missing.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Reinstall or reload the Gateway service.",
    });
  }
  const hygiene = getSystemdCgroupHygieneSummary(state.runtime?.systemd);
  if (hygiene) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: `Gateway systemd service has risky ${hygiene}.`,
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Repair the systemd unit so stale child processes are cleaned up reliably.",
    });
  }
  return findings;
}

function providerCatalogPath(pluginId: string | undefined): string | undefined {
  return pluginId ? `plugins.entries.${pluginId}` : undefined;
}

function providerCatalogProjectionFinding(params: {
  providerId: string;
  pluginId?: string;
  message: string;
  error: unknown;
}): HealthFinding {
  const path = providerCatalogPath(params.pluginId);
  return {
    checkId: "core/doctor/provider-catalog-projection",
    severity: "error",
    message: params.message,
    ...(path ? { path } : {}),
    target: params.providerId,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
  };
}

function isReadableRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function hasProviderCatalogKey(params: {
  value: Record<string, unknown>;
  key: string;
  providerId: string;
  pluginId?: string;
}): { ok: true; present: boolean } | { ok: false; finding: HealthFinding } {
  try {
    return { ok: true, present: params.key in params.value };
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result keys cannot be checked during doctor validation.`,
        error,
      }),
    };
  }
}

function readProviderCatalogValue(params: {
  value: unknown;
  key: string;
  providerId: string;
  pluginId?: string;
}): { ok: true; value: unknown } | { ok: false; finding: HealthFinding } {
  if (!isReadableRecord(params.value)) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: params.value[params.key] };
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} entry cannot be read during doctor validation.`,
        error,
      }),
    };
  }
}

function collectProviderCatalogModelFindings(params: {
  providerId: string;
  pluginId?: string;
  models: unknown;
}): HealthFinding[] {
  const findings: HealthFinding[] = [];
  let models: unknown[];
  try {
    if (!Array.isArray(params.models)) {
      return [
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} models value is invalid during doctor validation.`,
          error: new Error("models must be an array"),
        }),
      ];
    }
    models = params.models;
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} models value cannot be checked during doctor validation.`,
        error,
      }),
    ];
  }
  let modelEntries: Array<[number, unknown]>;
  try {
    modelEntries = [];
    let index = 0;
    for (const model of models) {
      modelEntries.push([index, model]);
      index += 1;
    }
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} model rows cannot be enumerated during doctor validation.`,
        error,
      }),
    ];
  }
  for (const [index, model] of modelEntries) {
    const modelId = readProviderCatalogValue({
      value: model,
      key: "id",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    if (!modelId.ok) {
      findings.push(modelId.finding);
      continue;
    }
    if (!isTrimmedNonEmptyString(modelId.value)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} model row ${index} has an invalid model id.`,
          error: new Error("model id must be a non-empty trimmed string"),
        }),
      );
    }
    const modelName = readProviderCatalogValue({
      value: model,
      key: "name",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    if (!modelName.ok) {
      findings.push(modelName.finding);
      continue;
    }
    if (modelName.value !== undefined && typeof modelName.value !== "string") {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} model row ${index} has an invalid model name.`,
          error: new Error("model name must be a string when present"),
        }),
      );
    }
  }
  return findings;
}

function collectProviderCatalogResultFindings(params: {
  providerId: string;
  pluginId?: string;
  result: unknown;
}): HealthFinding[] {
  if (params.result == null) {
    return [];
  }
  if (!isReadableRecord(params.result)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result is invalid during doctor validation.`,
        error: new Error("result must be an object"),
      }),
    ];
  }
  const hasProvider = hasProviderCatalogKey({
    value: params.result,
    key: "provider",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!hasProvider.ok) {
    return [hasProvider.finding];
  }
  const provider = readProviderCatalogValue({
    value: params.result,
    key: "provider",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!provider.ok) {
    return [provider.finding];
  }
  if (hasProvider.present && !isReadableRecord(provider.value)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} provider value is invalid during doctor validation.`,
        error: new Error("provider must be an object"),
      }),
    ];
  }
  if (isReadableRecord(provider.value)) {
    const models = readProviderCatalogValue({
      value: provider.value,
      key: "models",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    return models.ok
      ? collectProviderCatalogModelFindings({ ...params, models: models.value })
      : [models.finding];
  }

  const providers = readProviderCatalogValue({
    value: params.result,
    key: "providers",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!providers.ok) {
    return [providers.finding];
  }
  if (!isReadableRecord(providers.value)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result is invalid during doctor validation.`,
        error: new Error("result must include provider or providers object"),
      }),
    ];
  }
  let providerIds: string[];
  try {
    providerIds = Object.keys(providers.value);
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} provider entries cannot be enumerated during doctor validation.`,
        error,
      }),
    ];
  }
  const findings: HealthFinding[] = [];
  for (const providerId of providerIds) {
    if (!isTrimmedNonEmptyString(providerId)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} provider key is invalid during doctor validation.`,
          error: new Error("provider key must be a non-empty trimmed string"),
        }),
      );
      continue;
    }
    const providerConfig = readProviderCatalogValue({
      value: providers.value,
      key: providerId,
      providerId,
      pluginId: params.pluginId,
    });
    if (!providerConfig.ok) {
      findings.push(providerConfig.finding);
      continue;
    }
    if (!isReadableRecord(providerConfig.value)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${providerId} provider entry is invalid during doctor validation.`,
          error: new Error("provider entry must be an object"),
        }),
      );
      continue;
    }
    const models = readProviderCatalogValue({
      value: providerConfig.value,
      key: "models",
      providerId,
      pluginId: params.pluginId,
    });
    findings.push(
      ...(models.ok
        ? collectProviderCatalogModelFindings({
            providerId,
            pluginId: params.pluginId,
            models: models.value,
          })
        : [models.finding]),
    );
  }
  return findings;
}

function readProviderCatalogOrder(
  provider: ProviderPlugin,
): { ok: true; order: ProviderCatalogOrder } | { ok: false; finding: HealthFinding } {
  let order: unknown;
  try {
    order = provider.staticCatalog?.order ?? "late";
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: provider.id,
        pluginId: provider.pluginId,
        message: `Provider catalog ${provider.id} order cannot be read during doctor validation.`,
        error,
      }),
    };
  }
  if (PROVIDER_CATALOG_ORDER_SET.has(order as ProviderCatalogOrder)) {
    return { ok: true, order: order as ProviderCatalogOrder };
  }
  return {
    ok: false,
    finding: providerCatalogProjectionFinding({
      providerId: provider.id,
      pluginId: provider.pluginId,
      message: `Provider catalog ${provider.id} order is invalid during doctor validation.`,
      error: new Error("order must be simple, profile, paired, or late"),
    }),
  };
}

function groupProviderCatalogsForDoctor(providers: readonly ProviderPlugin[]): {
  findings: HealthFinding[];
  byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]>;
} {
  const findings: HealthFinding[] = [];
  const byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]> = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  };
  for (const provider of providers) {
    const order = readProviderCatalogOrder(provider);
    if (!order.ok) {
      findings.push(order.finding);
      byOrder.late.push(provider);
      continue;
    }
    byOrder[order.order].push(provider);
  }
  for (const order of PROVIDER_CATALOG_ORDERS) {
    byOrder[order].sort((a, b) => a.label.localeCompare(b.label));
  }
  return { findings, byOrder };
}

export async function collectProviderCatalogProjectionFindings(
  cfg: OpenClawConfig,
  workspaceDir?: string,
): Promise<readonly HealthFinding[]> {
  const { runProviderStaticCatalog } = await import("../plugins/provider-discovery.js");
  const { resolvePluginProvidersCore } = await import("../plugins/providers.runtime.js");
  const env = process.env;
  let providers: Awaited<ReturnType<typeof resolvePluginProvidersCore>>;
  try {
    providers = resolvePluginProvidersCore({
      config: cfg,
      workspaceDir,
      env,
      includeUntrustedWorkspacePlugins: false,
    });
  } catch (error) {
    return [
      {
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        message: "Provider catalog hooks could not be loaded for doctor validation.",
        requirement: formatErrorMessage(error),
        fixHint: "Fix plugin provider discovery loading, then rerun doctor.",
      },
    ];
  }

  const findings: HealthFinding[] = [];
  const grouped = groupProviderCatalogsForDoctor(providers);
  findings.push(...grouped.findings);
  for (const order of PROVIDER_CATALOG_ORDERS) {
    for (const provider of grouped.byOrder[order]) {
      let staticCatalog: unknown;
      let staticCatalogRun: unknown;
      try {
        staticCatalog = provider.staticCatalog;
        staticCatalogRun = isReadableRecord(staticCatalog) ? staticCatalog.run : undefined;
      } catch (error) {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} static catalog hook cannot be read during doctor validation.`,
            error,
          }),
        );
        continue;
      }
      if (staticCatalog === undefined) {
        continue;
      }
      if (typeof staticCatalogRun !== "function") {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} static catalog hook is invalid during doctor validation.`,
            error: new Error("static catalog run must be a function"),
          }),
        );
        continue;
      }
      let result: Awaited<ReturnType<typeof runProviderStaticCatalog>>;
      try {
        result = await runProviderStaticCatalog({ provider });
      } catch (error) {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} failed during doctor validation.`,
            error,
          }),
        );
        continue;
      }
      findings.push(
        ...collectProviderCatalogResultFindings({
          providerId: provider.id,
          pluginId: provider.pluginId,
          result,
        }),
      );
    }
  }
  return findings;
}

async function collectBundleMcpRuntimeToolSchemaFindings(params: {
  bundleRuntime: BundleMcpToolRuntime;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
}): Promise<readonly HealthFinding[]> {
  const { collectNormalizedToolSchemaFindings } =
    await import("./doctor-tool-schema-projection.js");
  const activeBundleTools = applyFinalEffectiveToolPolicy({
    bundledTools: params.bundleRuntime.tools,
    config: params.cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
      config: params.cfg,
      agentId: params.agentId,
      modelProvider: params.modelRef.provider,
      modelId: params.modelRef.model,
    }),
    warn: () => {},
  });
  return collectNormalizedToolSchemaFindings({
    agentId: params.agentId,
    tools: activeBundleTools,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    modelRef: params.modelRef,
    model: params.model,
    normalizationFailureFinding: bundleMcpRuntimeNormalizationFailureFinding,
  });
}

function bundleMcpRuntimeNormalizationFailureFinding(error: unknown): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: "Configured MCP tool schema validation could not normalize the runtime tool set.",
    path: "mcp.servers",
    requirement: formatErrorMessage(error),
    fixHint:
      "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
  };
}

function bundleMcpRuntimeLoadFailureFinding(error: unknown): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: "Configured MCP tool schema validation could not load the runtime tool set.",
    path: "mcp.servers",
    requirement: formatErrorMessage(error),
    fixHint:
      "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
  };
}

function bundleMcpRuntimeDiagnosticFinding(diagnostic: McpToolCatalogDiagnostic): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Configured MCP server "${diagnostic.serverName}" could not expose runtime tools for schema validation.`,
    path: `mcp.servers.${diagnostic.serverName}`,
    requirement: diagnostic.message,
    fixHint:
      "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
  };
}

function bundleMcpRequesterInspectionFinding(serverName: string): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "info",
    message: `Configured requester-scoped MCP server "${serverName}" was not probed without an authenticated requester.`,
    path: `mcp.servers.${serverName}`,
    requirement: "authenticated requester context",
    fixHint: "Verify this server from an authenticated agent turn.",
  };
}

function makeBundleMcpDiagnosticSentinel(name: string): AnyAgentTool {
  const sentinel: AnyAgentTool = {
    name,
    label: "Bundle MCP diagnostic",
    description: "Internal doctor sentinel for bundle MCP schema diagnostics.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as AnyAgentTool;
  setPluginToolMeta(sentinel, { pluginId: "bundle-mcp", optional: false });
  return sentinel;
}

function synthesizeBundleMcpAllowlistSentinelName(params: {
  safeServerName: string;
  allowlistEntry: string;
}): string | undefined {
  const normalized = normalizeToolPolicyName(params.allowlistEntry);
  const serverPrefix = normalizeToolPolicyName(`${params.safeServerName}${TOOL_NAME_SEPARATOR}`);
  if (normalized.startsWith(serverPrefix)) {
    return normalized;
  }
  const separatorIndex = normalized.lastIndexOf(TOOL_NAME_SEPARATOR);
  if (separatorIndex < 0) {
    return undefined;
  }
  const toolPattern = normalized.slice(separatorIndex + TOOL_NAME_SEPARATOR.length);
  if (!toolPattern) {
    return undefined;
  }
  const concreteToolName = toolPattern.replace(/\*/g, "diagnostic").replace(/\?/g, "x");
  return `${params.safeServerName}${TOOL_NAME_SEPARATOR}${concreteToolName}`;
}

function collectBundleMcpDiagnosticSentinels(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
  diagnostic: McpToolCatalogDiagnostic;
}): AnyAgentTool[] {
  const sentinels = [
    makeBundleMcpDiagnosticSentinel(
      `${params.diagnostic.safeServerName}${TOOL_NAME_SEPARATOR}runtime_schema`,
    ),
  ];
  const effectivePolicy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
  });
  const explicitAllowlist = collectExplicitAllowlist([
    effectivePolicy.globalPolicy,
    effectivePolicy.globalProviderPolicy,
    effectivePolicy.agentPolicy,
    effectivePolicy.agentProviderPolicy,
    effectivePolicy.profileAlsoAllow ? { allow: effectivePolicy.profileAlsoAllow } : undefined,
    effectivePolicy.providerProfileAlsoAllow
      ? { allow: effectivePolicy.providerProfileAlsoAllow }
      : undefined,
  ]);
  if (explicitAllowlist.length === 0) {
    return sentinels;
  }

  for (const entry of explicitAllowlist) {
    const sentinelName = synthesizeBundleMcpAllowlistSentinelName({
      safeServerName: params.diagnostic.safeServerName,
      allowlistEntry: entry,
    });
    if (sentinelName) {
      sentinels.push(makeBundleMcpDiagnosticSentinel(sentinelName));
    }
  }
  return sentinels;
}

function shouldReportBundleMcpRuntimeDiagnostic(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
  diagnostic: McpToolCatalogDiagnostic;
}): boolean {
  return (
    applyFinalEffectiveToolPolicy({
      bundledTools: collectBundleMcpDiagnosticSentinels(params),
      config: params.cfg,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config: params.cfg,
        agentId: params.agentId,
        modelProvider: params.modelRef.provider,
        modelId: params.modelRef.model,
      }),
      warn: () => {},
    }).length > 0
  );
}

function filterPolicyActiveBundleMcpDiagnostics(params: {
  diagnostics: readonly McpToolCatalogDiagnostic[];
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
}): readonly McpToolCatalogDiagnostic[] {
  return params.diagnostics.filter((diagnostic) =>
    shouldReportBundleMcpRuntimeDiagnostic({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: params.modelRef,
      diagnostic,
    }),
  );
}

export async function collectRuntimeToolSchemaFindings(
  sourceConfig: OpenClawConfig,
  options: DoctorToolSchemaOptions = {},
): Promise<readonly HealthFinding[]> {
  const [
    { captureRuntimeConfig },
    { prepareDoctorToolSchemaFrames },
    { collectAgentRuntimeToolSchemaFindings },
  ] = await Promise.all([
    import("../config/runtime-source-projection.js"),
    import("./doctor-tool-schema-frames.js"),
    import("./doctor-tool-schema-projection.js"),
  ]);
  const cfg = captureRuntimeConfig(sourceConfig);
  const env = options.env ?? process.env;
  const runWithPluginMetadataSnapshot =
    options.runWithPluginMetadataSnapshot ??
    (
      await import("../commands/doctor/shared/plugin-metadata-snapshot-scope.js")
    ).createDoctorPluginMetadataSnapshotScope({ env }).run;
  const { frames, findings } = await prepareDoctorToolSchemaFrames(cfg, {
    ...options,
    env,
    runWithPluginMetadataSnapshot,
  });
  const deferMcpProbes = isUpdateDoctorLintPass(env);
  const deferredServers = new Set<string>();
  const bundleRuntimeByContext = new Map<string, BundleMcpToolRuntime>();
  const bundleRuntimeLoadErrorsByContext = new Map<string, HealthFinding>();
  const reportedBundleRuntimeDiagnostics = new Set<string>();
  const reportedBundleRuntimeLoadErrors = new Set<string>();
  const reportedRequesterScopedServers = new Set<string>();
  let inspection:
    | Awaited<ReturnType<typeof import("../plugins/tools.js").acquirePluginToolInspectionRegistry>>
    | undefined;
  try {
    if (frames.length > 0) {
      try {
        const [{ acquirePluginToolInspectionRegistry }, { resolvePluginRuntimeLoadContext }] =
          await Promise.all([
            import("../plugins/tools.js"),
            import("../plugins/runtime/load-context.resolve.js"),
          ]);
        inspection = await runWithPluginMetadataSnapshot({ config: cfg }, () =>
          acquirePluginToolInspectionRegistry({
            loadContext: resolvePluginRuntimeLoadContext({ config: cfg, env }),
            runWithPluginMetadataSnapshot,
            scopes: frames.map((frame) => ({
              context: {
                config: cfg,
                runtimeConfig: cfg,
                agentId: frame.agentId,
                agentDir: frame.agentDir,
                workspaceDir: frame.workspaceDir,
              },
              env,
              allowGatewaySubagentBinding: true,
              toolAllowlist: appendRuntimePluginToolGrant(
                frame.capabilityProfile.policy.explicitToolAllowlist,
                frame.capabilityProfile.policy.runtimePluginToolGrant,
              ),
              toolDenylist: frame.capabilityProfile.policy.explicitToolDenylist,
            })),
          }),
        );
      } catch (error) {
        findings.push({
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "warning",
          message: "Runtime tool schema inspection could not prepare plugin registrations.",
          requirement: formatErrorMessage(error),
          fixHint: "Fix plugin loading errors, then rerun doctor to inspect active tools.",
        });
        return findings;
      }
      for (const plugin of inspection.registry?.plugins ?? []) {
        if (plugin.status === "error") {
          findings.push({
            checkId: "core/doctor/runtime-tool-schemas",
            severity: "warning",
            message: `Plugin ${plugin.id} tool schemas were not inspected because registration failed.`,
            path: `plugins.entries.${plugin.id}`,
            target: plugin.id,
            requirement: plugin.error ?? "plugin-registration-failed",
            fixHint: "Fix or disable the plugin, then rerun doctor.",
          });
        }
      }
    }
    for (const frame of frames) {
      const { agentId, agentDir, workspaceDir, modelRef, model } = frame;
      const collectForAgent = async () => {
        findings.push(
          ...(await withPluginRuntimeRegistryScope(inspection?.registry, () =>
            collectAgentRuntimeToolSchemaFindings({ ...frame, cfg }),
          )),
        );
        if (!shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true })) {
          return;
        }
        const fullMcpConfig = loadSessionMcpConfig({
          workspaceDir,
          cfg,
          logDiagnostics: false,
        });
        if (deferMcpProbes) {
          for (const serverName of Object.keys(fullMcpConfig.loaded.mcpServers)) {
            if (deferredServers.has(serverName)) {
              continue;
            }
            deferredServers.add(serverName);
            findings.push({
              checkId: "core/doctor/runtime-tool-schemas",
              severity: "warning",
              message: `MCP server "${sanitizeTerminalText(serverName)}" was not started for update validation. Run \`openclaw doctor --lint --only core/doctor/runtime-tool-schemas\` after the update to inspect its tools.`,
              path: `mcp.servers.${serverName}`,
            });
          }
          return;
        }
        const safeServerNamesByServer = assignSafeServerNames(
          Object.keys(fullMcpConfig.loaded.mcpServers),
        );
        const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(
          fullMcpConfig.loaded.mcpServers,
        );
        for (const serverName of requesterScopedServerNames) {
          if (reportedRequesterScopedServers.has(serverName)) {
            continue;
          }
          const diagnostic: McpToolCatalogDiagnostic = {
            serverName,
            safeServerName: safeServerNamesByServer.get(serverName) ?? serverName,
            launchSummary: "requester-scoped connection",
            message: "authenticated requester context required",
          };
          if (shouldReportBundleMcpRuntimeDiagnostic({ cfg, agentId, modelRef, diagnostic })) {
            findings.push(bundleMcpRequesterInspectionFinding(serverName));
            reportedRequesterScopedServers.add(serverName);
          }
        }
        const excludeServerNames = new Set(requesterScopedServerNames);
        for (const [serverName, server] of Object.entries(fullMcpConfig.loaded.mcpServers)) {
          if (excludeServerNames.has(serverName) || server.auth !== "oauth") {
            continue;
          }
          // A private database cannot isolate refresh-token rotation at the server.
          // Discarding its replacement would strand the live owner on a spent token.
          // This also covers refresh-capable auth profiles, not just MCP-native OAuth.
          excludeServerNames.add(serverName);
          const diagnostic: McpToolCatalogDiagnostic = {
            serverName,
            safeServerName: safeServerNamesByServer.get(serverName) ?? serverName,
            launchSummary: "OAuth inspection deferred",
            message: "OAuth refresh requires durable credential ownership",
          };
          if (
            !reportedBundleRuntimeDiagnostics.has(serverName) &&
            shouldReportBundleMcpRuntimeDiagnostic({ cfg, agentId, modelRef, diagnostic })
          ) {
            findings.push({
              checkId: "core/doctor/runtime-tool-schemas",
              severity: "info",
              message: `Configured MCP server "${serverName}" was not probed during read-only inspection because OAuth may rotate external credentials.`,
              path: `mcp.servers.${serverName}`,
              fixHint:
                "For configured servers, run `openclaw mcp probe <name>` against the serving configuration. Validate plugin-provided or agent-local MCP servers from an authenticated serving-agent turn so refreshed credentials persist with their owner.",
            });
            reportedBundleRuntimeDiagnostics.add(serverName);
          }
        }
        const staticMcpConfig = loadSessionMcpConfig({
          workspaceDir,
          cfg,
          logDiagnostics: false,
          excludeServerNames,
          safeServerNamesByServer,
        });
        // Equivalent non-OAuth catalogs share one probe; refresh-capable profiles are deferred.
        const runtimeContext = staticMcpConfig.fingerprint;
        if (
          !bundleRuntimeByContext.has(runtimeContext) &&
          !bundleRuntimeLoadErrorsByContext.has(runtimeContext)
        ) {
          try {
            const { createBundleMcpToolRuntime } =
              await import("../agents/agent-bundle-mcp-tools.js");
            bundleRuntimeByContext.set(
              runtimeContext,
              await createBundleMcpToolRuntime({
                workspaceDir,
                agentDir,
                cfg,
                excludeServerNames,
                safeServerNamesByServer,
              }),
            );
          } catch (error) {
            bundleRuntimeLoadErrorsByContext.set(
              runtimeContext,
              bundleMcpRuntimeLoadFailureFinding(error),
            );
          }
        }
        const bundleRuntimeLoadError = bundleRuntimeLoadErrorsByContext.get(runtimeContext);
        if (bundleRuntimeLoadError) {
          if (!reportedBundleRuntimeLoadErrors.has(runtimeContext)) {
            findings.push(bundleRuntimeLoadError);
            reportedBundleRuntimeLoadErrors.add(runtimeContext);
          }
          return;
        }
        const bundleRuntime = bundleRuntimeByContext.get(runtimeContext);
        if (bundleRuntime) {
          if (bundleRuntime.diagnostics && bundleRuntime.diagnostics.length > 0) {
            const policyActiveDiagnostics = filterPolicyActiveBundleMcpDiagnostics({
              diagnostics: bundleRuntime.diagnostics,
              cfg,
              agentId,
              modelRef,
            });
            for (const diagnostic of policyActiveDiagnostics) {
              if (reportedBundleRuntimeDiagnostics.has(diagnostic.serverName)) {
                continue;
              }
              findings.push(bundleMcpRuntimeDiagnosticFinding(diagnostic));
              reportedBundleRuntimeDiagnostics.add(diagnostic.serverName);
            }
          }
          findings.push(
            ...(await collectBundleMcpRuntimeToolSchemaFindings({
              bundleRuntime,
              cfg,
              agentId,
              workspaceDir,
              modelRef,
              model,
            })),
          );
        }
      };
      await runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, collectForAgent);
    }
  } finally {
    const cleanup = await Promise.allSettled(
      [...bundleRuntimeByContext.values()].map(async (runtime) => await runtime.dispose()),
    );
    for (const outcome of cleanup) {
      if (outcome.status === "rejected") {
        findings.push({
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "error",
          message: "Configured MCP tool schema inspection could not confirm child-process cleanup.",
          path: "mcp.servers",
          requirement: formatErrorMessage(outcome.reason),
          fixHint: "Inspect or stop the configured MCP server processes, then rerun doctor.",
        });
      }
    }
    try {
      await inspection?.release();
    } catch (error) {
      findings.push({
        checkId: "core/doctor/runtime-tool-schemas",
        severity: "warning",
        message: "Runtime tool schema inspection could not confirm plugin cleanup.",
        requirement: formatErrorMessage(error),
        fixHint: "Inspect the plugin cleanup error, then rerun doctor.",
      });
    }
  }
  return findings;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
