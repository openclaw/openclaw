import path from "node:path";
import {
  consumeRootCommandOptionToken,
  getCommandArgsWithRootOptions,
} from "../infra/cli-root-options.js";
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
    invocation.commandPath[1] === "admit"
  );
}

/** Reject inherited update authority before general CLI startup can write diagnostics. */
export async function tryRunUpdateAdmissionBeforeStartup(
  invocation: ReturnType<typeof resolveCliArgvInvocation>,
): Promise<boolean> {
  if (!isUpdateAdmissionInvocation(invocation)) {
    return false;
  }
  const reject = (message: string) => {
    console.error(message);
    process.exitCode = 2;
    return true;
  };
  const profile = parseCliProfileArgs(invocation.argv);
  if (!profile.ok) {
    return reject(profile.error);
  }
  const args = getCommandArgsWithRootOptions(profile.argv, {
    commandPath: ["update", "admit"],
    mode: "command-path",
  });
  let contextPath: string | undefined;
  if (args) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const rootConsumed = consumeRootCommandOptionToken(args, index);
      if (rootConsumed > 0) {
        index += rootConsumed - 1;
      } else if (contextPath === undefined && arg === "--context") {
        contextPath = args[++index];
      } else if (contextPath === undefined && arg?.startsWith("--context=")) {
        contextPath = arg.slice("--context=".length);
      } else {
        return reject(
          "Candidate admission requires only --context <absolute-path> and root options.",
        );
      }
    }
  }
  if (!args || !contextPath || !path.isAbsolute(contextPath)) {
    return reject("Candidate admission requires --context <absolute-path>.");
  }
  const { isUpdateAdmissionAuthorityEnvKey } =
    await import("../infra/update-admission-contract.js");
  if (Object.keys(process.env).some(isUpdateAdmissionAuthorityEnvKey)) {
    return reject("Candidate admission requires an authority-free supervisor invocation.");
  }
  if (profile.profile) {
    applyCliProfileEnv({ profile: profile.profile });
  }
  const { updateAdmitCommand } = await import("./update-cli/update-command-admit.js");
  await updateAdmitCommand(contextPath);
  return true;
}
