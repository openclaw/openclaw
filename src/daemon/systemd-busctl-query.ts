/** Typed CLI transport shared by command inspection and native-off inventory. */
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  getServiceInspectionClock,
  runServiceInspectionGuard,
} from "./service-inspection-budget.js";
import { ServiceInspectionError, SystemdInspectionTimeout } from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { decodeSystemdBusProperties, type SystemdBusQuery } from "./systemd-bus-query.js";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";
import { execBusctlSystem, execBusctlUser, systemdInspectionError } from "./systemd-exec.js";
import { resolveUnavailableSystemdInspectionReason } from "./systemd-unavailable.js";

export function createSystemdBusctlQuery(options: {
  env: GatewayServiceEnv;
  scope: "user" | "system";
  deadline: number;
  calls: number;
  boundCalls: boolean;
  noAutoStart: boolean;
  unitName?: string;
  assertCurrent?: (args: string[]) => (() => void) | undefined;
  unavailable: () => Error;
}): SystemdBusQuery {
  const now = getServiceInspectionClock();
  const { scope, env, deadline, unavailable } = options;
  let remainingCalls = options.calls;
  let legacyOutput = false;
  return async (args, signatures) => {
    const assertCurrent = options.assertCurrent?.(args);
    const check = `busctl ${args.slice(0, 5).join(" ")}`;
    if (now() >= deadline) {
      throw new SystemdInspectionTimeout(check);
    }
    if (options.boundCalls && remainingCalls <= 0) {
      throw unavailable();
    }
    const callTimeout = Math.max(1, Math.floor((deadline - now()) / remainingCalls--));
    const callDeadline = Math.min(deadline, now() + callTimeout);
    const exec = async (queryArgs: string[], callBudget: number) => {
      if (scope === "system") {
        runServiceInspectionGuard(assertCurrent);
        return await execBusctlSystem(queryArgs, callBudget);
      }
      return await execBusctlUser(env, queryArgs, callBudget, assertCurrent);
    };
    let result = await exec(
      [
        ...(legacyOutput ? [] : ["--json=short"]),
        ...(options.noAutoStart ? ["--auto-start=no"] : []),
        ...args,
      ],
      callTimeout,
    );
    runServiceInspectionGuard(assertCurrent);
    if (
      !legacyOutput &&
      result.termination === "exit" &&
      result.code === 1 &&
      result.stdout === "" &&
      result.stderr.trim() === "busctl: unrecognized option '--json=short'"
    ) {
      // Option parsing failed before a manager call. Keep the original deadline.
      const remaining = Math.floor(callDeadline - now());
      if (remaining <= 0) {
        throw new SystemdInspectionTimeout(
          `busctl legacy-output negotiation for ${args.slice(0, 5).join(" ")}`,
        );
      }
      legacyOutput = true;
      result = await exec(
        [...(options.noAutoStart ? ["--auto-start=no"] : []), ...args],
        remaining,
      );
      runServiceInspectionGuard(assertCurrent);
    }
    if (result.termination === "error" && result.errorCode === "ENOENT") {
      const reason =
        scope === "system"
          ? await resolveUnavailableSystemdInspectionReason(
              "systemd-busctl-unavailable",
              process.env,
              callDeadline,
            )
          : "systemd-busctl-unavailable";
      runServiceInspectionGuard(assertCurrent);
      throw new ServiceInspectionError(reason);
    }
    if (now() >= (legacyOutput ? callDeadline : deadline)) {
      throw new SystemdInspectionTimeout(check);
    }
    if ((legacyOutput || options.boundCalls) && result.termination !== "exit") {
      throw systemdInspectionError(result, unavailable().message, scope);
    }
    if (result.code !== 0) {
      const unitName = options.unitName ?? args[6];
      // systemd 245 busctl colors this line even when stderr is not a terminal.
      const detail = stripAnsi(result.stderr).trim();
      if (
        result.termination === "exit" &&
        ((args.includes("LoadUnit") && detail === `Call failed: Unit ${unitName} not found.`) ||
          (args.includes("GetUnit") &&
            (detail === `Call failed: Unit ${unitName} not loaded.` ||
              detail === `Call failed: Unit ${unitName} not found.`)) ||
          (args.includes("GetUnitFileState") &&
            (detail === `Call failed: Unit file ${unitName} does not exist.` ||
              detail === "Call failed: No such file or directory")))
      ) {
        return null;
      }
      throw systemdInspectionError(result, unavailable().message, scope);
    }
    return legacyOutput
      ? decodeLegacyBusctlOutput(result.stdout, signatures, args[0] === "call")
      : decodeSystemdBusProperties(result.stdout, signatures, unavailable);
  };
}
