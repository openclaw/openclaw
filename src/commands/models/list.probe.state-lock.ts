import { formatCliCommand } from "../../cli/command-format.js";
import { ExpectedCliError } from "../../cli/expected-cli-error.js";
import { acquireEmbeddedStateLock } from "../../infra/embedded-state-lock.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";

export async function acquireAuthProbeStateLock(signal: AbortSignal) {
  try {
    return await acquireEmbeddedStateLock({
      signal,
      formatActiveGatewayRefusal: (identity) =>
        `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Stop the Gateway first (${formatCliCommand("openclaw gateway stop")}), then rerun models status --probe.`,
    });
  } catch (error) {
    if (!(error instanceof GatewayLockError)) {
      throw error;
    }
    throw new ExpectedCliError({
      message: error.message,
      humanOutput: `${error.message}\nFor a live provider check, run ${formatCliCommand('openclaw gateway call models.probe --params \'{"provider":"<provider>"}\' --json')}.`,
      machineOutput: error.message,
      cause: error,
    });
  }
}
