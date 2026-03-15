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

  // Always override STATE_DIR and CONFIG_PATH when --profile is explicitly provided,
  // so inherited env vars from a running default gateway don't silently win (#28236).
  env.OPENCLAW_PROFILE = profile;
  const stateDir = resolveProfileStateDir(profile, env, homedir);
  env.OPENCLAW_STATE_DIR = stateDir;
  env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

  // GATEWAY_PORT is dev-only and intentionally not overridden when explicitly set.
  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
