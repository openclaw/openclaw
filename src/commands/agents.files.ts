// The Gateway owns agent workspace documents and their bootstrap-file policy; these
// commands only forward the two read RPCs and format whatever the Gateway returns.
import type {
  AgentsFileEntry,
  AgentsFilesGetResult,
  AgentsFilesListResult,
} from "../../packages/gateway-protocol/src/schema/agents-files.js";
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

export type AgentsFilesOptions = {
  agent?: string;
  json?: boolean;
  timeout?: string;
  url?: string;
  port?: string;
  token?: string;
  password?: string;
};

export type AgentsFilesGetOptions = AgentsFilesOptions & { name: string };

function toRpcOptions(
  opts: AgentsFilesOptions,
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

async function resolveFilesAgentId(rawAgent: string | undefined): Promise<string> {
  if (rawAgent !== undefined) {
    // An explicit id is forwarded verbatim; the Gateway owns the configured-agent roster.
    return rawAgent;
  }
  const cfg = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
  return resolveAgentOperationAgentId(cfg, undefined, {
    surface: "the agents files command",
    hint: "Pass --agent <id>.",
  });
}

function describeFileState(file: AgentsFileEntry): string {
  if (!file.missing) {
    return "ok";
  }
  return file.expectedAbsent === true ? "optional" : "missing";
}

export function renderAgentsFiles(result: AgentsFilesListResult): string {
  return renderTerminalSafeTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Name", header: "Name", minWidth: 12, flex: true },
      { key: "State", header: "State", minWidth: 8 },
      { key: "Size", header: "Size", minWidth: 8, align: "right" },
      { key: "Updated", header: "Updated", minWidth: 20 },
    ],
    rows: result.files.map((file) => ({
      Name: file.name,
      State: describeFileState(file),
      Size: file.size !== undefined ? String(file.size) : "",
      Updated: file.updatedAtMs !== undefined ? new Date(file.updatedAtMs).toISOString() : "",
    })),
  }).trimEnd();
}

function writeDocumentBytes(content: string): void {
  // The document body is the command's payload, so write the exact bytes. The
  // shared runtime stdout writer terminates its value with a newline when one is
  // missing; that would turn a five-byte document into six bytes, make an empty
  // document one newline, and break `> file` redirection plus the size/hash the
  // Gateway reported for the same read.
  process.stdout.write(content);
}

function reportReadFailure(
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
    runtime.error(`${subject} read failed: ${sanitizeTerminalText(message)}`);
  }
  runtime.exit(1);
}

export async function agentsFilesListCommand(
  opts: AgentsFilesOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  let result: AgentsFilesListResult;
  try {
    result = await callGatewayFromCliWithTransport<AgentsFilesListResult>(
      "agents.files.list",
      toRpcOptions(opts),
      { agentId: await resolveFilesAgentId(opts.agent) },
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    reportReadFailure(err, opts, runtime, "Agent files");
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(`${theme.heading("Agent files")} ${theme.muted(`· ${result.agentId}`)}`);
  runtime.log(theme.muted(`workspace: ${result.workspace}`));
  runtime.log(renderAgentsFiles(result));
}

export async function agentsFilesGetCommand(
  opts: AgentsFilesGetOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  let result: AgentsFilesGetResult;
  try {
    result = await callGatewayFromCliWithTransport<AgentsFilesGetResult>(
      "agents.files.get",
      toRpcOptions(opts),
      { agentId: await resolveFilesAgentId(opts.agent), name: opts.name },
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    reportReadFailure(err, opts, runtime, "Agent file");
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  const file = result.file;
  if (file.missing) {
    const state = file.expectedAbsent === true ? "optional and not present" : "missing";
    runtime.error(
      `Agent file ${sanitizeTerminalText(file.name)} is ${state} in ${sanitizeTerminalText(
        result.workspace,
      )}.`,
    );
    return;
  }
  if (file.content === undefined) {
    // The schema makes content optional; never synthesize document bytes.
    runtime.error(`Agent file ${sanitizeTerminalText(file.name)} returned no content.`);
    return;
  }
  writeDocumentBytes(file.content);
  const size = file.size !== undefined ? `, ${file.size} bytes` : "";
  const hash = file.hash !== undefined ? `, sha256 ${file.hash}` : "";
  runtime.error(`Agent file ${sanitizeTerminalText(file.name)}${size}${hash}`);
}
