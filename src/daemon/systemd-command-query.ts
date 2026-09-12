/** Deadline- and custody-bound effective command queries for the systemd reader. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "./service-types.js";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";
import { bindSystemdManagerOwner, execBusctlUser, systemdInspectionError } from "./systemd-exec.js";

export async function createSystemdCommandQuery(
  env: GatewayServiceEnv,
  unitName: string,
  opts: GatewayServiceReadOptions | undefined,
  unavailable: () => Error,
) {
  const manager = "org.freedesktop.systemd1";
  const SYSTEMD_MANAGER_QUERY_TIMEOUT_MS = 5_000;
  const timeoutMs =
    opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : SYSTEMD_MANAGER_QUERY_TIMEOUT_MS;
  const deadlineAt = performance.now() + timeoutMs;
  const inspection = opts?.requireLoaded ? opts.loadForInspection : undefined;
  const peer = opts?.systemdReadBinding;
  if (
    peer &&
    (peer.unit !== unitName || (inspection && peer.managerUid !== inspection.managerUid))
  ) {
    throw unavailable();
  }
  let remainingCalls = inspection ? 6 : 3;
  let legacyOutput = false;
  // All manager D-Bus calls share one deadline so wedged reads reach local fallback promptly.
  const query = async (args: string[], signatures: string[]): Promise<unknown[] | null> => {
    const assertCurrent =
      (args[0] === "call" && args[4] === "LoadUnit" ? undefined : inspection?.assertReadCurrent) ??
      inspection?.assertCurrent;
    if (inspection && (performance.now() >= deadlineAt || remainingCalls <= 0)) {
      throw unavailable();
    }
    if (peer) {
      assertCurrent?.();
      const values = await peer.query(args, signatures, deadlineAt, inspection);
      assertCurrent?.();
      if (performance.now() >= deadlineAt) {
        throw unavailable();
      }
      return values;
    }
    const callTimeout = Math.max(
      1,
      Math.floor((deadlineAt - performance.now()) / remainingCalls--),
    );
    const callDeadline = Math.min(deadlineAt, performance.now() + callTimeout);
    let result = await execBusctlUser(
      env,
      [
        ...(legacyOutput ? [] : ["--json=short"]),
        ...(opts?.requireLoaded ? ["--auto-start=no"] : []),
        ...args,
      ],
      callTimeout,
      assertCurrent,
    );
    assertCurrent?.();
    if (
      !legacyOutput &&
      result.termination === "exit" &&
      result.code === 1 &&
      result.stdout === "" &&
      result.stderr.trim() === "busctl: unrecognized option '--json=short'"
    ) {
      // Option parsing failed before a manager call. Reuse this call's remaining
      // budget; neither the retry nor later legacy calls earn a new deadline.
      const remaining = Math.floor(callDeadline - performance.now());
      if (remaining <= 0) {
        throw unavailable();
      }
      legacyOutput = true;
      result = await execBusctlUser(
        env,
        [...(opts?.requireLoaded ? ["--auto-start=no"] : []), ...args],
        remaining,
        assertCurrent,
      );
      assertCurrent?.();
    }
    if (legacyOutput && (result.termination !== "exit" || performance.now() >= callDeadline)) {
      throw systemdInspectionError(result, unavailable().message);
    }
    if (inspection && (result.termination !== "exit" || performance.now() >= deadlineAt)) {
      throw systemdInspectionError(result, unavailable().message);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim();
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
      throw systemdInspectionError(result, unavailable().message);
    }
    if (legacyOutput) {
      return decodeLegacyBusctlOutput(result.stdout, signatures, args[0] === "call");
    }
    const properties = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => asOptionalRecord(JSON.parse(line)));
    if (
      properties.length !== signatures.length ||
      !properties.every((property, index) => property?.type === signatures[index])
    ) {
      throw unavailable();
    }
    return properties.map((property) => property?.data);
  };
  const binding =
    peer ??
    (inspection
      ? await bindSystemdManagerOwner(query, inspection.managerUid, unavailable)
      : undefined);
  const destination = binding?.destination ?? manager;
  return { query, binding, destination };
}
