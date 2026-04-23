import { isContainerEnvironment } from "../gateway/net.js";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";

export type GatewayBindClassificationInput = {
  bind: string | undefined;
  customBindHost: string | undefined;
};

/**
 * Returns true when a gateway bind configuration resolves to a loopback-only
 * listener at runtime.
 *
 * Covers:
 * - `bind="loopback"` - always loopback.
 * - `bind="custom"` with a canonical IPv4 loopback `customBindHost` - the
 *   config validator also treats this shape as loopback-equivalent (see
 *   validateGatewayTailscaleBind in `src/config/validation.ts`).
 * - `bind="auto"` on non-container hosts - `resolveGatewayBindHost` resolves
 *   `auto` to `127.0.0.1` on bare-metal / VM hosts and to `0.0.0.0` inside
 *   containers (see `src/gateway/net.ts`).
 *
 * Everything else (`lan`, `tailnet`, `custom` with a non-loopback host,
 * `auto` in a container, unknown strings) is NOT loopback-equivalent.
 *
 * Used by the security audit to classify findings that behave differently on
 * loopback-equivalent binds (noise vs real warning). Keep this helper in
 * lockstep with `validateGatewayTailscaleBind` and the runtime resolver.
 */
export function isLoopbackEquivalentBind(input: GatewayBindClassificationInput): boolean {
  const { bind, customBindHost } = input;
  if (bind === "loopback") {
    return true;
  }
  if (
    bind === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return true;
  }
  if (bind === "auto" && !isContainerEnvironment()) {
    return true;
  }
  return false;
}
