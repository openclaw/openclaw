import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import {
  pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6,
} from "../infra/tailnet.js";
import {
  getWideAreaZonePath,
  WIDE_AREA_DISCOVERY_DOMAIN,
} from "../infra/widearea-dns.js";

type RunOpts = { allowFailure?: boolean; inherit?: boolean };

function run(cmd: string, args: string[], opts?: RunOpts): string {
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: opts?.inherit ? "inherit" : "pipe",
  });
  if (res.error) throw res.error;
  if (!opts?.allowFailure && res.status !== 0) {
    const errText =
      typeof res.stderr === "string" && res.stderr.trim()
        ? res.stderr.trim()
        : `exit ${res.status ?? "unknown"}`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${errText}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

function detectBrewPrefix(): string {
  const out = run("brew", ["--prefix"]);
  const prefix = out.trim();
  if (!prefix) throw new Error("failed to resolve Homebrew prefix");
  return prefix;
}

function ensureImportLine(corefilePath: string, importGlob: string): boolean {
  const existing = fs.readFileSync(corefilePath, "utf-8");
  if (existing.includes(importGlob)) return false;
  const next = `${existing.replace(/\s*$/, "")}\n\nimport ${importGlob}\n`;
  fs.writeFileSync(corefilePath, next, "utf-8");
  return true;
}

export function registerDnsCli(program: Command) {
  const dns = program
    .command("dns")
    .description("DNS helpers for wide-area discovery (Tailscale + CoreDNS)");

  dns
    .command("setup")
    .description(
      "Set up CoreDNS to serve clawdis.internal for unicast DNS-SD (Wide-Area Bonjour)",
    )
    .option(
      "--apply",
      "Install/update CoreDNS config and (re)start the service (requires sudo)",
      false,
    )
    .action(async (opts) => {
      const cfg = loadConfig();
      const tailnetIPv4 = pickPrimaryTailnetIPv4();
      const tailnetIPv6 = pickPrimaryTailnetIPv6();
      const zonePath = getWideAreaZonePath();

      console.log(`Domain: ${WIDE_AREA_DISCOVERY_DOMAIN}`);
      console.log(`Zone file (gateway-owned): ${zonePath}`);
      console.log(
        `Detected tailnet IP: ${tailnetIPv4 ?? "—"}${tailnetIPv6 ? ` (v6 ${tailnetIPv6})` : ""}`,
      );
      console.log("");
      console.log("Recommended ~/.clawdis/clawdis.json:");
      console.log(
        JSON.stringify(
          {
            bridge: { bind: "tailnet" },
            discovery: { wideArea: { enabled: true } },
          },
          null,
          2,
        ),
      );
      console.log("");
      console.log("Tailscale admin (DNS → Nameservers):");
      console.log(
        `- Add nameserver: ${tailnetIPv4 ?? "<this machine's tailnet IPv4>"}`,
      );
      console.log(`- Restrict to domain (Split DNS): clawdis.internal`);

      if (!opts.apply) {
        console.log("");
        console.log("Run with --apply to install CoreDNS and configure it.");
        return;
      }

      if (process.platform !== "darwin") {
        throw new Error("dns setup is currently supported on macOS only");
      }
      if (!tailnetIPv4 && !tailnetIPv6) {
        throw new Error(
          "no tailnet IP detected; ensure Tailscale is running on this machine",
        );
      }

      const prefix = detectBrewPrefix();
      const etcDir = path.join(prefix, "etc", "coredns");
      const corefilePath = path.join(etcDir, "Corefile");
      const confDir = path.join(etcDir, "conf.d");
      const importGlob = path.join(confDir, "*.server");
      const serverPath = path.join(confDir, "clawdis.internal.server");

      run("brew", ["list", "coredns"], { allowFailure: true });
      run("brew", ["install", "coredns"], {
        inherit: true,
        allowFailure: true,
      });

      await fs.promises.mkdir(confDir, { recursive: true });

      if (fs.existsSync(corefilePath)) {
        ensureImportLine(corefilePath, importGlob);
      }

      const bindArgs = [tailnetIPv4, tailnetIPv6].filter((v): v is string =>
        Boolean(v?.trim()),
      );

      const server = [
        `${WIDE_AREA_DISCOVERY_DOMAIN.replace(/\.$/, "")}:53 {`,
        `  bind ${bindArgs.join(" ")}`,
        `  file ${zonePath} {`,
        `    reload 10s`,
        `  }`,
        `  errors`,
        `  log`,
        `}`,
        ``,
      ].join("\n");
      fs.writeFileSync(serverPath, server, "utf-8");

      // Ensure the gateway can write its zone file path.
      await fs.promises.mkdir(path.dirname(zonePath), { recursive: true });
      if (!fs.existsSync(zonePath)) {
        fs.writeFileSync(
          zonePath,
          `; created by clawdis dns setup\n$ORIGIN ${WIDE_AREA_DISCOVERY_DOMAIN}\n$TTL 60\n`,
          "utf-8",
        );
      }

      console.log("");
      console.log("Starting CoreDNS (sudo)…");
      run("sudo", ["brew", "services", "restart", "coredns"], {
        inherit: true,
      });

      if (cfg.discovery?.wideArea?.enabled !== true) {
        console.log("");
        console.log(
          "Note: enable discovery.wideArea.enabled in ~/.clawdis/clawdis.json on the gateway and restart the gateway so it writes the DNS-SD zone.",
        );
      }
    });
}
