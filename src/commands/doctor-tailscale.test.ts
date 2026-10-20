// Doctor Tailscale tests cover safe migration of shipped external Serve routes.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TailscaleStatusCommandRunner } from "../shared/tailscale-status.js";
import { collectTailscaleConfigWarnings } from "./doctor-tailscale.js";

function serveStatus(
  params: {
    backendPort?: number;
    hostPort?: number;
    path?: string;
    proxyHost?: string;
    funnel?: boolean;
  } = {},
): string {
  const backendPort = params.backendPort ?? 18789;
  const hostPort = params.hostPort ?? 443;
  const host = `mac.tail.ts.net:${hostPort}`;
  return JSON.stringify({
    TCP: { [hostPort]: { HTTPS: true } },
    Web: {
      [host]: {
        Handlers: {
          [params.path ?? "/"]: {
            Proxy: `http://${params.proxyHost ?? "127.0.0.1"}:${backendPort}`,
          },
        },
      },
    },
    ...(params.funnel ? { AllowFunnel: { [host]: true } } : {}),
  });
}

function runner(stdout: string): TailscaleStatusCommandRunner {
  return vi.fn().mockResolvedValue({ code: 0, stdout });
}

async function inspectWithoutConfigMutation(
  params: Parameters<typeof collectTailscaleConfigWarnings>[0],
) {
  const original = structuredClone(params.cfg);
  const warnings = await collectTailscaleConfigWarnings(params);
  expect(params.cfg).toEqual(original);
  return warnings;
}

describe("collectTailscaleConfigWarnings", () => {
  it("does not adopt a canonical-looking route without ownership proof", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret", allowTailscale: true },
        tailscale: { mode: "off", preserveFunnel: true },
      },
    };

    const warnings = await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: runner(serveStatus()),
    });

    const warning = warnings.join("\n");
    expect(warning).toContain("cannot prove that OpenClaw owns");
    expect(warning).toContain("confirm the route belongs to the current Tailscale hostname");
    expect(warning).toContain("leave managed Tailscale ingress off");
  });

  it("recognizes the predecessor of a custom managed Gateway port", async () => {
    const port = 19001;
    const cfg: OpenClawConfig = {
      gateway: { bind: "loopback", port, tailscale: { mode: "serve" } },
    };
    const warnings = await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: runner(serveStatus({ backendPort: port, proxyHost: "localhost" })),
    });
    expect(warnings.join("\n")).toContain("will be adopted");
  });

  it.each([
    ["no matching route", {}, "{}"],
    ["Funnel route", {}, serveStatus({ funnel: true })],
    ["non-root route", {}, serveStatus({ path: "/openclaw" })],
    ["non-loopback backend", {}, serveStatus({ proxyHost: "192.0.2.10" })],
    ["different backend port", {}, serveStatus({ backendPort: 19000 })],
    ["non-LAN bind", { bind: "loopback" as const }, serveStatus()],
    ["managed mode", { tailscale: { mode: "serve" as const } }, serveStatus()],
    ["remote Gateway", { mode: "remote" as const }, serveStatus()],
  ])("does not migrate a %s", async (_label, gatewayOverrides, stdout) => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
        ...gatewayOverrides,
      },
    };

    await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: runner(stdout),
    });
  });

  it("warns instead of guessing how to migrate a custom HTTPS port", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
      },
    };

    const warnings = await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: runner(serveStatus({ hostPort: 8443 })),
    });

    expect(warnings.join("\n")).toContain("not changed");
    expect(warnings.join("\n")).toContain("--https=8443 --set-path=/ off");
  });

  it("warns on malformed status but stays quiet when Tailscale is unavailable", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
      },
    };
    const unavailable = vi.fn().mockRejectedValue(new Error("missing"));

    const invalidWarnings = await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: runner("not-json"),
    });
    const unavailableWarnings = await inspectWithoutConfigMutation({
      cfg,
      env: {},
      runCommandWithTimeout: unavailable,
    });

    expect(invalidWarnings.join("\n")).toContain("could not be parsed");
    expect(unavailableWarnings).toEqual([]);
  });
});
