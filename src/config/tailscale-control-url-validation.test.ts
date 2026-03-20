import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("gateway.tailscale.controlUrl validation", () => {
  it("accepts controlUrl with mode off", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        bind: "tailnet",
        auth: { mode: "token", token: "tok" },
        tailscale: {
          controlUrl: "https://headscale.example.com",
          mode: "off",
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts controlUrl without a mode (defaults to off)", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        bind: "tailnet",
        auth: { mode: "token", token: "tok" },
        tailscale: {
          controlUrl: "https://headscale.example.com",
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it.each(["serve", "funnel"] as const)(
    "rejects custom controlUrl combined with mode=%s",
    (mode) => {
      const result = validateConfigObjectRaw({
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "tok" },
          tailscale: {
            controlUrl: "https://headscale.example.com",
            mode,
          },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "gateway.tailscale.mode",
          message: expect.stringContaining("not supported with a custom control server"),
        }),
      );
    },
  );

  it.each(["serve", "funnel"] as const)(
    "accepts official Tailscale controlUrl combined with mode=%s",
    (mode) => {
      const result = validateConfigObjectRaw({
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "tok" },
          tailscale: {
            controlUrl: "https://controlplane.tailscale.com",
            mode,
          },
        },
      });
      expect(result.ok).toBe(true);
    },
  );

  it("rejects invalid controlUrl (not a URL)", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        bind: "tailnet",
        auth: { mode: "token", token: "tok" },
        tailscale: {
          controlUrl: "not-a-url",
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects controlUrl with non-http scheme", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        bind: "tailnet",
        auth: { mode: "token", token: "tok" },
        tailscale: {
          controlUrl: "ftp://headscale.example.com",
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
