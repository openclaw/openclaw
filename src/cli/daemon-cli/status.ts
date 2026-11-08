import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import type { DaemonStatusOptions } from "./types.js";

function failDaemonStatus(opts: DaemonStatusOptions, message: string): void {
  if (opts.json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(colorize(isRich(), theme.error, message));
  }
  defaultRuntime.exit(1);
}

/** Run Gateway status diagnostics and apply --require-rpc exit behavior. */
export async function runDaemonStatus(opts: DaemonStatusOptions) {
  if (opts.runtimeIntentOnly && opts.requireRpc) {
    failDaemonStatus(
      opts,
      "Gateway status failed: --runtime-intent-only cannot be combined with --require-rpc.",
    );
    return;
  }
  if (opts.requireRpc && !opts.probe) {
    failDaemonStatus(
      opts,
      "Gateway status failed: --require-rpc needs checking enabled. Remove --no-probe or drop --require-rpc.",
    );
    return;
  }

  let status: Awaited<ReturnType<typeof gatherDaemonStatus>>;
  try {
    if (opts.runtimeIntentOnly) {
      const [{ readDaemonServiceStatus }, { projectDaemonRuntimeStatus }] = await Promise.all([
        import("./status.service.js"),
        import("./status.projection.js"),
      ]);
      const { service, state } = await readDaemonServiceStatus({ env: process.env });
      const projection = await projectDaemonRuntimeStatus({ deep: true, service, state });
      defaultRuntime.writeJson({ cli: projection.cli, service: projection.runtimeIntent });
      return;
    }
    const [{ gatherDaemonStatus }, { printDaemonStatus }] = await Promise.all([
      import("./status.gather.js"),
      import("./status.print.js"),
    ]);
    status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: opts.probe,
      requireRpc: opts.requireRpc,
      deep: opts.deep === true,
    });
    if (opts.deep && status.pluginVersionDrift) {
      const { resolvePluginVersionDriftTargets } =
        await import("../../plugins/plugin-version-drift.js");
      status.pluginVersionDrift = await resolvePluginVersionDriftTargets(status.pluginVersionDrift);
    }
    printDaemonStatus(status, { json: opts.json, deep: opts.deep === true });
  } catch (err) {
    failDaemonStatus(opts, `Gateway status failed: ${formatErrorMessage(err)}`);
    return;
  }

  if (opts.requireRpc && !status.rpc?.ok) {
    defaultRuntime.exit(1);
  }
}
