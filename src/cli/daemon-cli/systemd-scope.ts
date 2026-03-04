import type { GatewayServiceEnv } from "../../daemon/service-types.js";
import { withSystemdSystemScopeEnv } from "../../daemon/systemd-scope.js";

export function resolveDaemonServiceEnv(params: {
  system?: boolean;
  env?: GatewayServiceEnv;
}): GatewayServiceEnv {
  const env = params.env ?? (process.env as GatewayServiceEnv);
  return withSystemdSystemScopeEnv(env, { system: params.system });
}
