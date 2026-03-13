import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthWithSecretInputs,
} from "./probe-auth.js";

describe("resolveGatewayProbeAuthSafe", () => {
  it.each([
    {
      name: "returns probe auth credentials when available",
      cfg: {
        gateway: {
          auth: {
            token: "token-value",
          },
        },
      } as OpenClawConfig,
      mode: "local" as const,
      env: {} as NodeJS.ProcessEnv,
      expected: {
        auth: {
          token: "token-value",
          password: undefined,
        },
      },
    },
    {
      name: "returns warning and empty auth when a local token SecretRef is unresolved",
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local" as const,
      env: {} as NodeJS.ProcessEnv,
      expected: {
        auth: {},
        warningIncludes: ["gateway.auth.token", "unresolved"],
      },
    },
    {
      name: "does not fall through to remote token when the local SecretRef is unresolved",
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
          },
          remote: {
            token: "remote-token",
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local" as const,
      env: {} as NodeJS.ProcessEnv,
      expected: {
        auth: {},
        warningIncludes: ["gateway.auth.token", "unresolved"],
      },
    },
    {
      name: "ignores unresolved local token SecretRefs in remote mode",
      cfg: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
          },
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "remote" as const,
      env: {} as NodeJS.ProcessEnv,
      expected: {
        auth: {
          token: undefined,
          password: undefined,
        },
      },
    },
  ])("$name", ({ cfg, mode, env, expected }) => {
    const result = resolveGatewayProbeAuthSafe({ cfg, mode, env });

    expect(result.auth).toEqual(expected.auth);
    for (const fragment of expected.warningIncludes ?? []) {
      expect(result.warning).toContain(fragment);
    }
  });
});

describe("resolveGatewayProbeAuthWithSecretInputs", () => {
  it("resolves local probe SecretRef values before shared credential selection", async () => {
    const auth = await resolveGatewayProbeAuthWithSecretInputs({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "DAEMON_GATEWAY_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {
        DAEMON_GATEWAY_TOKEN: "resolved-daemon-token",
      } as NodeJS.ProcessEnv,
    });

    expect(auth).toEqual({
      token: "resolved-daemon-token",
      password: undefined,
    });
  });
});
