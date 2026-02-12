import { describe, expect, it, vi } from "vitest";

vi.mock("./net.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveGatewayBindHost: vi.fn(async () => "0.0.0.0"),
  };
});

vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertGatewayAuthConfigured: vi.fn(),
    resolveGatewayAuth: vi.fn(() => ({
      mode: "token" as const,
      token: "test-token",
      allowTailscale: true,
    })),
  };
});

vi.mock("./hooks.js", () => ({
  resolveHooksConfig: vi.fn(() => ({ enabled: false, hooks: [] })),
}));

vi.mock("./control-ui-shared.js", () => ({
  normalizeControlUiBasePath: vi.fn(() => "/"),
}));

import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayBindHost } from "./net.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const baseCfg = {} as OpenClawConfig;

describe("resolveGatewayRuntimeConfig", () => {
  it("auto-corrects bind to loopback when tailscale.mode is serve", async () => {
    vi.mocked(resolveGatewayBindHost).mockResolvedValue("0.0.0.0");

    const result = await resolveGatewayRuntimeConfig({
      cfg: baseCfg,
      port: 18789,
      bind: "lan",
      tailscale: { mode: "serve" },
    });

    expect(result.bindHost).toBe("127.0.0.1");
  });

  it("auto-corrects bind to loopback when tailscale.mode is funnel", async () => {
    vi.mocked(resolveGatewayBindHost).mockResolvedValue("192.168.1.100");

    const { resolveGatewayAuth } = await import("./auth.js");
    vi.mocked(resolveGatewayAuth).mockReturnValue({
      mode: "password",
      password: "test-pass",
      allowTailscale: false,
    });

    const result = await resolveGatewayRuntimeConfig({
      cfg: baseCfg,
      port: 18789,
      bind: "lan",
      tailscale: { mode: "funnel" },
    });

    expect(result.bindHost).toBe("127.0.0.1");
  });

  it("keeps non-loopback bind when tailscale is off", async () => {
    vi.mocked(resolveGatewayBindHost).mockResolvedValue("0.0.0.0");

    const result = await resolveGatewayRuntimeConfig({
      cfg: baseCfg,
      port: 18789,
      bind: "lan",
    });

    expect(result.bindHost).toBe("0.0.0.0");
  });

  it("keeps loopback bind unchanged when tailscale is active", async () => {
    vi.mocked(resolveGatewayBindHost).mockResolvedValue("127.0.0.1");

    const result = await resolveGatewayRuntimeConfig({
      cfg: baseCfg,
      port: 18789,
      bind: "loopback",
      tailscale: { mode: "serve" },
    });

    expect(result.bindHost).toBe("127.0.0.1");
  });
});
