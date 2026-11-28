// Thin CLI adapter for the existing backup.status Gateway RPC (no local ledger scan).
import type { BackupStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport, type GatewayRpcOpts } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

/** Preserve the full Gateway targeting surface advertised by addGatewayClientOptions. */
export type BackupStatusCliOptions = GatewayRpcOpts;

export async function backupStatusCommand(
  runtime: RuntimeEnv,
  opts: BackupStatusCliOptions,
): Promise<void> {
  try {
    const result = await callGatewayFromCliWithTransport<BackupStatusResult>(
      "backup.status",
      opts,
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
