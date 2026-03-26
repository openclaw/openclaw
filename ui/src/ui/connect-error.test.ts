import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import { formatConnectError } from "./connect-error.ts";

function setTestWindowUrl(url: string) {
  window.history.replaceState({}, "", url);
}

describe("formatConnectError", () => {
  beforeEach(() => {
    setTestWindowUrl("/ui/overview");
  });

  afterEach(() => {
    setTestWindowUrl("/ui/overview");
  });

  it("suggests #token fragment syntax when device identity errors happen with a query token", () => {
    setTestWindowUrl("/ui/overview?token=query-token");

    const message = formatConnectError({
      message: "device identity required",
      details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED },
    });

    expect(message).toContain("device identity required");
    expect(message).toContain("?token=...");
    expect(message).toContain("/#token=<token>");
  });

  it("keeps the standard insecure-auth guidance when the URL already uses a hash token", () => {
    setTestWindowUrl("/ui/overview#token=hash-token");

    const message = formatConnectError({
      message: "device identity required",
      details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
    });

    expect(message).toBe(
      "device identity required (use HTTPS/localhost or allow insecure auth explicitly)",
    );
  });
});
