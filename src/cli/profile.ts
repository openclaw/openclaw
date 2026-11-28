import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  isGatewayServiceEnv,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { getCommandPositionalsWithRootOptions } from "../infra/cli-root-options.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { splitBrowserPairCodeProfile } from "../shared/browser-pair.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { parseCliContainerArgs } from "./container-target.js";
import {
  isValidProfileName,
  resolveProfileGatewayPort,
  resolveProfileStateDir,
} from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

/**
 * `containerTarget` is for callers that already stripped `--container` from argv;
 * otherwise the target comes from argv and OPENCLAW_CONTAINER.
 */
export function parseCliProfileArgs(
  argv: string[],
  containerTarget?: string | null,
): { ok: true; profile: string | null; argv: string[] } | { ok: false; error: string } {
  // Root profile flags are stripped before Commander sees argv, except command-local cases.
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
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
      if (primary === "qa" && secondary === "matrix") {
        out.push(arg);
        if (consumedNext && next !== undefined) {
          out.push(next);
        }
        return { kind: "handled", consumedNext };
      }
      if (sawDev) {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
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
  const parsedContainer = containerTarget === undefined ? parseCliContainerArgs(argv) : null;
  const container =
    containerTarget ??
    (parsedContainer?.ok ? parsedContainer.container : null) ??
    normalizeOptionalString(process.env.OPENCLAW_CONTAINER);
  // A container target forwards argv to the CLI inside it, which routes the code there.
  return container
    ? { ok: true, profile, argv: scanned.argv }
    : selectPairCodeProfile(scanned.argv, profile);
}

/** `openclaw pair work:ABCD-EFGH` selects the issuing Gateway's profile before paths are pinned. */
function selectPairCodeProfile(
  argv: string[],
  profile: string | null,
): { ok: true; profile: string | null; argv: string[] } | { ok: false; error: string } {
  const [pairCode] =
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: ["pair"],
      booleanFlags: ["--yes", "--json", "--expect-final"],
      valueFlags: ["--url", "--port", "--token", "--password", "--timeout"],
      maxPositionals: 1,
      // Commander's reading: required values consume the next token, and `--` keeps operands.
      mode: "command-path",
    }) ?? [];
  const codeProfile = pairCode ? splitBrowserPairCodeProfile(pairCode).profile : null;
  if (codeProfile === null) {
    return { ok: true, profile, argv };
  }
  if (!isValidProfileName(codeProfile)) {
    return {
      ok: false,
      error: `The pairing code names an invalid profile "${codeProfile}". Copy the code shown in the browser again.`,
    };
  }
  if (profile && profile !== codeProfile) {
    return {
      ok: false,
      error: `This pairing code is for profile "${codeProfile}", but profile "${profile}" was selected. Drop --profile or use the matching one.`,
    };
  }
  return { ok: true, profile: codeProfile, argv };
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}) {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  const inheritedProfile = normalizeOptionalString(env.OPENCLAW_PROFILE) ?? "default";
  const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const existingConfigPath = normalizeOptionalString(env.OPENCLAW_CONFIG_PATH);
  const inheritedProfileStateDir = resolveProfileStateDir(inheritedProfile, env, homedir);
  const selectedProfileStateDir = resolveProfileStateDir(profile, env, homedir);
  const switchesInheritedProfile = inheritedProfileStateDir !== selectedProfileStateDir;
  const inheritedSystemdServiceName = resolveGatewaySystemdServiceName(inheritedProfile);
  const inheritedServiceSelectors = {
    OPENCLAW_LAUNCHD_LABEL: [resolveGatewayLaunchAgentLabel(inheritedProfile)],
    OPENCLAW_SYSTEMD_UNIT: [inheritedSystemdServiceName, `${inheritedSystemdServiceName}.service`],
    OPENCLAW_WINDOWS_TASK_NAME: [resolveGatewayWindowsTaskName(inheritedProfile)],
  };
  const switchesInheritedProfileState = Boolean(
    existingStateDir &&
    switchesInheritedProfile &&
    resolveHomeRelativePath(existingStateDir, {
      env,
      homedir,
    }) === inheritedProfileStateDir,
  );
  const replacesInheritedProfileConfig = Boolean(
    switchesInheritedProfile &&
    (!existingStateDir || switchesInheritedProfileState) &&
    existingConfigPath &&
    resolveHomeRelativePath(existingConfigPath, {
      env,
      homedir,
    }) === path.join(inheritedProfileStateDir, "openclaw.json"),
  );
  const inheritedManagedServiceSelectors =
    isGatewayServiceEnv(env) && switchesInheritedProfileState && replacesInheritedProfileConfig;

  if (inheritedManagedServiceSelectors) {
    for (const key of GATEWAY_SERVICE_SELECTOR_ENV_KEYS) {
      delete env[key];
    }
  }

  // A service's canonical profile paths are inherited defaults, not custom overrides.
  // Switch them together so an explicit profile cannot mutate the service's profile.
  env.OPENCLAW_PROFILE = profile;

  const stateDir =
    existingStateDir && !switchesInheritedProfileState ? existingStateDir : selectedProfileStateDir;
  if (!existingStateDir || switchesInheritedProfileState) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  if (
    !inheritedManagedServiceSelectors &&
    (!existingConfigPath || replacesInheritedProfileConfig)
  ) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  if (switchesInheritedProfile && !inheritedManagedServiceSelectors) {
    for (const [key, inheritedValues] of Object.entries(inheritedServiceSelectors)) {
      const activeValue = normalizeOptionalString(env[key]);
      if (activeValue && inheritedValues.includes(activeValue)) {
        delete env[key];
      }
    }
  }

  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = String(resolveProfileGatewayPort(profile));
  }
}
