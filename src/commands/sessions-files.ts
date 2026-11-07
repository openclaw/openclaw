// The Gateway owns the session workspace file inventory; this command only lists
// and reads it, like the other gateway-backed session verbs.
import type {
  SessionsFilesGetResult,
  SessionsFilesListResult,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type SessionsFilesOptions = {
  sessionKey: string;
  path?: string;
  search?: string;
  agent?: string;
  get?: boolean;
  output?: string;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionFileEntry = SessionsFilesListResult["files"][number];

function describeSize(entry: SessionFileEntry): string {
  if (entry.size === undefined) {
    return entry.missing ? "missing" : "—";
  }
  if (entry.size < 1024) {
    return `${entry.size}B`;
  }
  if (entry.size < 1024 * 1024) {
    return `${(entry.size / 1024).toFixed(1)}KB`;
  }
  return `${(entry.size / (1024 * 1024)).toFixed(1)}MB`;
}

export function renderSessionsFiles(result: SessionsFilesListResult): string {
  const files = result.files ?? [];
  const browserEntries = result.browser?.entries ?? [];
  const lines: string[] = [
    `${theme.heading("Session files")} ${theme.muted(`${result.sessionKey}${result.root ? ` · ${sanitizeTerminalText(result.root)}` : ""}`)}`,
  ];
  if (files.length === 0 && browserEntries.length === 0) {
    lines.push("No files in this session workspace.");
    return lines.join("\n");
  }
  lines.push(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Name", header: "Name", minWidth: 18, flex: true },
        { key: "Kind", header: "Kind", minWidth: 8 },
        { key: "Size", header: "Size", minWidth: 8 },
        { key: "Updated", header: "Updated", minWidth: 20 },
      ],
      rows: [
        ...browserEntries.map((entry) => ({
          Name: sanitizeTerminalText(entry.path),
          Kind: entry.kind,
          Size: "—",
          Updated: "—",
        })),
        ...files.map((entry) => ({
          Name: sanitizeTerminalText(entry.path).slice(0, 80),
          Kind: entry.kind,
          Size: describeSize(entry),
          Updated:
            entry.updatedAtMs !== undefined ? new Date(entry.updatedAtMs).toISOString() : "—",
        })),
      ],
    }).trimEnd(),
  );
  return lines.join("\n");
}

export async function sessionsFilesCommand(
  opts: SessionsFilesOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const sessionKey = opts.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("Session key must not be blank.");
  }
  const path = opts.path?.trim() || undefined;
  if (opts.path !== undefined && !path) {
    throw new Error("Path must not be blank.");
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
  const method = opts.get ? "sessions.files.get" : "sessions.files.list";

  let result: SessionsFilesListResult | SessionsFilesGetResult;
  try {
    result = await callGatewayFromCliWithTransport<
      SessionsFilesListResult | SessionsFilesGetResult
    >(
      method,
      rpcOpts,
      {
        sessionKey,
        ...(agent ? { agentId: agent } : {}),
        ...(opts.get
          ? { path: path ?? "" }
          : {
              ...(path ? { path } : {}),
              ...(opts.search?.trim() ? { search: opts.search.trim() } : {}),
            }),
      },
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), sessionKey });
    } else {
      runtime.error(`Session files read failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  if (opts.get) {
    const file = (result as SessionsFilesGetResult).file;
    const content = file?.content ?? "";
    if (opts.output) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(opts.output, content, "utf8");
      runtime.log(`Wrote ${sanitizeTerminalText(opts.output)} (${content.length} chars).`);
      return;
    }
    runtime.log(content);
    return;
  }
  runtime.log(renderSessionsFiles(result as SessionsFilesListResult));
}
