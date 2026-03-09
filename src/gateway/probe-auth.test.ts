import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayProbeAuthSafe } from "./probe-auth.js";

describe("resolveGatewayProbeAuthSafe", () => {
  it("returns probe auth credentials when available", () => {
    const result = resolveGatewayProbeAuthSafe({
      cfg: {
        gateway: {
          auth: {
            token: "token-value",
          },
        },
      } as OpenClawConfig,
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: "token-value",
        password: undefined,
      },
    });
  });

  it("returns warning and empty auth when token SecretRef is unresolved", () => {
    const result = resolveGatewayProbeAuthSafe({
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
      mode: "local",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.auth).toEqual({});
    expect(result.warning).toContain("gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });

  it("ignores unresolved local token SecretRef in remote mode when remote-only auth is requested", () => {
    const result = resolveGatewayProbeAuthSafe({
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
      mode: "remote",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      auth: {
        token: undefined,
        password: undefined,
      },
    });
  });
});
