// Thin CLI adapter for existing sessions.processes.* Gateway RPCs.
import type {
  SessionsProcessesListResult,
  SessionsProcessesStopResult,
} from "../../packages/gateway-protocol/src/schema/session-processes.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionsProcessesCliOptions = {
  key: string;
  agent?: string;
  timeout?: string;
  url?: string;
  port?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsProcessesStopCliOptions = SessionsProcessesCliOptions & {
  processId: string;
  sessionId: string;
  instanceId: string;
};

function rpcOpts(opts: SessionsProcessesCliOptions) {
  return {
    url: opts.url,
    port: opts.port,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout,
    json: opts.json,
  };
}

export async function sessionsProcessesListCommand(
  opts: SessionsProcessesCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    const result = await callGatewayFromCliWithTransport<SessionsProcessesListResult>(
      "sessions.processes.list",
      rpcOpts(opts),
      {
        key: opts.key,
        ...(opts.agent ? { agentId: opts.agent } : {}),
      },
      { defaultTimeoutMs: 30_000 },
    );
    writeRuntimeJson(runtime, result);
  } catch (err) {
    rethrowExpectedCliError(err);
    writeRuntimeJson(runtime, formatCliJsonFailure(formatErrorMessage(err)));
    runtime.exit(1);
  }
}

export async function sessionsProcessesStopCommand(
  opts: SessionsProcessesStopCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    const result = await callGatewayFromCliWithTransport<SessionsProcessesStopResult>(
      "sessions.processes.stop",
      rpcOpts(opts),
      {
        key: opts.key,
        processId: opts.processId,
        sessionId: opts.sessionId,
        instanceId: opts.instanceId,
        ...(opts.agent ? { agentId: opts.agent } : {}),
      },
      { defaultTimeoutMs: 30_000 },
    );
    writeRuntimeJson(runtime, result);
  } catch (err) {
    rethrowExpectedCliError(err);
    writeRuntimeJson(runtime, formatCliJsonFailure(formatErrorMessage(err)));
    runtime.exit(1);
  }
}
