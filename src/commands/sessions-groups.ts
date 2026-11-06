// The Gateway owns the ordered session group catalog; this command only reads it,
// like the other gateway-backed session verbs.
import type { SessionsGroupsListResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type SessionsGroupsOptions = {
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

export function renderSessionsGroups(result: SessionsGroupsListResult): string {
  const groups = result.groups ?? [];
  if (groups.length === 0) {
    return "No session groups.";
  }
  return renderTable({
    width: getTerminalTableWidth(),
    columns: [
      { key: "Position", header: "Position", minWidth: 8 },
      { key: "Group", header: "Group", minWidth: 20, flex: true },
    ],
    rows: groups.map((group) => ({
      Position: String(group.position),
      Group: sanitizeTerminalText(group.name),
    })),
  }).trimEnd();
}

export async function sessionsGroupsCommand(
  opts: SessionsGroupsOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const rpcOpts: Parameters<typeof callGatewayFromCliWithTransport>[1] = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    json: opts.json,
  };

  let result: SessionsGroupsListResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionsGroupsListResult>(
      "sessions.groups.list",
      rpcOpts,
      {},
      { defaultTimeoutMs: 30_000 },
    );
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message) });
    } else {
      runtime.error(`Session groups read failed: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(
    `${theme.heading("Session groups")}${
      result.sectionOrder?.length
        ? ` ${theme.muted(`· sections: ${result.sectionOrder.join(", ")}`)}`
        : ""
    }`,
  );
  runtime.log(renderSessionsGroups(result));
}
