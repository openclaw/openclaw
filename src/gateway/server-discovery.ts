import fs from "node:fs";
import path from "node:path";
import { getTailnetHostname } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";

export type ResolveBonjourCliPathOptions = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  cwd?: string;
  statSync?: (path: string) => fs.Stats;
};

/**
 * mDNS service instance names are single DNS labels limited to 63 bytes
 * (RFC 6763 §4.1.1). Exceeding this causes @homebridge/ciao to throw an
 * AssertionError and crash the gateway — common in container environments
 * where hostnames can be very long (e.g. Kubernetes pod names).
 */
const MAX_MDNS_LABEL_BYTES = 63;

function truncateToMdnsLabel(name: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).byteLength <= MAX_MDNS_LABEL_BYTES) {
    return name;
  }
  // Trim characters from the end until we fit within the byte budget.
  // This handles multi-byte (UTF-8) characters correctly.
  let truncated = name;
  while (encoder.encode(truncated).byteLength > MAX_MDNS_LABEL_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trimEnd();
}

export function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return "OpenClaw";
  }
  const raw = /openclaw/i.test(trimmed) ? trimmed : `${trimmed} (OpenClaw)`;
  return truncateToMdnsLabel(raw);
}

export function resolveBonjourCliPath(opts: ResolveBonjourCliPathOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const envPath = env.OPENCLAW_CLI_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const statSync = opts.statSync ?? fs.statSync;
  const isFile = (candidate: string) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const execPath = opts.execPath ?? process.execPath;
  const execDir = path.dirname(execPath);
  const siblingCli = path.join(execDir, "openclaw");
  if (isFile(siblingCli)) {
    return siblingCli;
  }

  const argv = opts.argv ?? process.argv;
  const argvPath = argv[1];
  if (argvPath && isFile(argvPath)) {
    return argvPath;
  }

  const cwd = opts.cwd ?? process.cwd();
  const distCli = path.join(cwd, "dist", "index.js");
  if (isFile(distCli)) {
    return distCli;
  }
  const binCli = path.join(cwd, "bin", "openclaw");
  if (isFile(binCli)) {
    return binCli;
  }

  return undefined;
}

export async function resolveTailnetDnsHint(opts?: {
  env?: NodeJS.ProcessEnv;
  exec?: typeof runExec;
  enabled?: boolean;
}): Promise<string | undefined> {
  const env = opts?.env ?? process.env;
  const envRaw = env.OPENCLAW_TAILNET_DNS?.trim();
  const envValue = envRaw && envRaw.length > 0 ? envRaw.replace(/\.$/, "") : "";
  if (envValue) {
    return envValue;
  }
  if (opts?.enabled === false) {
    return undefined;
  }

  const exec =
    opts?.exec ??
    ((command, args) => runExec(command, args, { timeoutMs: 1500, maxBuffer: 200_000 }));
  try {
    return await getTailnetHostname(exec);
  } catch {
    return undefined;
  }
}
