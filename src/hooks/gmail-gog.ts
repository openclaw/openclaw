import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveBrewExecutable } from "../infra/brew.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveGogServeInvocation } from "./gmail.js";

type GogTokenEnvSupport = "supported" | "unsupported" | "indeterminate";
export type GogInspection = { executable: string | undefined; support: GogTokenEnvSupport };
type GogOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal };
export type GogUpgrade = {
  eligible: true;
  brew: string;
  formula: string;
  executable: string;
};
export type GogUpgradeInspection = GogUpgrade | { eligible: false; reason: string };

const GOG_FORMULAE = new Set(["gogcli", "openclaw/tap/gogcli", "steipete/tap/gogcli"]);

function completeOutput(result: SpawnResult): boolean {
  if (result.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  return (
    result.code === 0 &&
    result.signal === null &&
    result.termination === "exit" &&
    !result.outputLimitExceeded &&
    !result.stdoutTruncatedBytes &&
    !result.stderrTruncatedBytes
  );
}

async function probeGogTokenEnv(
  executable: string,
  options: GogOptions = {},
): Promise<GogTokenEnvSupport> {
  const signal = resolveCommandProcessSignal(options.signal ?? getAsyncWorkSignal());
  signal?.throwIfAborted();
  try {
    const invocation = resolveGogServeInvocation(
      ["--json", "--no-input", "schema", "gmail", "watch", "serve"],
      executable,
    );
    const result = await runUtf8CommandWithTimeout([invocation.command, ...invocation.args], {
      timeoutMs: 5_000,
      env: options.env,
      signal,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      maxOutputBytes: { stdout: 256 * 1024, stderr: 16 * 1024 },
      maxCombinedOutputBytes: 272 * 1024,
      terminateOnOutputLimit: true,
    });
    signal?.throwIfAborted();
    if (!completeOutput(result)) {
      return "indeterminate";
    }
    const schema: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(schema) ||
      schema.schema_version !== 1 ||
      !isRecord(schema.command) ||
      schema.command.type !== "command" ||
      schema.command.name !== "serve" ||
      !Array.isArray(schema.command.flags)
    ) {
      return "indeterminate";
    }
    const flags = new Map<string, unknown>();
    for (const flag of schema.command.flags) {
      if (!isRecord(flag) || typeof flag.name !== "string" || flags.has(flag.name)) {
        return "indeterminate";
      }
      flags.set(flag.name, flag.type);
    }
    if (
      flags.get("token") !== "string" ||
      flags.get("hook-token") !== "string" ||
      ["token-env", "hook-token-env"].some(
        (name) => flags.has(name) && flags.get(name) !== "string",
      )
    ) {
      return "indeterminate";
    }
    return flags.has("token-env") && flags.has("hook-token-env") ? "supported" : "unsupported";
  } catch (error) {
    signal?.throwIfAborted();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // Diagnostics may contain local configuration. Only expose the check outcome.
    return "indeterminate";
  }
}

export async function inspectGog(options: GogOptions = {}): Promise<GogInspection> {
  const signal = resolveCommandProcessSignal(options.signal ?? getAsyncWorkSignal());
  signal?.throwIfAborted();
  const executable = resolveExecutablePath("gog", { env: options.env, useCache: false });
  return {
    executable,
    support: executable
      ? await probeGogTokenEnv(executable, { ...options, signal })
      : "indeterminate",
  };
}

