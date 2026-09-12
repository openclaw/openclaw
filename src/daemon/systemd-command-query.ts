/** Deadline- and custody-bound effective command queries for the systemd reader. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "./service-types.js";
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
    const result = await execBusctlUser(
      env,
      ["--json=short", ...(opts?.requireLoaded ? ["--auto-start=no"] : []), ...args],
      Math.max(1, Math.floor((deadlineAt - performance.now()) / remainingCalls--)),
      assertCurrent,
    );
    assertCurrent?.();
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
            detail === `Call failed: Unit file ${unitName} does not exist.`))
      ) {
        return null;
      }
      throw systemdInspectionError(result, unavailable().message);
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
