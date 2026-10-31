// Thin CLI adapter for existing cold-transcript Gateway RPCs (no local SQLite scan).
import type { SessionsStorageStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type SessionsStorageOperation = "status" | "run";

type SessionsStorageCliOptions = {
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsStorageRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

const STORAGE_METHODS = {
  status: "sessions.storage.status",
  run: "sessions.storage.run",
} as const satisfies Record<SessionsStorageOperation, string>;

export async function sessionsStorageCommand(
  operation: SessionsStorageOperation,
  opts: SessionsStorageCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const method = STORAGE_METHODS[operation];
  const rpcOpts: SessionsStorageRpcOpts = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    timeout: opts.timeout,
    json: opts.json,
  };

  try {
    const result = await callGatewayFromCliWithTransport<SessionsStorageStatusResult>(
      method,
      rpcOpts,
      {},
      { defaultTimeoutMs: 30_000 },
    );
    writeRuntimeJson(runtime, result);
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    writeRuntimeJson(runtime, formatCliJsonFailure(message));
    runtime.exit(1);
  }
}
