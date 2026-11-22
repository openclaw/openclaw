/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 */
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/server";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  type ToolPolicyPipelineStep,
} from "../agents/tool-policy-pipeline.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  acquireStandalonePluginToolRegistry,
  type PluginToolRegistryAcquisition,
} from "../plugins/tools.js";
import { resolveToolsMcpAgentId, resolveToolsMcpSessionContext } from "./agent-session-env.js";
import { resolveBridgeExcludedPluginIds } from "./plugin-tools-bridge-filter.js";
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

export const OPENCLAW_PLUGIN_TOOLS_MCP_ALLOW_ENV = "OPENCLAW_PLUGIN_TOOLS_MCP_ALLOW";
export const OPENCLAW_PLUGIN_TOOLS_MCP_DENY_ENV = "OPENCLAW_PLUGIN_TOOLS_MCP_DENY";

export type PluginToolsMcpBridgePolicy = {
  allow?: string[];
  deny?: string[];
};

function dedupeTrimmedEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parsePluginToolsMcpBridgeEnvList(
  env: NodeJS.ProcessEnv,
  envName: typeof OPENCLAW_PLUGIN_TOOLS_MCP_ALLOW_ENV | typeof OPENCLAW_PLUGIN_TOOLS_MCP_DENY_ENV,
): string[] | undefined {
  const raw = env[envName]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${envName} must be a valid JSON string array: ${formatErrorMessage(err)}`, {
        cause: err,
      });
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error(`${envName} must be a JSON array of strings`);
    }
    return dedupeTrimmedEntries(parsed);
  }
  return dedupeTrimmedEntries(normalizeCsvOrLooseStringList(raw));
}

export function resolvePluginToolsMcpBridgePolicy(
  env: NodeJS.ProcessEnv = process.env,
): PluginToolsMcpBridgePolicy | undefined {
  const allow = parsePluginToolsMcpBridgeEnvList(env, OPENCLAW_PLUGIN_TOOLS_MCP_ALLOW_ENV);
  const deny = parsePluginToolsMcpBridgeEnvList(env, OPENCLAW_PLUGIN_TOOLS_MCP_DENY_ENV);
  if (allow === undefined && deny === undefined) {
    return undefined;
  }
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
  };
}

function normalizeBridgePolicy(
  bridgePolicy?: PluginToolsMcpBridgePolicy,
): PluginToolsMcpBridgePolicy | undefined {
  if (!bridgePolicy) {
    return undefined;
  }
  const allow =
    bridgePolicy.allow !== undefined ? dedupeTrimmedEntries(bridgePolicy.allow) : undefined;
  const deny =
    bridgePolicy.deny !== undefined ? dedupeTrimmedEntries(bridgePolicy.deny) : undefined;
  if (allow === undefined && (!deny || deny.length === 0)) {
    return undefined;
  }
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny && deny.length > 0 ? { deny } : {}),
  };
}

export async function acquirePluginToolsForMcp(params: {
  config: OpenClawConfig;
  agentId?: string;
  bridgePolicy?: PluginToolsMcpBridgePolicy;
}): Promise<PluginToolRegistryAcquisition> {
  const { config } = params;
  const bridgePolicy = normalizeBridgePolicy(params.bridgePolicy);
  if (bridgePolicy?.allow && bridgePolicy.allow.length === 0) {
    return {
      resolveTools: () => [],
      release: async () => {},
    };
  }
  const context = { config, ...resolveToolsMcpSessionContext(params) };
  const effective = context.agentId
    ? resolveEffectiveToolPolicy({
        config,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
      })
    : undefined;
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective?.profile ?? config.tools?.profile),
    effective?.profileAlsoAllow ?? config.tools?.alsoAllow,
  );
  const globalPolicy = effective?.globalPolicy ?? pickSandboxToolPolicy(config.tools);
  const baseSteps: ToolPolicyPipelineStep[] | undefined = effective
    ? buildDefaultToolPolicyPipelineSteps({
        profilePolicy,
        profile: effective.profile,
        globalPolicy,
        agentPolicy: effective.agentPolicy,
        agentId: effective.agentId,
      }).map((step) =>
        Object.assign({}, step, {
          // This bridge exposes only plugin tools, so core-tool entries are absent by design.
          suppressUnavailableCoreToolWarning: true,
        }),
      )
    : undefined;
  const bridgeStep: ToolPolicyPipelineStep | undefined = bridgePolicy
    ? {
        label: "acpx.pluginToolsMcpBridge",
        policy: {
          ...(bridgePolicy.allow ? { allow: bridgePolicy.allow } : {}),
          ...(bridgePolicy.deny ? { deny: bridgePolicy.deny } : {}),
        },
        suppressUnavailableCoreToolWarning: true,
      }
    : undefined;
  const steps: ToolPolicyPipelineStep[] | undefined = baseSteps
    ? [...baseSteps, ...(bridgeStep ? [bridgeStep] : [])]
    : bridgeStep
      ? [
          ...(profilePolicy
            ? [
                {
                  label: "tools.profile",
                  policy: profilePolicy,
                  suppressUnavailableCoreToolWarning: true,
                },
              ]
            : []),
          ...(globalPolicy
            ? [
                {
                  label: "tools.allow",
                  policy: globalPolicy,
                  suppressUnavailableCoreToolWarning: true,
                },
              ]
            : []),
          bridgeStep,
        ]
      : undefined;
  const basePolicies = baseSteps?.map((step) => step.policy) ?? [profilePolicy, globalPolicy];
  const baseAllowlist = collectExplicitAllowlist(basePolicies);
  const baseDenylist = collectExplicitDenylist(basePolicies);
  const excludedPluginIds =
    bridgePolicy && steps
      ? resolveBridgeExcludedPluginIds({
          config,
          baseAllowlist,
          baseDenylist,
          steps,
        })
      : [];
  // Keep `toolAllowlist` strictly owned by the base policy so bridge allowlists
  // can never opt in / grant optional plugin tools during standalone loading.
  const toolAllowlist = baseAllowlist;
  const toolDenylist = dedupeTrimmedEntries([
    ...baseDenylist,
    ...(bridgePolicy?.deny ?? []),
    ...excludedPluginIds,
  ]);
  const acquisition = await acquireStandalonePluginToolRegistry({
    context,
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
    suppressNameConflicts: true,
  });
  return {
    ...acquisition,
    resolveTools: () => {
      const tools = acquisition.resolveTools();
      return steps
        ? applyToolPolicyPipeline({ tools, toolMeta: getPluginToolMeta, warn: logWarn, steps })
        : tools;
    },
  };
}

export function createPluginToolsMcpServer(params: {
  tools: AnyAgentTool[];
  sdkResourceHost?: LegacyPluginSdkResourceHost;
}): Server {
  return createToolsMcpServer({ name: "openclaw-plugin-tools", ...params });
}

export async function servePluginToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only, including during plugin
  // tool discovery before the transport is connected.
  routeLogsToStderr();

  await serveRegisteredToolsMcpServer({
    acquireRegistry: async () =>
      acquirePluginToolsForMcp({
        config: await captureRuntimeConfigAsyncReader()(),
        agentId: resolveToolsMcpAgentId(),
        bridgePolicy: resolvePluginToolsMcpBridgePolicy(),
      }),
    createServer: (tools, sdkResourceHost) => {
      if (tools.length === 0) {
        process.stderr.write("plugin-tools-serve: no plugin tools found\n");
      }
      return createPluginToolsMcpServer({ tools, sdkResourceHost });
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  servePluginToolsMcp().catch((err: unknown) => {
    process.stderr.write(`plugin-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
