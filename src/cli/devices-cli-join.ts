import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export async function runDevicesJoinCodeCommand(opts: GatewayRpcOpts): Promise<void> {
  const result = await callGatewayFromCliWithTransport<{ joinUrl?: unknown }>(
    "device.pair.setupCode",
    opts,
    { bootstrapProfile: "node", includeQr: false, joinUrl: true },
    {
      label: "Devices device.pair.setupCode",
      defaultTimeoutMs: 10_000,
      scopes: [ADMIN_SCOPE],
      sharedStateMode: "read-only",
    },
  );
  const joinUrl = normalizeOptionalString(result.joinUrl);
  if (!joinUrl) {
    throw new Error("Gateway did not return a device join URL.");
  }
  const serviceCommand = `npx -y openclaw connect ${quoteCliArg(joinUrl)} --service`;
  const command = `${serviceCommand} --session-host`;
  if (opts.json) {
    defaultRuntime.writeJson({ joinUrl, command });
    return;
  }
  defaultRuntime.log(joinUrl);
  defaultRuntime.log(command);
  defaultRuntime.log("Installs a background node service that can run agent sessions.");
  defaultRuntime.log(`Command-only node: ${serviceCommand}`);
}
