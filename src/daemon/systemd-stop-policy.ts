import { parseKeyValueOutput } from "./runtime-parse.js";
import { withServiceInspectionBudget } from "./service-inspection-budget.js";
import type { GatewayServiceState, SystemdServiceReadTarget } from "./service-types.js";
import { execSystemctl, execSystemctlUser } from "./systemd-exec.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import { parseSystemdTimeSpanMs } from "./systemd-time-span.js";

/** Read effective policy without granting permission to change it or stop the unit. */
export async function readSystemdGatewayStopTimeout(
  state: Pick<GatewayServiceState, "env" | "systemdInstallation">,
  target?: Pick<SystemdServiceReadTarget, "scope" | "unitName">,
) {
  const installation = state.systemdInstallation;
  target ??=
    installation?.kind === "system"
      ? installation.system
      : installation?.kind === "user" || installation?.kind === "dueling"
        ? installation.user
        : undefined;
  const unit = target?.unitName ?? `${resolveSystemdServiceName(state.env)}.service`;
  const args = ["show", unit, "--no-page", "--property", "LoadState,TimeoutStopUSec"];
  const result = await withServiceInspectionBudget(() =>
    target?.scope === "system"
      ? execSystemctl(args, state.env, 10_000)
      : execSystemctlUser(state.env, args, 10_000),
  );
  const properties = parseKeyValueOutput(result.stdout, "=");
  const timeout = parseSystemdTimeSpanMs(properties.timeoutstopusec ?? "");
  return result.code === 0 && properties.loadstate === "loaded" && timeout !== undefined
    ? timeout === 0
      ? Infinity
      : timeout
    : undefined;
}
