import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSshConfigHardeningWarnings,
  collectTailscaleRemoteHealthWarnings,
  maybeRepairTailscaleRemoteHealth,
  parseSshConfigDump,
} from "./tailscale-remote-health.js";

describe("tailscale remote health doctor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function createUserspaceSocket() {
    const home = await mkdtemp(path.join(os.tmpdir(), "openclaw-tailscale-doctor-"));
    tempDirs.push(home);
    const socketDir = path.join(home, ".local/share/tailscale-userspace");
    await mkdir(socketDir, { recursive: true });
    const socketPath = path.join(socketDir, "tailscaled.sock");
    await writeFile(socketPath, "");
    return { home, socketPath };
  }

  it("repairs userspace socket, active origin, and missing Serve route", async () => {
    const { home, socketPath } = await createUserspaceSocket();
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "which") {
        return { stdout: "tailscale\n", stderr: "" };
      }
      const socketIndex = args.indexOf("--socket");
      const socket = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
      if (args.includes("status") && args.includes("--json") && !args.includes("serve")) {
        if (!socket) {
          throw Object.assign(new Error("default socket dead"), {
            stderr: "dial unix /var/run/tailscaled.socket: no such file or directory",
          });
        }
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: {
              DNSName: "mac-studio-userspace.tailnet.ts.net.",
              TailscaleIPs: ["100.110.93.73"],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("ip") && args.includes("-4")) {
        return { stdout: "100.110.93.73\n", stderr: "" };
      }
      if (args.includes("serve") && args.includes("status")) {
        return { stdout: JSON.stringify({ Web: {} }), stderr: "" };
      }
      if (args.includes("serve") && args.includes("--https=443")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("whois")) {
        return {
          stdout: JSON.stringify({ UserProfile: { LoginName: "openclaw@example.com" } }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    });

    const result = await maybeRepairTailscaleRemoteHealth({
      cfg: {
        gateway: {
          port: 18789,
          tailscale: { mode: "serve" },
          auth: { allowTailscale: true },
          controlUi: { allowedOrigins: ["https://old.tailnet.ts.net"] },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
      env: { HOME: home, NODE_ENV: "test" },
      exec: exec as never,
      fileExists: () => false,
    });

    expect(result.config.gateway?.tailscale?.socketPath).toBe(socketPath);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toContain(
      "https://mac-studio-userspace.tailnet.ts.net",
    );
    expect(result.changes.join("\n")).toContain("Tailscale Serve: reapplied");
    expect(exec).toHaveBeenCalledWith(
      "tailscale",
      ["--socket", socketPath, "serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:18789"],
      expect.any(Object),
    );
  });

  it("catches SSH wildcard routing and weak keepalive config", async () => {
    const config = parseSshConfigDump(`
host openclaw-studio
hostname github.com
serveraliveinterval 0
serveralivecountmax 1
controlmaster false
controlpersist no
`);

    const warnings = collectSshConfigHardeningWarnings({
      target: "openclaw-studio",
      config,
    });

    expect(warnings.join("\n")).toContain("resolves to github.com");
    expect(warnings.join("\n")).toContain("ServerAliveInterval 30");
    expect(warnings.join("\n")).toContain("ControlPersist 10m");
  });

  it("checks configured remote Codex SSH target in batch mode", async () => {
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
          stdout: JSON.stringify({ status: "running", cliVersion: "0.131.0-alpha.9" }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    });

    const warnings = await collectTailscaleRemoteHealthWarnings({
      cfg: { gateway: { remote: { codexSshTarget: "openclaw-studio" } } },
      doctorFixCommand: "openclaw doctor --fix",
      exec: exec as never,
      env: {},
    });

    expect(warnings).toEqual([]);
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/ssh",
      expect.arrayContaining(["BatchMode=yes", "--", "openclaw-studio"]),
      expect.any(Object),
    );
  });
});
