import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import type {
  BundleMcpToolRuntime,
  McpToolCatalogDiagnostic,
} from "../agents/agent-bundle-mcp-types.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { partitionMcpServersByConnectionScope } from "../agents/mcp-connection-resolver.js";
import { collectExplicitAllowlist, normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { isUpdateDoctorLintPass } from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { DoctorToolSchemaOptions } from "./doctor-tool-schema-frames.js";
import type { HealthFinding } from "./health-checks.js";

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
  };
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
    if (inspection && options.deferInspectionDisposal) {
      const resource = inspection;
      options.deferInspectionDisposal(() => resource.release());
    } else {
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
  }
  return findings;
}
