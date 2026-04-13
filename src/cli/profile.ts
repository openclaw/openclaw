import os from "node:os";
import path from "node:path";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { isValueToken } from "../infra/cli-root-options.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName } from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

const OPENCLAW_MANAGED_LAUNCHD_LABEL_PREFIX = "ai.openclaw.";

function isCommandLocalProfileOption(out: string[]): boolean {
  const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
  return primary === "qa" && secondary === "matrix";
}

function isOpenClawManagedLaunchdLabel(label: string): boolean {
  return label.startsWith(OPENCLAW_MANAGED_LAUNCHD_LABEL_PREFIX);
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  let profile: string | null = null;
  let sawDev = false;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index, out }) => {
    if (arg === "--dev") {
      if (resolveCliArgvInvocation(out).primary === "gateway") {
        out.push(arg);
        return { kind: "handled" };
      }
      if (profile && profile !== "dev") {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      return { kind: "handled" };
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (isCommandLocalProfileOption(out)) {
        out.push(arg);
        if (arg === "--profile" && isValueToken(args[index + 1])) {
          out.push(args[index + 1]);
          return { kind: "handled", consumedNext: true };
        }
        return { kind: "handled" };
      }
      if (sawDev) {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          kind: "error",
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, profile, argv: scanned.argv };
}

function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
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

  // Clear stale OpenClaw-managed labels so launchd re-derives from OPENCLAW_PROFILE.
  // Custom operator labels remain explicit overrides.
  const inheritedLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  const profileLabel = resolveGatewayLaunchAgentLabel(profile);
  if (
    inheritedLabel &&
    inheritedLabel !== profileLabel &&
    isOpenClawManagedLaunchdLabel(inheritedLabel)
  ) {
    delete env.OPENCLAW_LAUNCHD_LABEL;
  }

  const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const stateDir = existingStateDir || resolveProfileStateDir(profile, env, homedir);
  if (!existingStateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (!normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
