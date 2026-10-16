/**
 * Standalone MCP server for selected built-in OpenClaw tools.
 *
 * Run via: node --import tsx src/mcp/openclaw-tools-serve.ts
 * Or: bun src/mcp/openclaw-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveRequesterToolPolicies } from "../agents/requester-tool-policy.js";
import { withPreparedSessionCapabilityRead } from "../agents/subagents/spawn/subagent-session-store.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { SystemAgentToolOptions } from "../agents/tools/system-agent-tool.js";
import {
  captureRuntimeConfigAsyncReader,
  getRuntimeConfig,
  resolveConfigPath,
} from "../config/config.js";
import { readCurrentConfigForPolicyCheckAsync } from "../config/io.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { routeLogsToStderr } from "../logging/console.js";
import {
  OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveToolsMcpAgentSessionKey as resolveOpenClawToolsMcpAgentSessionKey,
  resolveToolsMcpAgentId,
  resolveToolsMcpSessionContext,
} from "./agent-session-env.js";
import {
  resolveOpenClawToolsMcpSystemAgentApproval,
  resolveOpenClawToolsMcpSystemAgentSurface,
  resolveOpenClawToolsMcpToolSelection,
  type OpenClawToolsMcpToolId,
} from "./openclaw-tools-serve-config.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

export {
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_SURFACE_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV,
} from "./openclaw-tools-serve-config.js";

export { OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV } from "./agent-session-env.js";

export async function resolveOpenClawToolsForMcp(
  params: {
    agentSessionKey?: string;
    agentId?: string;
    tools?: OpenClawToolsMcpToolId[];
    systemAgentSurface?: SystemAgentToolOptions["surface"];
    config?: OpenClawConfig;
  } = {},
): Promise<AnyAgentTool[]> {
  const selection = params.tools ?? resolveOpenClawToolsMcpToolSelection();
  const agentSessionKey = (
    params.agentSessionKey ?? resolveOpenClawToolsMcpAgentSessionKey()
  )?.trim();
  const tools = selection.map((tool) => {
    if (tool === "openclaw") {
      return createSystemAgentTool({
        agentId: params.agentId,
        surface: params.systemAgentSurface ?? resolveOpenClawToolsMcpSystemAgentSurface(),
        ...resolveOpenClawToolsMcpSystemAgentApproval(),
      });
    }
    if (!agentSessionKey) {
      throw new Error(`${OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV} is required`);
    }
    const context = resolveToolsMcpSessionContext({ agentSessionKey, agentId: params.agentId });
    return createCronTool({
      agentSessionKey,
      agentId: context.agentId,
      // Same host-config resolution as plugin-tools-serve: the advertised cron
      // surface must reflect this deployment's cron.triggers.enabled gate.
      config: params.config ?? getRuntimeConfig(),
      creatorToolAllowlist: [{ name: AUTOMATIONS_TOOL_NAME }],
    });
  });
  if (!agentSessionKey) {
    return tools;
  }
  const policyScope = { agentSessionKey, agentId: params.agentId };
  const allowed = await filterToolsByAgentPolicy(tools, {
    ...policyScope,
    config: params.config ?? getRuntimeConfig(),
  });
  return allowed.map((tool) =>
    Object.assign({}, tool, {
      execute: async (...args: Parameters<AnyAgentTool["execute"]>) => {
        const current = await readCurrentConfigForPolicyCheckAsync({
          configPath: resolveConfigPath(),
          env: process.env,
        });
        const stillAllowed = await filterToolsByAgentPolicy([tool], {
          ...policyScope,
          config: current,
        });
        if (stillAllowed.length === 0) {
          throw new Error(`${tool.name} is no longer allowed by the configured tool policy`);
        }
        return await tool.execute(...args);
      },
    }),
  );
}

async function filterToolsByAgentPolicy(
  tools: AnyAgentTool[],
  params: { agentSessionKey: string; agentId?: string; config: OpenClawConfig },
): Promise<AnyAgentTool[]> {
  const { agentSessionKey, config } = params;
  const context = resolveToolsMcpSessionContext({ agentSessionKey, agentId: params.agentId });
  const effective = resolveEffectiveToolPolicy({
    config,
    agentId: context.agentId,
    sessionKey: agentSessionKey,
  });
  const configuredTools = applyToolPolicyPipeline({
    tools,
    toolMeta: () => undefined,
    warn: logWarn,
    steps: buildDefaultToolPolicyPipelineSteps({
      profilePolicy: mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(effective.profile),
        effective.profileAlsoAllow,
      ),
      profile: effective.profile,
      globalPolicy: effective.globalPolicy,
      agentPolicy: effective.agentPolicy,
      agentId: effective.agentId,
    }).map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true })),
  });
  const requesterPolicies = await withPreparedSessionCapabilityRead(() =>
    resolveRequesterToolPolicies({
      config,
      agentId: context.agentId,
      sessionKey: agentSessionKey,
      senderPolicyMode: "never",
    }),
  );
  return configuredTools.filter((tool) =>
    isToolAllowedByPolicies(tool.name, [
      requesterPolicies.groupPolicy,
      requesterPolicies.senderPolicy,
      requesterPolicies.subagentPolicy,
      requesterPolicies.inheritedToolPolicy,
    ]),
  );
}

async function serveOpenClawToolsMcp(): Promise<void> {
  routeLogsToStderr();
  const server = createToolsMcpServer({
    name: "openclaw-tools",
    tools: await resolveOpenClawToolsForMcp({
      agentId: resolveToolsMcpAgentId(),
      config: await captureRuntimeConfigAsyncReader()(),
    }),
  });
  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveOpenClawToolsMcp().catch((err: unknown) => {
    process.stderr.write(`openclaw-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
