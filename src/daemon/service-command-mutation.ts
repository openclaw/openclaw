/** Reads effective current or former LaunchAgent ownership before a service mutation. */
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { readRelocatedLaunchAgentForInstall } from "./launchd-install.js";
import { remainingLaunchdPlistReadTimeout } from "./launchd-plist.js";
import {
  readExistingLaunchAgentPlist,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { findServiceOwnershipRefusal } from "./service-inspection-error.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
} from "./service-types.js";

type GatewayServiceCommandForMutation =
  | { kind: "current"; command: GatewayServiceCommandConfig }
  | { kind: "relocated"; command: GatewayServiceCommandConfig; plistPath: string }
  | { kind: "missing"; command: null };

/**
 * Authority-bearing pre-mutation ownership/routing read. On Darwin this includes a verified
 * pre-canonical LaunchAgent only when the canonical definition is absent.
 */
export async function readGatewayServiceCommandForMutation(
  service: {
    readCommand: (
      env: GatewayServiceEnv,
      opts?: GatewayServiceReadOptions,
    ) => Promise<GatewayServiceCommandConfig | null>;
  },
  env: GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandForMutation> {
  const deadline = opts?.timeoutMs === undefined ? undefined : performance.now() + opts.timeoutMs;
  let command: GatewayServiceCommandConfig | null = null;
  let commandReadError: Error | undefined;
  if (process.platform === "darwin" && opts?.requireEffective) {
    try {
      command = await service.readCommand(env, opts);
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      const refusal = findServiceOwnershipRefusal(error);
      if (refusal) {
        throw refusal;
      }
      // Strict launchd parsing rejects a missing canonical plist before a
      // pre-canonical definition can be inspected. Defer this error until a
      // verified relocation has had the only permitted chance to recover it.
      commandReadError =
        error instanceof Error
          ? error
          : new Error("The current LaunchAgent definition cannot be safely inspected.");
    }
  } else {
    command = await service.readCommand(env, opts);
  }
  if (command !== null) {
    return { kind: "current", command };
  }
  if (process.platform !== "darwin") {
    return { kind: "missing", command: null };
  }

  // The steady-state parser returns null for both ENOENT and read/parse failures.
  // A managed mutation must distinguish those cases before it can replace the definition.
  // A verified pre-canonical definition is considered only after the canonical
  // parser has no command and the canonical plist is confirmed absent.
  remainingLaunchdPlistReadTimeout(deadline);
  const canonicalPlistPath = resolveLaunchAgentPlistPath(env);
  if ((await readExistingLaunchAgentPlist(canonicalPlistPath)) !== null) {
    throw (
      commandReadError ??
      new Error("The current LaunchAgent definition cannot be safely inspected.")
    );
  }
  const relocated = await readRelocatedLaunchAgentForInstall(env, opts, deadline);
  if (relocated !== null) {
    return { kind: "relocated", ...relocated };
  }
  if (commandReadError) {
    throw commandReadError;
  }
  return { kind: "missing", command: null };
}
