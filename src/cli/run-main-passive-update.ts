import { rewriteUpdateFlagArgv } from "../infra/cli-root-options.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { resolveCliContainerTarget } from "./container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  isUpdateAdmissionInvocation,
  tryRunUpdateAdmissionBeforeStartup,
} from "./run-main-update-admission.js";

type Invocation = ReturnType<typeof resolveCliArgvInvocation>;

export function isPassiveUpdateInvocation(inputInvocation: Invocation): boolean {
  const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(inputInvocation.argv));
  return (
    isUpdateAdmissionInvocation(invocation) ||
    (invocation.commandPath.length === 2 &&
      invocation.commandPath[0] === "update" &&
      invocation.commandPath[1] === "plan")
  );
}

/** Passive planning must precede package lifecycle, runtime repair, and diagnostic writes. */
export async function tryRunPassiveUpdateBeforeStartup(
  inputInvocation: Invocation,
): Promise<boolean> {
  const invocation = resolveCliArgvInvocation(rewriteUpdateFlagArgv(inputInvocation.argv));
  if (isUpdateAdmissionInvocation(invocation)) {
    return tryRunUpdateAdmissionBeforeStartup(invocation);
  }
  if (!isPassiveUpdateInvocation(invocation)) {
    return false;
  }
  const profile = parseCliProfileArgs(invocation.argv);
  if (!profile.ok) {
    console.error(profile.error);
    process.exitCode = 2;
    return true;
  }
  let container: string | null;
  try {
    container = resolveCliContainerTarget(profile.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return true;
  }
  if (container) {
    console.error(
      "Passive update planning does not support container selection; run the planner inside that installation.",
    );
    process.exitCode = 2;
    return true;
  }
  if (profile.profile) {
    applyCliProfileEnv({ profile: profile.profile });
  }
  const [{ Command, CommanderError }, { registerUpdateCli }] = await Promise.all([
    import("commander"),
    import("./update-cli.js"),
  ]);
  // Reuse the public command grammar, but deliberately do not install startup preactions.
  const program = new Command()
    .name("openclaw")
    .option("--no-color", "Disable ANSI colors")
    .option("--log-level <level>", "Set diagnostic verbosity")
    .exitOverride();
  registerUpdateCli(program);
  try {
    await program.parseAsync(profile.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  return true;
}
