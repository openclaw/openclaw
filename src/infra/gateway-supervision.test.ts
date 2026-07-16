import { describe, expect, it } from "vitest";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";

const GATEWAY_SUPERVISOR_MODE_ENV = "OPENCLAW_SUPERVISOR_MODE";

describe("gateway supervision", () => {
  it.each([
    { value: undefined, externallySupervised: false },
    { value: "", externallySupervised: false },
    { value: "auto", externallySupervised: false },
    { value: "invalid", externallySupervised: false },
    { value: " EXTERNAL ", externallySupervised: true },
  ])(
    "resolves $value as externally supervised=$externallySupervised",
    ({ value, externallySupervised }) => {
      const env = { [GATEWAY_SUPERVISOR_MODE_ENV]: value };

      expect(isGatewayExternallySupervised(env)).toBe(externallySupervised);
    },
  );

  it("blocks native service mutation with actionable guidance", () => {
    expect(() =>
      assertGatewayServiceMutationAllowed("restart the gateway", {
        [GATEWAY_SUPERVISOR_MODE_ENV]: "external",
      }),
    ).toThrow(
      "OpenClaw gateway lifecycle is managed by an external supervisor " +
        "(OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to restart the gateway.",
    );
  });

  it("explains why self-update must be delegated", () => {
    expect(formatExternalSupervisorUpdateRequired()).toContain(
      "stop the gateway, update and finalize the runtime, then restart it safely",
    );
  });
});
