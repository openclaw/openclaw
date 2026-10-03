/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { getRuntimeConfig } from "../config/config.js";
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
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

function resolvePluginToolPolicy(
  config: OpenClawConfig,
  context: ReturnType<typeof resolveToolsMcpSessionContext>,
): {
  toolAllowlist?: string[];
  toolDenylist?: string[];
  steps?: ToolPolicyPipelineStep[];
} {
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
  const steps = effective
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
  const policies = steps?.map((step) => step.policy) ?? [profilePolicy, globalPolicy];
  const toolAllowlist = collectExplicitAllowlist(policies);
  const toolDenylist = collectExplicitDenylist(policies);
  return {
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
    steps,
  };
}

export async function acquirePluginToolsForMcp(params: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
}): Promise<PluginToolRegistryAcquisition> {
  const sessionContext = resolveToolsMcpSessionContext(params);
  const context = { config: params.config, ...sessionContext };
  const { steps, ...pluginToolPolicy } = resolvePluginToolPolicy(params.config, sessionContext);
  const acquisition = await acquireStandalonePluginToolRegistry({
    context,
    ...pluginToolPolicy,
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
    acquireRegistry: () =>
      acquirePluginToolsForMcp({ config: getRuntimeConfig(), agentId: resolveToolsMcpAgentId() }),
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
    process.exit(1);
  });
}
