/**
 * Compatibility MCP server for the retired Codex Supervisor tool names.
 *
 * The tools are resolved from the bundled Codex plugin so MCP and agent calls
 * share one implementation and one app-server client pool.
 */
import { pathToFileURL } from "node:url";
import type { Server } from "@modelcontextprotocol/server";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import type { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  acquireStandalonePluginToolRegistry,
  type PluginToolRegistryAcquisition,
} from "../plugins/tools.js";
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

const LEGACY_TOOL_NAMES = [
  "codex_endpoint_probe",
  "codex_sessions_list",
  "codex_session_read",
  "codex_session_send",
  "codex_session_interrupt",
] as const;
const LEGACY_TOOL_NAME_SET = new Set<string>(LEGACY_TOOL_NAMES);
const TRUSTED_STANDALONE_MCP_OWNER_CONTEXT = { senderIsOwner: true as const };

function withCodexSupervisionEnabled(config: OpenClawConfig): OpenClawConfig {
  const next = normalizePluginTargetConfig(config, "codex");
  const plugins = (next.plugins ??= {});
  plugins.enabled = true;
  if (plugins.deny) {
    plugins.deny = plugins.deny.filter((entry) => entry !== "codex");
  }
  if (plugins.allow && !plugins.allow.includes("codex")) {
    plugins.allow = [...plugins.allow, "codex"];
  }
  const entries = (plugins.entries ??= {});
  const codex = (entries.codex ??= {});
  codex.enabled = true;
  const codexConfig = (codex.config = { ...codex.config });
  const supervision = (codexConfig.supervision = {
    ...(codexConfig.supervision as Record<string, unknown> | undefined),
  });
  supervision.enabled = true;
  if (process.env.OPENCLAW_CODEX_SUPERVISOR_ALLOW_RAW_TRANSCRIPTS === "1") {
    supervision.allowRawTranscripts = true;
  }
  if (process.env.OPENCLAW_CODEX_SUPERVISOR_ALLOW_WRITE_CONTROLS === "1") {
    supervision.allowWriteControls = true;
  }
  return next;
}

async function acquireCodexSupervisionTools(
  config: OpenClawConfig,
): Promise<PluginToolRegistryAcquisition> {
  const context = {
    config,
    runtimeConfig: config,
    getRuntimeConfig: () => config,
    // This local stdio bridge is operator-launched and intentionally receives
    // the same trusted owner capability as an owner-authenticated agent turn.
    ...TRUSTED_STANDALONE_MCP_OWNER_CONTEXT,
  };
  const toolAllowlist = [...LEGACY_TOOL_NAMES];
  const acquisition = await acquireStandalonePluginToolRegistry({
    context,
    toolAllowlist,
    suppressNameConflicts: true,
    env: process.env,
  });
  return {
    ...acquisition,
    resolveTools: () =>
      acquisition.resolveTools().filter((tool) => LEGACY_TOOL_NAME_SET.has(tool.name)),
  };
}

function requireCompleteCodexSupervisionToolSet(tools: readonly AnyAgentTool[]): void {
  const loadedNames = new Set(tools.map((tool) => tool.name));
  const missing = LEGACY_TOOL_NAMES.filter((name) => !loadedNames.has(name));
  if (missing.length === 0 && tools.length === LEGACY_TOOL_NAMES.length) {
    return;
  }
  throw new Error(
    `Codex supervision MCP could not load the official @openclaw/codex plugin tools (missing: ${missing.join(", ") || "none"}). Install or update @openclaw/codex, then enable Codex supervision.`,
  );
}

export function createCodexSupervisionToolsMcpServer(params: {
  tools: AnyAgentTool[];
  sdkResourceHost?: LegacyPluginSdkResourceHost;
}): Server {
  requireCompleteCodexSupervisionToolSet(params.tools);
  return createToolsMcpServer({ name: "openclaw-codex-supervisor", ...params });
}

export async function serveCodexSupervisionToolsMcp(): Promise<void> {
  routeLogsToStderr();
  await serveRegisteredToolsMcpServer({
    acquireRegistry: async () =>
      acquireCodexSupervisionTools(
        withCodexSupervisionEnabled(await captureRuntimeConfigAsyncReader()()),
      ),
    createServer: (tools, sdkResourceHost) =>
      createCodexSupervisionToolsMcpServer({ tools, sdkResourceHost }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveCodexSupervisionToolsMcp().catch((error: unknown) => {
    process.stderr.write(`codex-supervisor-serve: ${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
