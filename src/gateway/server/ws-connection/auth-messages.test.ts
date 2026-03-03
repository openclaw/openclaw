import { describe, expect, it } from "vitest";
import { formatControlUiDeviceIdentityRequiredMessage } from "./auth-messages.js";

describe("formatControlUiDeviceIdentityRequiredMessage", () => {
  it("returns actionable guidance for insecure control-ui connections", () => {
    const message = formatControlUiDeviceIdentityRequiredMessage();
    expect(message).toContain("control ui requires device identity");
    expect(message).toContain("HTTPS/WSS on remote hosts");
    expect(message).toContain("localhost secure context");
    expect(message).toContain("gateway.controlUi.allowInsecureAuth=true");
  });
});
