// Thin CLI adapter for the existing presence.query Gateway RPC.
import type { PresenceQueryResult } from "../../packages/gateway-protocol/src/schema/presence.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import {
  callGatewayFromCliWithTransport,
  type GatewayRpcOpts,
} from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

/** Preserve the full Gateway targeting surface advertised by addGatewayClientOptions. */
export type PresenceQueryCliOptions = GatewayRpcOpts & {
  action?: "list" | "person" | "device";
  person?: string;
  deviceId?: string;
  include?: Array<"devices" | "network" | "location">;
  limit?: number;
};

export async function presenceQueryCommand(
  runtime: RuntimeEnv,
  opts: PresenceQueryCliOptions,
): Promise<void> {
  try {
    const params: Record<string, unknown> = {};
    if (opts.action) {
      params.action = opts.action;
    }
    if (opts.person !== undefined) {
      params.person = opts.person;
    }
    if (opts.deviceId !== undefined) {
      params.deviceId = opts.deviceId;
    }
    if (opts.include?.length) {
      params.include = opts.include;
    }
    if (opts.limit !== undefined) {
      params.limit = opts.limit;
    }
    const result = await callGatewayFromCliWithTransport<PresenceQueryResult>(
      "presence.query",
      opts,
      params,
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
