import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuthResolution } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token", // pragma: allowlist secret
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
};
const localCredentials = { token: "local-token", password: "local-password" }; // pragma: allowlist secret
const configuredCredentials = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const remoteCredentials = { token: "remote-token", password: "env-password" }; // pragma: allowlist secret
function withGatewayAuthEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  return withEnv(
    {
      OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
      OPENCLAW_GATEWAY_PASSWORD: env.OPENCLAW_GATEWAY_PASSWORD,
      OPENCLAW_SERVICE_KIND: env.OPENCLAW_SERVICE_KIND,
    },
    fn,
  );
}

describe("gateway credential precedence coverage", () => {
  it.each([
    {
      name: "local mode keeps configured auth aligned across client and server surfaces",
    },
    {
      name: "remote mode with remote token configured",
      remote: { token: "remote-token", password: "remote-password" }, // pragma: allowlist secret
      expectedCall: remoteCredentials,
      expectedProbe: remoteCredentials,
    },
    {
      name: "remote mode without remote token keeps remote probe/status strict",
      remote: { password: "remote-password" }, // pragma: allowlist secret
      expectedCall: { token: "env-token", password: "env-password" }, // pragma: allowlist secret
      expectedProbe: { token: undefined, password: "env-password" }, // pragma: allowlist secret
    },
    {
      name: "gateway service runtime uses the same local credential policy",
      service: "gateway",
    },
  ])("$name", async ({ remote, service, expectedCall, expectedProbe }) => {
    const mode = remote ? "remote" : "local";
    const credentials = remote ? localCredentials : configuredCredentials;
    const cfg: OpenClawConfig = { gateway: { mode, remote, auth: { ...credentials } } };
    const env = { ...gatewayEnv, OPENCLAW_SERVICE_KIND: service };
    const call = resolveGatewayCredentialsFromConfig({ cfg, env });
    const probe = resolveGatewayProbeAuth({ cfg, mode, env });
    const status = (await withGatewayAuthEnv(env, () => resolveGatewayProbeAuthResolution(cfg)))
      .auth;
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env });

    expect({ call, probe, status, auth: { token: auth.token, password: auth.password } }).toEqual({
      call: expectedCall ?? configuredCredentials,
      probe: expectedProbe ?? configuredCredentials,
      status: credentials,
      auth: credentials,
    });
  });
});
