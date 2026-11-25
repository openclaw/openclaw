// Doctor Tailscale tests cover safe migration of shipped external Serve routes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as exec from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { collectTailscaleConfigWarnings } from "./doctor-tailscale.js";

function serveStatus(
  params: {
    backendPort?: number;
    hostPort?: number;
    proxyHost?: string;
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
          "/": {
            Proxy: `http://${params.proxyHost ?? "127.0.0.1"}:${backendPort}`,
          },
        },
      },
    },
  });
}

async function inspect(stdout: string | Error, gateway: OpenClawConfig["gateway"] = {}) {
  const runner = vi.spyOn(exec, "runUtf8CommandWithTimeout");
  if (stdout instanceof Error) {
    runner.mockRejectedValue(stdout);
  } else {
    runner.mockResolvedValue(createCommandResult({ stdout }));
  }
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      bind: "lan",
      port: 18789,
      auth: { mode: "token", token: "secret" },
      tailscale: { mode: "off" },
      ...gateway,
    },
  };
  const original = structuredClone(cfg);
  const warnings = await collectTailscaleConfigWarnings({ cfg, env: {} });
  expect(cfg).toEqual(original);
  return warnings;
}

afterEach(() => vi.restoreAllMocks());

describe("collectTailscaleConfigWarnings", () => {
  it("does not adopt a canonical-looking route without ownership proof", async () => {
    const warnings = await inspect(serveStatus(), {
      auth: { mode: "token", token: "secret", allowTailscale: true },
      tailscale: { mode: "off", preserveFunnel: true },
    });

    const warning = warnings.join("\n");
    expect(warning).toContain("cannot prove that OpenClaw owns");
    expect(warning).toContain("confirm the route belongs to the current Tailscale hostname");
    expect(warning).toContain("leave managed Tailscale ingress off");
  });

  it("recognizes the predecessor of a custom managed Gateway port", async () => {
    const port = 19001;
    const warnings = await inspect(serveStatus({ backendPort: port, proxyHost: "localhost" }), {
      mode: undefined,
      auth: undefined,
      bind: "loopback",
      port,
      tailscale: { mode: "serve" },
    });
    expect(warnings.join("\n")).toContain("will be adopted");
  });

  it.each([
    ["no matching route", {}, "{}"],
    ["non-LAN bind", { bind: "loopback" as const }, serveStatus()],
    ["remote Gateway", { mode: "remote" as const }, serveStatus()],
  ])("leaves %s quiet and unchanged", async (_label, gatewayOverrides, stdout) => {
    expect(await inspect(stdout, gatewayOverrides)).toEqual([]);
  });

  it("warns instead of guessing how to migrate a custom HTTPS port", async () => {
    const warnings = await inspect(serveStatus({ hostPort: 8443 }));

    expect(warnings.join("\n")).toContain("not changed");
    expect(warnings.join("\n")).toContain("--https=8443 --set-path=/ off");
  });

  it("warns on malformed status but stays quiet when Tailscale is unavailable", async () => {
    const gateway = { mode: undefined, port: undefined };
    const invalidWarnings = await inspect("not-json", gateway);
    const unavailableWarnings = await inspect(new Error("missing"), gateway);

    expect(invalidWarnings.join("\n")).toContain("could not be parsed");
    expect(unavailableWarnings).toEqual([]);
  });
});
