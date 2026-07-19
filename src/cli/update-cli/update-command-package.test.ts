import { describe, expect, it } from "vitest";
import { validateGatewayStartupVerifyProof } from "./update-command-package.js";

describe("validateGatewayStartupVerifyProof", () => {
  it("accepts the current gateway verification contract", () => {
    expect(
      validateGatewayStartupVerifyProof(
        JSON.stringify({
          ok: true,
          protocol: "openclaw.gateway.verify",
          protocolVersion: 1,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [null, "gateway startup verify returned no machine proof"],
    ["not-json", "gateway startup verify returned invalid JSON"],
    [
      JSON.stringify({ ok: true, protocol: "openclaw.gateway.verify", protocolVersion: 2 }),
      "gateway startup verify returned an incompatible machine proof",
    ],
    [
      JSON.stringify({ ok: false, protocol: "openclaw.gateway.verify", protocolVersion: 1 }),
      "gateway startup verify returned an incompatible machine proof",
    ],
  ])("rejects %j", (stdout, expected) => {
    expect(validateGatewayStartupVerifyProof(stdout)).toBe(expected);
  });
});
