import { finished } from "node:stream/promises";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";

export async function writeGatewayServiceUpdateCapability(): Promise<void> {
  process.stdout.write(
    JSON.stringify({
      updateExecutor: GATEWAY_UPDATE_EXECUTOR_CONTRACT,
      targetRootBinding: true,
      definitionBackup: true,
    }),
  );
  // The parent closes stdin only after binding this child's PID and start identity.
  await finished(process.stdin.resume(), { cleanup: true });
}

/** The updater's machine probe must return before capture or config can open live state. */
export async function tryRunGatewayServiceUpdateCapabilityProbe(argv: string[]): Promise<boolean> {
  const [primary, action, ...options] = argv.slice(2);
  if (
    (primary !== "gateway" && primary !== "daemon") ||
    (action !== "install" && action !== "restart" && action !== "stop")
  ) {
    return false;
  }
  // A JSON flag between the executor option and its mode is an invalid value.
  const probe = options.slice(
    options[0] === "--json" ? 1 : 0,
    options.at(-1) === "--json" ? -1 : undefined,
  );
  if (
    !(
      (probe.length === 2 && probe[0] === "--update-executor" && probe[1] === "check") ||
      (probe.length === 1 && probe[0] === "--update-executor=check")
    )
  ) {
    return false;
  }
  await writeGatewayServiceUpdateCapability();
  return true;
}
