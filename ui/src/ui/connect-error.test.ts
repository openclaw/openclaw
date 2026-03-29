import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import { formatConnectError } from "./connect-error.js";

describe("formatConnectError", () => {
  it("formats CONTROL_UI_DEVICE_IDENTITY_REQUIRED with secure-context guidance", () => {
    const text = formatConnectError({
      message: "connect failed",
      details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
    });
    expect(text).toContain("control ui requires device identity");
    expect(text).toContain("allowInsecureAuth applies only on localhost HTTP");
    expect(text).toContain("dangerouslyDisableDeviceAuth");
  });
});
