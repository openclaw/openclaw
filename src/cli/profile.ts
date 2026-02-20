import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isValidProfileName } from "./profile-utils.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (sawDev) {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  // Exception: several service-scoped env vars are intentionally cleared for profile
  // isolation. A running gateway (or node daemon) sets these in the environment so its
  // own child processes can discover the parent's port, launchd label, systemd unit,
  // etc. When a child CLI starts a *different* profile's service, those inherited vars
  // would cause the child to target the parent's service instead of the profile's own.
  //
  // OPENCLAW_GATEWAY_PORT — resolveGatewayPort() would return the parent's port.
  // OPENCLAW_LAUNCHD_LABEL — resolveLaunchAgentLabel() would return the parent's
  //   launchd label, causing `gateway start/stop/restart` to operate on the parent
  //   gateway instead of the profile's own. This is the root cause of the "missing
  //   tool result in session history" error: the child CLI restarts the *parent*
  //   gateway mid-session, killing the running agent loop.
  // OPENCLAW_SYSTEMD_UNIT — same problem on Linux (resolveSystemdServiceName).
  // OPENCLAW_SERVICE_VERSION — harmless but misleading; let the child resolve its own.
  env.OPENCLAW_PROFILE = profile;
  delete env.OPENCLAW_GATEWAY_PORT;
  delete env.OPENCLAW_LAUNCHD_LABEL;
  delete env.OPENCLAW_SYSTEMD_UNIT;
  delete env.OPENCLAW_SERVICE_VERSION;

  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
  if (!env.OPENCLAW_STATE_DIR?.trim()) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (!env.OPENCLAW_CONFIG_PATH?.trim()) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (profile === "dev") {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
