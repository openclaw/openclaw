import path from "node:path";
import {
  consumeRootCommandOptionToken,
  getCommandArgsWithRootOptions,
} from "../infra/cli-root-options.js";
import { normalizeFsSafeNativeEnv } from "../infra/fs-safe-env.js";
import type { resolveCliArgvInvocation } from "./argv-invocation.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

/** Only the internal command owns the early read-only boundary; help follows normal startup. */
export function isUpdateAdmissionInvocation(
  invocation: ReturnType<typeof resolveCliArgvInvocation>,
): boolean {
  return (
    !invocation.hasHelpOrVersion &&
    invocation.commandPath.length === 2 &&
    invocation.commandPath[0] === "update" &&
    ["admit", "preflight"].includes(invocation.commandPath[1] ?? "")
  );
}

/** Reject inherited update authority before general CLI startup can write diagnostics. */
export async function tryRunUpdateAdmissionBeforeStartup(
  invocation: ReturnType<typeof resolveCliArgvInvocation>,
): Promise<boolean> {
  if (!isUpdateAdmissionInvocation(invocation)) {
    return false;
  }
  // The supervisor parses stdout as one verdict; raised console levels must not prefix it.
  const { routeLogsToStderr } = await import("../logging/console.js");
  routeLogsToStderr();
  const preflight = invocation.commandPath[1] === "preflight";
  const reject = (message: string) => {
    console.error(message);
    if (preflight) {
      process.stdout.write(
        `${JSON.stringify({
          protocol: 1,
          mode: "preflight",
          coverage: "isolated-core-startup",
          candidateVersion: null,
          status: "unverified",
          reason: "preflight-execution-failed",
        })}\n`,
      );
    }
    process.exitCode = 2;
    return true;
  };
  const profile = parseCliProfileArgs(invocation.argv);
  if (!profile.ok) {
    return reject(profile.error);
  }
  const args = getCommandArgsWithRootOptions(profile.argv, {
    // Preserve the parent timeout together with the leaf arguments.
    commandPath: preflight ? ["update"] : invocation.commandPath,
    mode: "command-path",
  });
  let preflightLeafSeen = false;
  let contextPath: string | undefined;
  const preflightOptions: { sourceRoot?: string; timeout?: string } = {};
  if (args) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const rootConsumed = consumeRootCommandOptionToken(args, index);
      if (rootConsumed > 0) {
        index += rootConsumed - 1;
      } else if (preflight && !preflightLeafSeen && arg === "preflight") {
        preflightLeafSeen = true;
      } else if (preflight && arg === "--json") {
        continue;
      } else if (
        preflight &&
        (arg === "--timeout" || (preflightLeafSeen && arg === "--source-root"))
      ) {
        const value = args[++index];
        if (!value || value.startsWith("--")) {
          return reject(`Candidate preflight requires a value for ${arg}.`);
        }
        preflightOptions[arg === "--source-root" ? "sourceRoot" : "timeout"] = value;
      } else if (
        preflight &&
        ((preflightLeafSeen && arg?.startsWith("--source-root=")) || arg?.startsWith("--timeout="))
      ) {
        const separator = arg.indexOf("=");
        const value = arg.slice(separator + 1);
        if (!value) {
          return reject("Candidate preflight requires nonempty option values.");
        }
        preflightOptions[arg.startsWith("--source-root=") ? "sourceRoot" : "timeout"] = value;
      } else if (!preflight && contextPath === undefined && arg === "--context") {
        contextPath = args[++index];
      } else if (!preflight && contextPath === undefined && arg?.startsWith("--context=")) {
        contextPath = arg.slice("--context=".length);
      } else {
        return reject(
          preflight
            ? "Candidate preflight accepts only --json, --source-root, --timeout and root options."
            : "Candidate admission requires only --context <absolute-path> and root options.",
        );
      }
    }
  }
  if (!args || (preflight ? !preflightLeafSeen : !contextPath || !path.isAbsolute(contextPath))) {
    return reject(
      preflight
        ? "Candidate preflight arguments are invalid."
        : "Candidate admission requires --context <absolute-path>.",
    );
  }
  const { isUpdateAdmissionAuthorityEnvKey } =
    await import("../infra/update-admission-contract.js");
  if (Object.keys(process.env).some(isUpdateAdmissionAuthorityEnvKey)) {
    return reject("Candidate admission requires an authority-free supervisor invocation.");
  }
  if (profile.profile) {
    applyCliProfileEnv({ profile: profile.profile });
  }
  normalizeFsSafeNativeEnv();
  if (preflight) {
    const { updatePreflightCommand } = await import("./update-cli/update-command-preflight.js");
    await updatePreflightCommand(preflightOptions);
    return true;
  }
  const { updateAdmitCommand } = await import("./update-cli/update-command-admit.js");
  await updateAdmitCommand(contextPath);
  return true;
}
