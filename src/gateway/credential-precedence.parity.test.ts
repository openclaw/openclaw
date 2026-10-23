import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuthResolution } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

type Credentials = { token?: string; password?: string };

type TestCase = {
  name: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expected: { call: Credentials; probe: Credentials; status: Credentials; auth: Credentials };
};

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token", // pragma: allowlist secret
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
};
const localCredentials = { token: "local-token", password: "local-password" }; // pragma: allowlist secret
const configuredCredentials = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const remoteCredentials = { token: "remote-token", password: "env-password" }; // pragma: allowlist secret
function localConfig(): OpenClawConfig {
  return { gateway: { mode: "local", auth: { ...configuredCredentials } } };
}
const localExpected = {
  call: configuredCredentials,
  probe: configuredCredentials,
  status: configuredCredentials,
  auth: configuredCredentials,
};

function makeRemoteGatewayConfig(remote: { token?: string; password?: string }): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote,
      auth: { ...localCredentials },
    },
  };
}

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
  const cases: TestCase[] = [
    {
      name: "local mode keeps configured auth aligned across client and server surfaces",
      cfg: localConfig(),
      env: gatewayEnv,
      expected: localExpected,
    },
    {
      name: "remote mode with remote token configured",
      cfg: makeRemoteGatewayConfig({
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: remoteCredentials,
        probe: remoteCredentials,
        status: localCredentials,
        auth: localCredentials,
      },
    },
    {
      name: "remote mode without remote token keeps remote probe/status strict",
      cfg: makeRemoteGatewayConfig({
        password: "remote-password", // pragma: allowlist secret
      }),
      env: gatewayEnv,
      expected: {
        call: { token: "env-token", password: "env-password" }, // pragma: allowlist secret
        probe: { token: undefined, password: "env-password" }, // pragma: allowlist secret
        status: localCredentials,
        auth: localCredentials,
      },
    },
    {
      name: "gateway service runtime uses the same local credential policy",
      cfg: localConfig(),
      env: { ...gatewayEnv, OPENCLAW_SERVICE_KIND: "gateway" },
      expected: localExpected,
    },
  ];

  it.each(cases)("$name", async ({ cfg, env, expected }) => {
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    const call = resolveGatewayCredentialsFromConfig({ cfg, env });
    const probe = resolveGatewayProbeAuth({ cfg, mode, env });
    const status = (await withGatewayAuthEnv(env, () => resolveGatewayProbeAuthResolution(cfg)))
      .auth;
    const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env });

    expect(call).toEqual(expected.call);
    expect(probe).toEqual(expected.probe);
    expect(status).toEqual(expected.status);
    expect({ token: auth.token, password: auth.password }).toEqual(expected.auth);
  });
});
