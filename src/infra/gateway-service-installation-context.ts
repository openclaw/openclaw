import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GatewayServiceInstallation = {
  root: string;
  version: string;
  cliVersion: string;
  databasePath: string;
};

export type GatewayServiceInstallationContext = {
  installation?: GatewayServiceInstallation;
};

const installations = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayServiceInstallation"),
  () => new AsyncLocalStorage<GatewayServiceInstallationContext>(),
);

/** A CLI invocation and its SQLite workers share observed service facts, never write authority. */
export function withGatewayServiceInstallation<T>(
  context: GatewayServiceInstallationContext,
  run: () => T,
): T {
  return installations.run(context, run);
}

export function getGatewayServiceInstallation(): GatewayServiceInstallation | undefined {
  return installations.getStore()?.installation;
}
