import { describe, expect, it } from "vitest";
import { formatTailscaleOverviewValue } from "./status.tailscale.js";

const muted = (value: string) => `muted:${value}`;
const warn = (value: string) => `warn:${value}`;

describe("formatTailscaleOverviewValue", () => {
  it("shows active mode when tailscale is running even if mode is off", () => {
    const value = formatTailscaleOverviewValue({
      tailscaleMode: "off",
      tailscaleDns: "host.tailnet.ts.net",
      tailscaleHttpsUrl: null,
      tailscaleBackendState: "Running",
      muted,
      warn,
    });

    expect(value).toBe("active · mode off · Running · host.tailnet.ts.net");
  });

  it("keeps off when mode is off and no tailscale runtime signal exists", () => {
    const value = formatTailscaleOverviewValue({
      tailscaleMode: "off",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      tailscaleBackendState: null,
      muted,
      warn,
    });

    expect(value).toBe("muted:off");
  });

  it("includes backend state for configured tailscale mode", () => {
    const value = formatTailscaleOverviewValue({
      tailscaleMode: "serve",
      tailscaleDns: "host.tailnet.ts.net",
      tailscaleHttpsUrl: "https://host.tailnet.ts.net",
      tailscaleBackendState: "Running",
      muted,
      warn,
    });

    expect(value).toBe("serve · Running · host.tailnet.ts.net · https://host.tailnet.ts.net");
  });

  it("warns when configured mode lacks dns details", () => {
    const value = formatTailscaleOverviewValue({
      tailscaleMode: "serve",
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      tailscaleBackendState: "Stopped",
      muted,
      warn,
    });

    expect(value).toBe("warn:serve · Stopped · magicdns unknown");
  });
});
