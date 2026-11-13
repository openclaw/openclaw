// The Gateway owns the agent workspace browser contract (path safety, preview
// caps, content encoding); these commands only forward the two read RPCs and
// format whatever the Gateway returns.
import type {
  AgentsWorkspaceEntry,
  AgentsWorkspaceGetResult,
  AgentsWorkspaceListResult,
} from "../../packages/gateway-protocol/src/schema/agents-workspace.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  getTerminalTableWidth,
  renderTerminalSafeTable,
} from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveAgentOperationAgentId } from "../agents/agent-scope-config.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type AgentsWorkspaceOptions = {
  agent?: string;
  json?: boolean;
  timeout?: string;
  url?: string;
  port?: string;
  token?: string;
  password?: string;
};

export type AgentsWorkspaceListOptions = AgentsWorkspaceOptions & {
  path?: string;
  offset?: string;
  limit?: string;
};

export type AgentsWorkspaceGetOptions = AgentsWorkspaceOptions & { path: string };

function toRpcOptions(
  opts: AgentsWorkspaceOptions,
): Parameters<typeof callGatewayFromCliWithTransport>[1] {
  return {
    url: opts.url,
    port: opts.port,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };
}

async function resolveWorkspaceAgentId(rawAgent: string | undefined): Promise<string> {
  if (rawAgent !== undefined) {
    // An explicit id is forwarded verbatim; the Gateway owns the configured-agent roster.
    return rawAgent;
  }
  const cfg = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  return resolveAgentOperationAgentId(cfg, undefined, {
    surface: "the agents workspace command",
    hint: "Pass --agent <id>.",
  });
}

function parseCount(raw: string | undefined, flag: string, minimum: number): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return value;
}

function describePath(path: string): string {
  return path === "" ? "/" : path;
}

export function renderAgentsWorkspaceEntries(result: AgentsWorkspaceListResult): string {
  return renderTerminalSafeTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Name", header: "Name", minWidth: 12, flex: true },
      { key: "Kind", header: "Kind", minWidth: 9 },
      { key: "Size", header: "Size", minWidth: 8, align: "right" },
      { key: "Updated", header: "Updated", minWidth: 20 },
    ],
    rows: result.entries.map((entry: AgentsWorkspaceEntry) => ({
      Name: entry.name,
      Kind: entry.kind,
      Size: entry.size !== undefined ? String(entry.size) : "",
      Updated: entry.updatedAtMs !== undefined ? new Date(entry.updatedAtMs).toISOString() : "",
    })),
  }).trimEnd();
}

function writePayloadBytes(content: string): void {
  // The file body is the command's payload, so write the exact bytes. The shared
  // runtime stdout writer terminates its value with a newline when one is
  // missing, which would corrupt `> file` redirection and the size the Gateway
  // reported for the same read.
  process.stdout.write(content);
}

function reportFailure(
  err: unknown,
  opts: { json?: boolean },
  runtime: RuntimeEnv,
  subject: string,
): void {
  rethrowExpectedCliError(err);
  const message = formatErrorMessage(err);
  if (opts.json) {
    writeRuntimeJson(runtime, { ...formatCliJsonFailure(message) });
  } else {
    runtime.error(`${subject} failed: ${sanitizeTerminalText(message)}`);
  }
  runtime.exit(1);
}

export async function agentsWorkspaceListCommand(
  opts: AgentsWorkspaceListOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  let offset: number | undefined;
  let limit: number | undefined;
  try {
    offset = parseCount(opts.offset, "--offset", 0);
    limit = parseCount(opts.limit, "--limit", 1);
  } catch (err) {
    // Local argument failures use the same reporter as Gateway failures so
    // `--json` keeps the machine-readable failure envelope scripts rely on.
    reportFailure(err, opts, runtime, "Agent workspace list");
    return;
  }

  let result: AgentsWorkspaceListResult;
  try {
    result = await callGatewayFromCliWithTransport<AgentsWorkspaceListResult>(
      "agents.workspace.list",
      toRpcOptions(opts),
      {
        agentId: await resolveWorkspaceAgentId(opts.agent),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    reportFailure(err, opts, runtime, "Agent workspace list");
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(`${theme.heading("Agent workspace")} ${theme.muted(`· ${result.agentId}`)}`);
  runtime.log(
    theme.muted(
      `path: ${sanitizeTerminalText(describePath(result.path))} · ${result.totalEntries} entries · offset ${result.offset}`,
    ),
  );
  runtime.log(renderAgentsWorkspaceEntries(result));
}

export async function agentsWorkspaceGetCommand(
  opts: AgentsWorkspaceGetOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  let result: AgentsWorkspaceGetResult;
  try {
    result = await callGatewayFromCliWithTransport<AgentsWorkspaceGetResult>(
      "agents.workspace.get",
      toRpcOptions(opts),
      { agentId: await resolveWorkspaceAgentId(opts.agent), path: opts.path },
      { defaultTimeoutMs: 60_000 },
    );
  } catch (err) {
    reportFailure(err, opts, runtime, "Agent workspace file");
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  const file = result.file;
  writePayloadBytes(file.content);
  // Metadata stays on stderr so stdout is only the file payload.
  runtime.error(
    `Agent workspace file ${sanitizeTerminalText(file.path)}, ${file.size} bytes, ${sanitizeTerminalText(
      file.mimeType,
    )}, encoding=${file.encoding}`,
  );
}
