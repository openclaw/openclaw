import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { gatherDaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";
import { resolveDaemonServiceEnv } from "./systemd-scope.js";
import type { DaemonStatusOptions } from "./types.js";

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  if (opts.system && process.platform !== "linux") {
    defaultRuntime.error("--system is only supported on Linux.");
    defaultRuntime.exit(1);
    return;
  }

  const serviceEnv = resolveDaemonServiceEnv({ system: opts.system }) as NodeJS.ProcessEnv;
  try {
    const status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: Boolean(opts.probe),
      deep: Boolean(opts.deep),
      env: serviceEnv,
    });
    printDaemonStatus(status, { json: Boolean(opts.json) });
  } catch (err) {
    const rich = isRich();
    defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
    defaultRuntime.exit(1);
  }
}
