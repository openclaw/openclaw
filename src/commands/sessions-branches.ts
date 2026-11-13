// List the transcript DAG tips (rewind/switch branch points) for one session
// through the canonical `sessions.branches.list` gateway RPC. A failed call must
// exit nonzero so automation cannot mistake a silent no-op for an empty list.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionBranchRow = {
  leafEntryId?: string;
  headline?: string;
  messageCount?: number;
  updatedAt?: string;
  active?: boolean;
};

type SessionsBranchesResult = {
  branches?: SessionBranchRow[];
};

function describeBranchRow(branch: SessionBranchRow): string {
  const leafEntryId = sanitizeTerminalText(branch.leafEntryId ?? "");
  const marker = branch.active === true ? "*" : " ";
  const messageCount = typeof branch.messageCount === "number" ? branch.messageCount : 0;
  const headline = sanitizeTerminalText(branch.headline?.trim() || "");
  const suffix = headline ? ` — ${headline}` : "";
  return `${marker} ${leafEntryId} (${messageCount} message${messageCount === 1 ? "" : "s"})${suffix}`;
}

export async function sessionsBranchesCommand(
  opts: {
    key: string;
    agent?: string;
    timeout?: string;
    url?: string;
    token?: string;
    password?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<void> {
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
    sessionKey: opts.key,
    ...(agent ? { agentId: agent } : {}),
  };

  let result: SessionsBranchesResult;
  try {
    result = await callGatewayFromCliWithTransport<SessionsBranchesResult>(
      "sessions.branches.list",
      rpcOpts,
      params,
      { defaultTimeoutMs: 30_000 },
    );
  } catch (error) {
    rethrowExpectedCliError(error);
    const message = formatErrorMessage(error);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...formatCliJsonFailure(message), key: opts.key });
    } else {
      runtime.error(`Failed to list branches: ${sanitizeTerminalText(message)}`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }

  const branches = result.branches ?? [];
  if (branches.length === 0) {
    runtime.log(`No branches found for session ${sanitizeTerminalText(opts.key)}.`);
    return;
  }
  for (const branch of branches) {
    runtime.log(describeBranchRow(branch));
  }
}
