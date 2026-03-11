import { describe, expect, it } from "vitest";
import { appendStatusAllDiagnosis } from "./diagnosis.js";

describe("appendStatusAllDiagnosis", () => {
  it("marks tailscale off mode as healthy even when backend state is unknown", async () => {
    const lines: string[] = [];
    await appendStatusAllDiagnosis({
      lines,
      progress: {
        setLabel: () => {},
        setPercent: () => {},
        tick: () => {},
        done: () => {},
      },
      muted: (text) => text,
      ok: (text) => text,
      warn: (text) => text,
      fail: (text) => text,
      connectionDetailsForReport: "local",
      snap: null,
      remoteUrlMissing: false,
      sentinel: null,
      lastErr: null,
      port: 18789,
      portUsage: null,
      tailscaleMode: "off",
      tailscale: {
        backendState: null,
        dnsName: null,
        ips: [],
        error: null,
      },
      tailscaleHttpsUrl: null,
      skillStatus: null,
      channelsStatus: null,
      channelIssues: [],
      gatewayReachable: false,
      health: null,
    });

    expect(lines).toContain("✓ Tailscale: off · unknown");
  });
});
