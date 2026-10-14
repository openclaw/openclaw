import { formatErrorMessage } from "../infra/errors.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { isTerminalInteractive } from "./terminal-interactivity.js";

type InvalidConfigRecoveryResult<T> =
  | { status: "declined" }
  | { status: "recovered"; value: T }
  | { status: "retry-failed" };

/** Offer a consent-gated doctor repair, then retry the failed operation once. */
export async function offerInvalidConfigRecovery<T>(params: {
  runtime: RuntimeEnv;
  retry: () => Promise<T>;
}): Promise<InvalidConfigRecoveryResult<T>> {
  const command = formatCliCommand("openclaw doctor --fix");
  const printCommand = () => {
    params.runtime.error(`Run "${command}" to repair the config, then retry.`);
  };
  if (!isTerminalInteractive()) {
    printCommand();
    return { status: "declined" };
  }

  const { promptYesNo } = await import("./prompt.js");
  if (!(await promptYesNo(`Run "${command}" now?`, true))) {
    printCommand();
    return { status: "declined" };
  }

  try {
    const { doctorCommand } = await import("../commands/doctor.js");
    await doctorCommand(params.runtime, { repair: true });
  } catch (error) {
    if (error instanceof ExitError) {
      throw error;
    }
    params.runtime.error(`Failed to run "${command}": ${formatErrorMessage(error)}`);
    return { status: "retry-failed" };
  }

  try {
    return { status: "recovered", value: await params.retry() };
  } catch (error) {
    const { isInvalidConfigError } = await import("../config/io.invalid-config.js");
    if (!isInvalidConfigError(error)) {
      throw error;
    }
    params.runtime.error(`Config is still invalid after "${command}":`);
    params.runtime.error(formatErrorMessage(error));
    return { status: "retry-failed" };
  }
}
