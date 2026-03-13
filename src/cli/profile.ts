import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isValidProfileName } from "./profile-utils.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

export type EffectiveCliProfileResult =
  | { ok: true; profile: string | null }
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

const ARBITRARY_ARG_COMMAND_PATHS = [["nodes", "run"], ["docs"], ["acp", "client"]] as const;
const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level"]);

function isRootOptionValueToken(arg: string | undefined): boolean {
  if (!arg || arg === "--") {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

function shouldGuardTrailingArgsFromProfileParsing(args: string[]): boolean {
  const commandTokens: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--") {
      break;
    }

    if (ROOT_BOOLEAN_FLAGS.has(arg)) {
      continue;
    }

    if (arg.startsWith("--profile=") || arg.startsWith("--log-level=")) {
      continue;
    }

    if (ROOT_VALUE_FLAGS.has(arg)) {
      const next = args[i + 1];
      if (isRootOptionValueToken(next)) {
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    commandTokens.push(arg);

    if (
      ARBITRARY_ARG_COMMAND_PATHS.some(
        (commandPath) =>
          commandPath.length === commandTokens.length &&
          commandPath.every((part, idx) => part === commandTokens[idx]),
      )
    ) {
      return true;
    }

    const couldStillMatch = ARBITRARY_ARG_COMMAND_PATHS.some(
      (commandPath) =>
        commandTokens.length <= commandPath.length &&
        commandTokens.every((part, idx) => commandPath[idx] === part),
    );
    if (!couldStillMatch) {
      return false;
    }
  }

  return false;
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;
  let sawTerminator = false;

  const args = argv.slice(2);
  const guardTrailingArgs = shouldGuardTrailingArgsFromProfileParsing(args);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawTerminator) {
      out.push(arg);
      continue;
    }

    if (arg === "--") {
      sawTerminator = true;
      out.push(arg);
      continue;
    }

    if (arg === "--log-level" || arg.startsWith("--log-level=")) {
      out.push(arg);
      if (arg === "--log-level") {
        const next = args[i + 1];
        if (isRootOptionValueToken(next)) {
          out.push(next);
          i += 1;
        }
      }
      continue;
    }

    if (
      sawCommand &&
      (guardTrailingArgs || (arg !== "--profile" && !arg.startsWith("--profile=")))
    ) {
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

export function resolveEffectiveCliProfile(params: {
  parsedProfile: string | null;
  envProfile?: string;
}): EffectiveCliProfileResult {
  if (params.parsedProfile) {
    return { ok: true, profile: params.parsedProfile };
  }
  const envProfile = params.envProfile?.trim() || "";
  if (!envProfile) {
    return { ok: true, profile: null };
  }
  if (!isValidProfileName(envProfile)) {
    return {
      ok: false,
      error:
        'Invalid OPENCLAW_PROFILE (use letters, numbers, "_", "-" only, or unset the variable)',
    };
  }
  return { ok: true, profile: envProfile };
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
  env.OPENCLAW_PROFILE = profile;

  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
  if (!env.OPENCLAW_STATE_DIR?.trim()) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (!env.OPENCLAW_CONFIG_PATH?.trim()) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
