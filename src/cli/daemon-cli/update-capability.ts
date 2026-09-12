import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";

export function writeGatewayServiceUpdateCapability(): void {
  process.stdout.write(
    JSON.stringify({ updateExecutor: GATEWAY_UPDATE_EXECUTOR_CONTRACT, targetRootBinding: true }),
  );
}

/** The updater's machine probe must return before capture or config can open live state. */
export function tryRunGatewayServiceUpdateCapabilityProbe(argv: string[]): boolean {
  const [primary, action, ...options] = argv.slice(2);
  if (
    (primary !== "gateway" && primary !== "daemon") ||
    (action !== "install" && action !== "restart" && action !== "stop")
  ) {
    return false;
  }
  const probe = options.filter((option) => option !== "--json");
  if (
    !(
      (probe.length === 2 && probe[0] === "--update-executor" && probe[1] === "check") ||
      (probe.length === 1 && probe[0] === "--update-executor=check")
    )
  ) {
    return false;
  }
  writeGatewayServiceUpdateCapability();
  return true;
}
