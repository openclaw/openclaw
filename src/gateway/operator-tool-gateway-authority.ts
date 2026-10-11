import { AsyncLocalStorage } from "node:async_hooks";
import type { OperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.types.js";

const authority = new AsyncLocalStorage<OperatorToolGatewayAuthority>();

export function readOperatorToolGatewayAuthority(): OperatorToolGatewayAuthority | undefined {
  return authority.getStore();
}

export function runWithOperatorToolGatewayAuthority<T>(
  value: OperatorToolGatewayAuthority,
  run: () => T,
): T {
  return authority.run(value, run);
}

/** Accepted work and bounded cleanup no longer admit this request's input. */
export function runOutsideOperatorToolGatewayAuthority<T>(run: () => T): T {
  return authority.exit(run);
}
