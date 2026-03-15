import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";

describe("resolveGatewayTokenForDriftCheck", () => {
  it("prefers persisted config token over shell env", () => {
    const token = resolveGatewayTokenForDriftCheck({
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(token).toBe("config-token");
  });

  it("skips drift comparison when config token SecretRef is unavailable", () => {
    const token = resolveGatewayTokenForDriftCheck({
      cfg: {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
    });

    expect(token).toBeUndefined();
  });

  it("does not fall back to gateway.remote token when local drift check token is unavailable", () => {
    const token = resolveGatewayTokenForDriftCheck({
      cfg: {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
          },
          remote: {
            token: "remote-token",
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(token).toBeUndefined();
  });
});
