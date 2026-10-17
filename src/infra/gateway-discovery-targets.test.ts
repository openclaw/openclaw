import { afterEach, describe, expect, it, vi } from "vitest";
import { inferSshTargetFromRemoteUrl } from "../commands/gateway-status/discovery.js";
import { buildGatewayDiscoveryTarget } from "./gateway-discovery-targets.js";
import { parseSshTarget } from "./ssh-tunnel.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("IPv6 gateway targets", () => {
  it("infers an SSH target the parser accepts from a bracketed remote URL", () => {
    vi.stubEnv("USER", "me");
    const target = inferSshTargetFromRemoteUrl("wss://[2001:db8::10]:18789");
    expect(target).toBe("me@[2001:db8::10]");
    expect(parseSshTarget(target ?? "")).toEqual({ user: "me", host: "2001:db8::10", port: 22 });
  });

  it.each([
    { sshPort: undefined, target: "me@[2001:db8::10]", port: 22 },
    { sshPort: 2222, target: "me@[2001:db8::10]:2222", port: 2222 },
  ])("publishes a usable WebSocket URL and SSH target (ssh port $sshPort)", (input) => {
    const built = buildGatewayDiscoveryTarget(
      { instanceName: "gw", host: "2001:db8::10", port: 18789, sshPort: input.sshPort },
      { sshUser: "me" },
    );
    expect(new URL(built.wsUrl ?? "").hostname).toBe("[2001:db8::10]");
    expect(built.sshTarget).toBe(input.target);
    expect(parseSshTarget(built.sshTarget ?? "")).toEqual({
      user: "me",
      host: "2001:db8::10",
      port: input.port,
    });
  });

  it("leaves DNS names and IPv4 addresses unchanged", () => {
    const built = buildGatewayDiscoveryTarget(
      { instanceName: "gw", host: "gateway.local", port: 18789 },
      { sshUser: "me" },
    );
    expect(built.wsUrl).toBe("ws://gateway.local:18789");
    expect(built.sshTarget).toBe("me@gateway.local");
  });
});
