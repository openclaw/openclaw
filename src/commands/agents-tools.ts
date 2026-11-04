// The Gateway owns the effective tool set; this command only asks why a tool is
// or is not available for one session and formats the diagnostics it returns.
import type { ToolsEffectiveResult } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type AgentsToolsOptions = {
  sessionKey: string;
  agent?: string;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type ToolAccessReason = { kind: string; label: string; source?: string; profile?: string };

function describeReasons(reasons: ToolAccessReason[]): string {
  return reasons
    .map((reason) =>
      [reason.kind, reason.label, reason.source, reason.profile]
        .filter((part): part is string => Boolean(part))
        .join(": "),
    )
    .join("; ");
}

function renderAgentsTools(result: ToolsEffectiveResult): string {
  const lines: string[] = [
    `${theme.heading("Effective tools")} ${theme.muted(`${result.agentId} · profile ${result.profile}`)}`,
  ];
  for (const notice of result.notices ?? []) {
    const servers = notice.servers?.length ? ` (${notice.servers.join(", ")})` : "";
    lines.push(
      `${notice.severity === "warning" ? theme.warn("warning") : theme.muted("info")}: ${sanitizeTerminalText(notice.message)}${sanitizeTerminalText(servers)}`,
    );
  }
  const access = result.toolAccess;
  if (access) {
    lines.push(
      renderTable({
        width: getTerminalTableWidth(),
        columns: [
          { key: "Tool", header: "Tool", minWidth: 16 },
          { key: "Status", header: "Status", minWidth: 11 },
          { key: "Reasons", header: "Reasons", minWidth: 24, flex: true },
        ],
        rows: access.tools.map((tool) => ({
          Tool: sanitizeTerminalText(tool.id),
          Status: tool.status,
          Reasons: sanitizeTerminalText(describeReasons(tool.reasons)).slice(0, 200),
        })),
      }).trimEnd(),
    );
    const mcpTools = (result.groups ?? [])
      .filter((group) => group.source === "mcp")
      .flatMap((group) => group.tools);
    if (mcpTools.length > 0) {
      lines.push(
        `${theme.muted("MCP tools:")} ${mcpTools
          .map((tool) => sanitizeTerminalText(tool.id))
          .join(", ")}`,
      );
    }
  } else {
    for (const group of result.groups ?? []) {
      lines.push(
        `${sanitizeTerminalText(group.label)}: ${group.tools.length} tool${group.tools.length === 1 ? "" : "s"}`,
      );
    }
  }
  return lines.join("\n");
}

export async function agentsToolsCommand(
  opts: AgentsToolsOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const sessionKey = opts.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("Session key must not be blank.");
  }
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }

  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };
  const params = {
    sessionKey,
    ...(agent ? { agentId: agent } : {}),
  };

  let result: ToolsEffectiveResult;
  try {
    result = await callGatewayFromCliWithTransport<ToolsEffectiveResult>(
      "tools.effective",
      rpcOpts,
      params,
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), sessionKey });
    } else {
      runtime.error(`Tools diagnostics failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(renderAgentsTools(result));
}
