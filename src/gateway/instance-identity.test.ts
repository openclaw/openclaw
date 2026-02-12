import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_GATEWAY_IDENTITY_KIND,
  GATEWAY_IDENTITY_MODE_ENV,
  resolveGatewayInstanceIdentity,
} from "./instance-identity.js";

describe("gateway instance identity", () => {
  it("defaults to auto mode with the build default identity", () => {
    const identity = resolveGatewayInstanceIdentity({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(identity).toEqual({
      kind: DEFAULT_GATEWAY_IDENTITY_KIND,
      mode: "auto",
      source: "default",
    });
  });

  it("applies config override", () => {
    const identity = resolveGatewayInstanceIdentity({
      cfg: {
        gateway: {
          identity: {
            mode: "upstream",
          },
        },
      } as OpenClawConfig,
      env: {},
    });

    expect(identity).toEqual({
      kind: "upstream",
      mode: "upstream",
      source: "config",
    });
  });

  it("lets env override config", () => {
    const identity = resolveGatewayInstanceIdentity({
      cfg: {
        gateway: {
          identity: {
            mode: "fork",
          },
        },
      } as OpenClawConfig,
      env: {
        [GATEWAY_IDENTITY_MODE_ENV]: "upstream",
      },
    });

    expect(identity).toEqual({
      kind: "upstream",
      mode: "upstream",
      source: "env",
    });
  });

  it("ignores invalid env values", () => {
    const identity = resolveGatewayInstanceIdentity({
      cfg: {
        gateway: {
          identity: {
            mode: "fork",
          },
        },
      } as OpenClawConfig,
      env: {
        [GATEWAY_IDENTITY_MODE_ENV]: "invalid",
      },
    });

    expect(identity).toEqual({
      kind: "fork",
      mode: "fork",
      source: "config",
    });
  });
});
