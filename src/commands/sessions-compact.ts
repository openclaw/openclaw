/**
 * Sessions compact command.
 *
 * Wraps the `sessions.compact` Gateway RPC behind `openclaw sessions compact <key>`
 * so wedged sessions have a documented, first-class recovery path. The command
 * propagates a non-zero exit whenever the gateway reports a failed compaction
 * (transport error or an `ok:false` payload) so automation never mistakes a
 * silent no-op for success.
 */
import { callGatewayCli, type GatewayRpcOpts } from "../cli/gateway-cli/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type SessionsCompactCliOptions = {
  key: string;
  agent?: string;
  maxLines?: number;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsCompactResult = {
  ok?: boolean;
  key?: string;
  compacted?: boolean;
  reason?: string;
  kept?: number;
  archived?: string;
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
    sessionId?: string;
    sessionFile?: string;
  };
};

function describeCompaction(result: SessionsCompactResult, fallbackKey: string): string {
  const sessionKey = result.key ?? fallbackKey;
  if (!result.compacted) {
    const reason = result.reason ? ` (${result.reason})` : "";
    return `No compaction needed for session ${sessionKey}${reason}.`;
  }
  const before = result.result?.tokensBefore;
  const after = result.result?.tokensAfter;
  let detail = "";
  if (typeof before === "number" && typeof after === "number") {
    detail = ` (${before} → ${after} tokens)`;
  } else if (typeof result.kept === "number") {
    detail = ` (kept ${result.kept} lines)`;
  }
  return `Compacted session ${sessionKey}${detail}.`;
}

/** Run `openclaw sessions compact <key>` against the running gateway. */
export async function sessionsCompactCommand(
  opts: SessionsCompactCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const rpcOpts: GatewayRpcOpts = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout,
    json: opts.json,
  };
  const params = {
    key: opts.key,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
  };

  let result: SessionsCompactResult;
  try {
    result = (await callGatewayCli("sessions.compact", rpcOpts, params)) as SessionsCompactResult;
  } catch (err) {
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ok: false, key: opts.key, error: message });
    } else {
      runtime.error(`Compaction failed: ${message}`);
    }
    runtime.exit(1);
    return;
  }

  // An explicit ok:false means the gateway accepted the request but the
  // compaction itself did not complete (for example an interrupted summarize
  // run). Surface it as a failure instead of letting the process exit 0.
  const failed = result?.ok === false;

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    if (failed) {
      runtime.exit(1);
    }
    return;
  }

  if (failed) {
    const sessionKey = result?.key ?? opts.key;
    const reason = result?.reason ? `: ${result.reason}` : "";
    runtime.error(`Compaction failed for session ${sessionKey}${reason}.`);
    runtime.exit(1);
    return;
  }

  runtime.log(describeCompaction(result ?? {}, opts.key));
  if (result?.archived) {
    runtime.log(`Archived transcript: ${result.archived}`);
  }
}