async function inspectBrew(brew: string, args: string[], options: GogOptions): Promise<string> {
  const result = await runUtf8CommandWithTimeout([brew, ...args], {
    timeoutMs: 10_000,
    env: { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    signal: options.signal,
    maxOutputBytes: { stdout: 256 * 1024, stderr: 16 * 1024 },
    maxCombinedOutputBytes: 272 * 1024,
    terminateOnOutputLimit: true,
  });
  options.signal?.throwIfAborted();
  if (!completeOutput(result)) {
    throw new Error("Homebrew inspection did not complete.");
  }
  return result.stdout.trim();
}

export async function inspectGogUpgrade(
  inspection: GogInspection,
  options: GogOptions = {},
): Promise<GogUpgradeInspection> {
  const signal = resolveCommandProcessSignal(options.signal ?? getAsyncWorkSignal());
  signal?.throwIfAborted();
  if (!inspection.executable || process.platform === "win32") {
    return { eligible: false, reason: "Install or update Gog with its installation manager." };
  }
  const brew = resolveBrewExecutable();
  if (!brew) {
    return {
      eligible: false,
      reason: "Update Gog with its installation manager; Homebrew was not found.",
    };
  }
  const checkOptions = { ...options, signal };
  try {
    const installed = (await inspectBrew(brew, ["list", "--formula", "--full-name"], checkOptions))
      .split(/\r?\n/u)
      .filter((formula) => GOG_FORMULAE.has(formula));
    const formula = installed.length === 1 ? installed[0] : undefined;
    if (!formula) {
      return {
        eligible: false,
        reason:
          "Homebrew does not manage a supported Gog formula. Update Gog with its installation manager.",
      };
    }
    const pinned = await inspectBrew(brew, ["list", "--formula", "--pinned"], checkOptions);
    if (pinned.split(/\r?\n/u).some((name) => name === "gogcli" || name === formula)) {
      return {
        eligible: false,
        reason: "Gog is pinned in Homebrew. Review the pin and update Gog manually.",
      };
    }
    const rack = await inspectBrew(brew, ["--cellar", formula], checkOptions);
    const [realExecutable, realRack] = await Promise.all([
      fs.realpath(inspection.executable),
      fs.realpath(rack),
    ]);
    signal?.throwIfAborted();
    // Supported formulae install bin/gog. A receipt does not own a PATH
    // wrapper, custom build, or another file merely placed somewhere in the rack.
    const relative = path.relative(realRack, realExecutable).split(path.sep);
    if (
      relative.length !== 3 ||
      relative[0] === ".." ||
      relative[1] !== "bin" ||
      relative[2] !== "gog"
    ) {
      return {
        eligible: false,
        reason:
          "The selected Gog executable is not Homebrew's Gog binary. Update the selected installation or adjust PATH.",
      };
    }
    return { eligible: true, brew, formula, executable: inspection.executable };
  } catch (error) {
    signal?.throwIfAborted();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return {
      eligible: false,
      reason:
        "Could not verify Homebrew ownership and pins. Update Gog manually, then restart the Gmail watcher.",
    };
  }
}

export async function upgradeGog(
  approved: GogUpgrade,
  options: GogOptions = {},
): Promise<{ inspection: GogInspection; message: string }> {
  const signal = resolveCommandProcessSignal(options.signal ?? getAsyncWorkSignal());
  const commandOptions = { ...options, signal };
  let message =
    "Homebrew did not provide Gog with both token environment flags. Update Gog manually, then restart the Gmail watcher.";
  try {
    for (const args of [["update"], ["upgrade", approved.formula]]) {
      // Consent applies to this selected installation. Revalidate after prompts
      // and Homebrew metadata refresh rather than upgrading a shadowed binary.
      const inspection = await inspectGog(commandOptions);
      if (inspection.support === "supported") {
        return {
          inspection,
          message:
            "Gog supports secure token environment sources. Restart any existing Gmail watcher to use them.",
        };
      }
      const current = await inspectGogUpgrade(inspection, commandOptions);
      signal?.throwIfAborted();
      if (!current.eligible) {
        return { inspection, message: current.reason };
      }
      if (
        current.brew !== approved.brew ||
        current.formula !== approved.formula ||
        current.executable !== approved.executable
      ) {
        return {
          inspection,
          message: "The selected Gog installation changed. Review it before retrying the upgrade.",
        };
      }
      const result = await runUtf8CommandWithTimeout([current.brew, ...args], {
        timeoutMs: args[0] === "update" ? 300_000 : 900_000,
        env: { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
        signal,
        outputCapture: "discard",
        killProcessTree: true,
      });
      signal?.throwIfAborted();
      if (result.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      if (result.code !== 0 || result.termination !== "exit" || result.signal !== null) {
        message = `Homebrew ${args[0]} did not complete successfully. Check the selected Gog installation and retry, then restart the Gmail watcher.`;
        break;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    message =
      "The Gog upgrade failed. Check the selected installation and retry, then restart the Gmail watcher.";
  }
  // A failed package operation can still replace or remove the executable.
  // Reconcile the actual PATH selection instead of assuming success or rollback.
  const inspection = await inspectGog(commandOptions);
  if (inspection.support === "supported") {
    message =
      "Gog supports secure token environment sources. Restart any existing Gmail watcher to use them.";
  } else if (!inspection.executable) {
    message =
      "Gog is no longer available on PATH. Repair its installation before restarting the Gmail watcher.";
  }
  return { inspection, message };
}
