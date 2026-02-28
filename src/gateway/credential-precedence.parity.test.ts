import { describe, expect, it } from "vitest";
import { resolveGatewayProbeAuth as resolveStatusGatewayProbeAuth } from "../commands/status.gateway-probe.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

type ExpectedCredentialSet = {
  call: { token?: string; password?: string };
  probe: { token?: string; password?: string };
  status: { token?: string; password?: string };
  auth: { token?: string; password?: string };
};

type TestCase = {
  name: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  expected: ExpectedCredentialSet;
};

const gatewayEnv = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password",
} as NodeJS.ProcessEnv;

function makeRemoteGatewayConfig(remote: { token?: string; password?: string }): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote,
      auth: {
        token: "local-token",
        password: "local-password",
      },
    },
  } as OpenClawConfig;
}

function withGatewayAuthEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const keys = [
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "CLAWDBOT_GATEWAY_TOKEN",
    "CLAWDBOT_GATEWAY_PASSWORD",
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const nextValue = env[key];
    if (typeof nextValue === "string") {
      process.env[key] = nextValue;
    } else {
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

describe("gateway credential precedence parity", () => {
  const cases: TestCase[] = [
    {
      name: "local mode: env overrides config for call/probe/status, auth remains config-first",
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password",
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
      expected: {
        call: { token: "env-token", password: "env-password" },
        probe: { token: "env-token", password: "env-password" },
        status: { token: "env-token", password: "env-password" },
        auth: { token: "config-token", password: "config-password" },
      },
    },
    {
      name: "remote mode with remote token configured",
      cfg: makeRemoteGatewayConfig({
        token: "remote-token",
        password: "remote-password",
      }),
      env: gatewayEnv,
      expected: {
        call: { token: "remote-token", password: "env-password" },
        probe: { token: "remote-token", password: "env-password" },
        status: { token: "remote-token", password: "env-password" },
        auth: { token: "local-token", password: "local-password" },
      },
    },
    {
      name: "remote mode without remote token keeps remote probe/status strict",
      cfg: makeRemoteGatewayConfig({
        password: "remote-password",
      }),
      env: gatewayEnv,
      expected: {
        call: { token: "env-token", password: "env-password" },
        probe: { token: undefined, password: "env-password" },
        status: { token: undefined, password: "env-password" },
        auth: { token: "local-token", password: "local-password" },
      },
    },
    {
      name: "legacy env vars are ignored by probe/status/auth but still supported for call path",
      cfg: {
        gateway: {
          mode: "local",
          auth: {},
        },
      } as OpenClawConfig,
      env: {
        CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
        CLAWDBOT_GATEWAY_PASSWORD: "legacy-password",
      } as NodeJS.ProcessEnv,
      expected: {
        call: { token: "legacy-token", password: "legacy-password" },
        probe: { token: undefined, password: undefined },
        status: { token: undefined, password: undefined },
        auth: { token: undefined, password: undefined },
      },
    },
  ];

  it.each(cases)("$name", ({ cfg, env, expected }) => {
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    const call = resolveGatewayCredentialsFromConfig({
      cfg,
      env,
    });
    const probe = resolveGatewayProbeAuth({
      cfg,
      mode,
      env,
    });
    const status = withGatewayAuthEnv(env, () => resolveStatusGatewayProbeAuth(cfg));
    const auth = resolveGatewayAuth({
      authConfig: cfg.gateway?.auth,
      env,
    });

    expect(call).toEqual(expected.call);
    expect(probe).toEqual(expected.probe);
    expect(status).toEqual(expected.status);
    expect({ token: auth.token, password: auth.password }).toEqual(expected.auth);
  });
});
