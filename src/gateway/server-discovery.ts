import path from "node:path";
import { isRegularFile } from "../infra/executable-path.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";

/** Formats the Bonjour instance name while preserving user-provided OpenClaw names. */
export function formatBonjourInstanceName(displayName: string) {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return "OpenClaw";
  }
  if (/openclaw/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} (OpenClaw)`;
}

/** Resolves the CLI path advertised to Bonjour clients, preferring explicit env config. */
export function resolveBonjourCliPath(): string | undefined {
  const envPath = process.env.OPENCLAW_CLI_PATH?.trim();
  if (envPath) {
    return envPath;
  }

  const execDir = path.dirname(process.execPath);
  const siblingCli = path.join(execDir, "openclaw");
  if (isRegularFile(siblingCli)) {
    return siblingCli;
  }

  const argvPath = process.argv[1];
  if (argvPath && isRegularFile(argvPath)) {
    return argvPath;
  }

  const cwd = process.cwd();
  return [path.join(cwd, "dist", "index.js"), path.join(cwd, "bin", "openclaw")].find(
    isRegularFile,
  );
}

/** Resolves a Tailnet DNS hint from env or the local tailscale CLI when enabled. */
export async function resolveTailnetDnsHint(opts?: {
  enabled?: boolean;
}): Promise<string | undefined> {
  const envValue = process.env.OPENCLAW_TAILNET_DNS?.trim().replace(/\.$/, "");
  if (envValue) {
    return envValue;
  }
  if (opts?.enabled === false) {
    return undefined;
  }

  try {
    return await getTailnetHostname((command, args) =>
      runExec(command, args, { timeoutMs: 1500, maxBuffer: 200_000 }),
    );
  } catch {
    return undefined;
  }
}
