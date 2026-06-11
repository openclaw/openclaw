import { describe, expect, it, vi } from "vitest";
import { buildGatewayRemoteAccessHealth } from "./remote-access-health.js";

function createTailscaleExec(params: {
  serveStatus?: Record<string, unknown>;
  status?: Record<string, unknown>;
  ip?: string;
}) {
  const status =
    params.status ??
    ({
      BackendState: "Running",
      Self: {
        DNSName: "mac-studio-userspace.tailnet.ts.net.",
        TailscaleIPs: ["100.110.93.73"],
      },
    } as Record<string, unknown>);
  return vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === "tailscale" && args.includes("serve") && args.includes("status")) {
      return { stdout: JSON.stringify(params.serveStatus ?? {}), stderr: "" };
    }
    if (cmd === "tailscale" && args.includes("status") && args.includes("--json")) {
      return { stdout: JSON.stringify(status), stderr: "" };
    }
    if (cmd === "tailscale" && args.includes("ip") && args.includes("-4")) {
      return { stdout: params.ip ?? "100.110.93.73\n", stderr: "" };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  });
}

describe("buildGatewayRemoteAccessHealth", () => {
  it("fails required health when the strict Serve route points at the wrong backend", async () => {
    const exec = createTailscaleExec({
      serveStatus: {
        Web: {
          "mac-studio-userspace.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
          },
        },
      },
    });

    const health = await buildGatewayRemoteAccessHealth({
      cfg: {
        gateway: {
          port: 18789,
          tailscale: { mode: "serve", binaryPath: "tailscale" },
        },
      },
      env: { NODE_ENV: "test" },
      exec: exec as never,
    });

    expect(health).toMatchObject({
      status: "failed",
      required: true,
      tailscale: { serveRouteOk: false },
    });
    expect(health?.degradedReasons.join("\n")).toContain("expected http://127.0.0.1:18789");
  });

  it("reports best-effort Serve drift as degraded instead of healthy", async () => {
    const exec = createTailscaleExec({
      serveStatus: {
        Web: {
          "mac-studio-userspace.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
          },
        },
      },
    });

    const health = await buildGatewayRemoteAccessHealth({
      cfg: {
        gateway: {
          port: 18789,
          tailscale: { mode: "serve", required: false, binaryPath: "tailscale" },
        },
      },
      env: { NODE_ENV: "test" },
      exec: exec as never,
    });

    expect(health).toMatchObject({
      status: "degraded",
      required: false,
      tailscale: { serveRouteOk: false },
    });
  });

  it("checks configured Codex SSH daemon target in batch mode", async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "/usr/bin/ssh" && args.includes("-G")) {
        return {
          stdout: [
            "hostname mac-studio-userspace",
            "serveraliveinterval 30",
            "serveralivecountmax 6",
            "controlmaster auto",
            "controlpersist 10m",
          ].join("\n"),
          stderr: "",
        };
      }
      if (cmd === "/usr/bin/ssh") {
        return {
          stdout: JSON.stringify({
            status: "running",
            cliVersion: "0.131.0-alpha.9",
            appServerVersion: "0.131.0-alpha.9",
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    });

    const health = await buildGatewayRemoteAccessHealth({
      cfg: { gateway: { remote: { codexSshTarget: "openclaw-studio" } } },
      env: { NODE_ENV: "test" },
      exec: exec as never,
    });

    expect(health).toMatchObject({
      status: "healthy",
      required: true,
      codexSsh: {
        target: "openclaw-studio",
        batchOk: true,
        daemonStatus: "running",
        appServerVersion: "0.131.0-alpha.9",
      },
    });
  });
});
