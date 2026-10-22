import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuthResolution } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token", // pragma: allowlist secret
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
};
const configuredCredentials = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
describe("gateway credential precedence coverage", () => {
  it("keeps configured local auth aligned across client and server surfaces", async () => {
    const cfg: OpenClawConfig = { gateway: { mode: "local", auth: { ...configuredCredentials } } };
    const call = resolveGatewayCredentialsFromConfig({ cfg, env: gatewayEnv });
    const probe = resolveGatewayProbeAuth({ cfg, mode: "local", env: gatewayEnv });
    const status = (await resolveGatewayProbeAuthResolution(cfg, gatewayEnv)).auth;
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: gatewayEnv });

    expect({ call, probe, status, auth: { token: auth.token, password: auth.password } }).toEqual({
      call: configuredCredentials,
      probe: configuredCredentials,
      status: configuredCredentials,
      auth: configuredCredentials,
    });
  });
});
