import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { validateDevicePairClearResult } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { failDevicesCommand } from "./devices-cli-errors.js";
import { callGatewayFromCliWithTransport, type GatewayRpcOpts } from "./gateway-rpc.js";

export async function runDevicesClearCommand(
  opts: GatewayRpcOpts & { yes?: boolean; pending?: boolean },
): Promise<void> {
  if (!opts.yes) {
    failDevicesCommand(opts.json, "Refusing to clear pairing table without --yes");
    return;
  }
  let result: unknown;
  try {
    result = await callGatewayFromCliWithTransport(
      "device.pair.clear",
      opts,
      { pending: Boolean(opts.pending) },
      {
        label: "Devices device.pair.clear",
        defaultTimeoutMs: 10_000,
        sharedStateMode: "read-only",
      },
    );
  } catch (error) {
    if (
      error instanceof GatewayClientRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message === "unknown method: device.pair.clear"
    ) {
      failDevicesCommand(
        opts.json,
        "This Gateway does not support atomic device clearing (device.pair.clear). Update the Gateway, then retry. No pairing records were changed.",
      );
      return;
    }
    throw error;
  }
  if (!validateDevicePairClearResult(result)) {
    throw new Error("Gateway returned an invalid device clear result.");
  }
  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else {
    defaultRuntime.log(
      `${theme.warn("Cleared")} ${result.removedDevices.length} paired device${result.removedDevices.length === 1 ? "" : "s"}`,
    );
    if (opts.pending) {
      defaultRuntime.log(
        `${theme.warn("Rejected")} ${result.rejectedPending.length} pending request${result.rejectedPending.length === 1 ? "" : "s"}`,
      );
    }
    if (result.cleanupFailedDevices?.length) {
      defaultRuntime.error(
        `Pairing records were cleared, but worker cleanup failed for: ${result.cleanupFailedDevices.map(sanitizeForLog).join(", ")}. Check Gateway logs.`,
      );
    }
  }
  if (result.cleanupFailedDevices?.length) {
    defaultRuntime.exit(1);
  }
}
