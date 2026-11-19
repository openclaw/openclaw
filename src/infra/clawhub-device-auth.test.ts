import { afterEach, describe, expect, it, vi } from "vitest";
import { pollClawHubDeviceSignIn, startClawHubDeviceSignIn } from "./clawhub-device-auth.js";
import { captureClawHubResponse } from "./clawhub.test-support.js";

const baseUrl = "https://clawhub.example";
const verificationUrl = "https://clawhub.example/cli/device?user_code=ZYXW-2345";
const fakeDeviceCode = "synthetic-device-code";

function deviceCodeResponse(url = verificationUrl) {
  return Response.json({
    device_code: fakeDeviceCode,
    user_code: "ZYXW-2345",
    verification_uri: url,
    expires_in: 900,
    interval: 5,
  });
}

function tokenResponse(error: string, status: number) {
  return Response.json({ error }, { status });
}

afterEach(() => vi.restoreAllMocks());

describe("ClawHub browser sign-in", () => {
  it("starts a browser approval without forwarding another user's API token", async () => {
    const request = captureClawHubResponse(() => deviceCodeResponse());
    const authorization = await startClawHubDeviceSignIn({
      baseUrl,
      token: "unrelated-synthetic-token",
    });
    expect(authorization).toEqual({
      deviceCode: fakeDeviceCode,
      verificationUrl,
      intervalMs: 5_000,
      expiresInMs: 900_000,
    });
    expect(request.url().href).toBe(baseUrl + "/api/cli/device/code");
    expect(request.init()?.method).toBe("POST");
    expect(new Headers(request.init()?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(request.init()?.body))).toEqual({
      label: "OpenClaw Template publishing",
      site_url: baseUrl,
    });
  });

  it("does not send the user to a foreign approval origin", async () => {
    captureClawHubResponse(() => deviceCodeResponse("https://different.example/cli/device"));
    await expect(startClawHubDeviceSignIn({ baseUrl })).rejects.toThrow(
      "ClawHub returned an invalid sign-in response.",
    );
  });

  it.each([
    ["authorization_pending", 428, "pending"],
    ["access_denied", 400, "denied"],
    ["expired_token", 400, "expired"],
  ] as const)("reports %s without returning a token", async (error, status, kind) => {
    captureClawHubResponse(() => tokenResponse(error, status));
    await expect(pollClawHubDeviceSignIn(fakeDeviceCode, { baseUrl })).resolves.toEqual({ kind });
  });

  it("exchanges an approved device code for a ClawHub API token", async () => {
    const request = captureClawHubResponse(() =>
      Response.json({ access_token: "synthetic-publisher-token", token_type: "bearer" }),
    );
    await expect(pollClawHubDeviceSignIn(fakeDeviceCode, { baseUrl })).resolves.toEqual({
      kind: "authorized",
      token: "synthetic-publisher-token",
    });
    expect(request.url().href).toBe(baseUrl + "/api/cli/device/token");
    expect(JSON.parse(String(request.init()?.body))).toEqual({
      device_code: fakeDeviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });
});
