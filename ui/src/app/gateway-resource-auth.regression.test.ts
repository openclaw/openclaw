// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { authorizeHttpGatewayConnect } from "../../../src/gateway/auth.ts";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { AuthenticatedAvatarRouteLoader } from "../lib/authenticated-avatar-route.ts";
import { lookupClientGeolocation } from "../lib/geolocation-lookup.ts";
import {
  fetchGatewayContextResource,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { updateGatewayAvatarContext } from "./gateway-store.avatar-context.ts";

let loader: AuthenticatedAvatarRouteLoader | undefined;
afterEach(async () => {
  loader?.disconnect();
  loader = undefined;
  setAvatarGatewayOrigin(null);
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["agent", "user"])(
  "loads the %s avatar with the confirmed Tailscale identity",
  async (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "https://gateway.example" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified-avatar");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).has("authorization")
        ? new Response("Rejected device credential", { status: 401 })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    updateGatewayAvatarContext(
      null,
      {
        gatewayUrl: "wss://gateway.example/ws",
        token: "",
        password: "",
        bootstrapToken: "",
      },
      "",
      {
        auth: { method: "tailscale", deviceToken: "synthetic-issuerless-device-token" },
      } as GatewayHelloOk,
      () => true,
    );
    if (kind === "agent") {
      loader = new AuthenticatedAvatarRouteLoader(() => {}, { gatewayContext: true });
      loader.connect();
      loader.resolve("/avatar/main");
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.resolve("/avatar/main")).toBe("blob:verified-avatar");
    } else {
      const result = resolveAvatarImageUrl("/api/users/synthetic-user/avatar");
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toBe("blob:verified-avatar");
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  },
);

it.each([401, 403, 429])("does not switch identity after an ambient %s denial", async (status) => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { origin: "https://gateway.example" });
  const request = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", request);
  updateGatewayAvatarContext(
    null,
    {
      gatewayUrl: "wss://gateway.example",
      token: "synthetic-owner-token",
      password: "",
      bootstrapToken: "",
    },
    "",
    { auth: { method: "tailscale", deviceToken: "synthetic-device-token" } } as GatewayHelloOk,
    () => true,
  );
  if (status === 429) {
    expect(
      (await fetchGatewayContextResource("/avatar/main", 1000, undefined, "image")).status,
    ).toBe(429);
  } else {
    await expect(
      fetchGatewayContextResource("/avatar/main", 1000, undefined, "image"),
    ).rejects.toThrow("Gateway credentials rejected");
  }
  expect(request).toHaveBeenCalledOnce();
});

it("retains ordinary credentials at the geolocation HTTP authorization boundary", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { origin: "https://gateway.example" });
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "");
    const auth = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "synthetic-http-token", allowTailscale: true },
      connectAuth: { token },
    });
    return auth.ok
      ? Response.json({ found: true, country: "GB" })
      : new Response(null, { status: 401 });
  });
  vi.stubGlobal("fetch", request);
  updateGatewayAvatarContext(
    null,
    {
      gatewayUrl: "wss://gateway.example",
      token: "",
      password: "",
      bootstrapToken: "",
    },
    "",
    { auth: { method: "tailscale", deviceToken: "synthetic-http-token" } } as GatewayHelloOk,
    () => true,
  );
  await expect(lookupClientGeolocation("8.8.8.8")).resolves.toEqual({
    status: "located",
    location: { country: "GB" },
  });
  expect(request).toHaveBeenCalledOnce();
});
