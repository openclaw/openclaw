import { formatErrorMessage } from "../infra/errors.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { isTerminalInteractive } from "./terminal-interactivity.js";

/** Offer a consent-gated doctor repair, then retry the failed operation once. */
export async function offerInvalidConfigRecovery(params: {
  runtime: RuntimeEnv;
  /** An unresolved database target permits only Doctor's file-backed config repair. */
  runDoctor?: () => Promise<void>;
  retry: () => Promise<void>;
}): Promise<boolean> {
  const command = formatCliCommand("openclaw doctor --fix");
  const printCommand = () => {
    params.runtime.error(`Run "${command}" to repair the config, then retry.`);
  };
  if (!isTerminalInteractive()) {
    printCommand();
    return false;
  }

  const { promptYesNo } = await import("./prompt.js");
  if (!(await promptYesNo(`Run "${command}" now?`, true))) {
    printCommand();
    return false;
  }

  try {
    if (params.runDoctor) {
      await params.runDoctor();
    } else {
      const { doctorCommand } = await import("../commands/doctor.js");
      await doctorCommand(params.runtime, { repair: true });
    }
  } catch (error) {
    if (error instanceof ExitError) {
      throw error;
    }
    params.runtime.error(`Failed to run "${command}": ${formatErrorMessage(error)}`);
    return false;
  }

  try {
    await params.retry();
    return true;
  } catch (error) {
    const { isInvalidConfigError } = await import("../config/io.invalid-config.js");
    if (!isInvalidConfigError(error)) {
      throw error;
    }
    params.runtime.error(`Config is still invalid after "${command}":`);
    params.runtime.error(formatErrorMessage(error));
    return false;
  }
}
