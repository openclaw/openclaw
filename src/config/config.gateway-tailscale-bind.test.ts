import { expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

it("rejects explicit no-auth when Tailscale exposes the gateway", () => {
  for (const mode of ["serve", "funnel"] as const) {
    expect(
      validateConfigObject({
        gateway: { bind: "loopback", auth: { mode: "none" }, tailscale: { mode } },
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "gateway.auth.mode" })],
    });
  }
});

it("accepts a custom IPv4 loopback bind host with Tailscale", () => {
  expect(
    validateConfigObject({
      gateway: { bind: "custom", customBindHost: "127.0.0.1", tailscale: { mode: "serve" } },
    }).ok,
  ).toBe(true);
});

it("rejects IPv6 custom bind hosts for Tailscale", () => {
  expect(
    validateConfigObject({
      gateway: { bind: "custom", customBindHost: "::1", tailscale: { mode: "serve" } },
    }),
  ).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "gateway.bind" })] });
});

it("rejects non-loopback binds when Tailscale is enabled", () => {
  const gateways = [
    { bind: "lan", tailscale: { mode: "serve" } },
    { bind: "custom", customBindHost: "10.0.0.5", tailscale: { mode: "funnel" } },
  ];
  for (const gateway of gateways) {
    expect(validateConfigObject({ gateway })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "gateway.bind" })],
    });
  }
});
