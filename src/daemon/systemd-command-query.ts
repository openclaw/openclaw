/** Deadline- and custody-bound effective command queries for the systemd reader. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  findServiceOwnershipRefusal,
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { decodeLegacyBusctlOutput } from "./systemd-busctl-legacy.js";
import {
  bindSystemdManagerOwner,
  execBusctlSystem,
  execBusctlUser,
  systemdInspectionError,
} from "./systemd-exec.js";
import { openSystemdUserManager } from "./systemd-peer-native.js";
import { resolveUnavailableSystemdInspectionReason } from "./systemd-unavailable.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

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
  const scope = opts?.systemdReadTarget?.scope ?? "user";
  const peer = opts?.systemdReadBinding;
  if (
    peer &&
    (scope === "system" ||
      peer.unit !== unitName ||
      (inspection && peer.managerUid !== inspection.managerUid))
  ) {
    throw new ServiceOwnershipRefusalError("systemd-manager-changed");
  }
  if (scope === "system" && inspection && inspection.managerUid !== 0) {
    throw new ServiceOwnershipRefusalError("systemd-manager-changed");
  }
  const transport =
    peer || scope === "system"
      ? undefined
      : await resolveSystemdUserTransport(
          env,
          deadlineAt,
          inspection?.assertReadCurrent ?? inspection?.assertCurrent,
          opts?.requireLoaded ? "admission" : "inspection",
        );
  if (transport?.kind === "private" && opts?.requireLoaded) {
    throw new ServiceInspectionError("systemd-user-bus-unavailable");
  }
  const managerPeer =
    !opts?.requireLoaded && transport?.kind === "private"
      ? await openSystemdUserManager(transport.address, deadlineAt).catch((error: unknown) => {
          assertGatewayServiceUpdateCurrent();
          const refusal = findServiceOwnershipRefusal(error);
          if (refusal) {
            throw refusal;
          }
          throw new ServiceInspectionError("systemd-user-bus-unavailable");
        })
      : undefined;
  const managerUid = scope === "system" ? 0 : inspection?.managerUid;
  let remainingCalls = managerUid !== undefined ? 6 : 3;
  let legacyOutput = false;
  // All manager D-Bus calls share one deadline so wedged reads reach local fallback promptly.
  const query = async (args: string[], signatures: string[]): Promise<unknown[] | null> => {
    if (managerPeer) {
      try {
        return await managerPeer.query(args, signatures, deadlineAt);
      } catch (error) {
        assertGatewayServiceUpdateCurrent();
        const refusal = findServiceOwnershipRefusal(error);
        if (refusal) {
          throw refusal;
        }
        if (error instanceof ServiceInspectionError) {
          throw error;
        }
        throw new ServiceInspectionError("systemd-user-bus-unavailable");
      }
    }
    const assertCurrent =
      (args[0] === "call" && args[4] === "LoadUnit" ? undefined : inspection?.assertReadCurrent) ??
      inspection?.assertCurrent;
    if (performance.now() >= deadlineAt) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    if (managerUid !== undefined && remainingCalls <= 0) {
      throw unavailable();
    }
    if (peer) {
      assertCurrent?.();
      const values = await peer.query(args, signatures, deadlineAt, inspection);
      assertCurrent?.();
      if (performance.now() >= deadlineAt) {
        throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
      }
      return values;
    }
    const callTimeout = Math.max(
      1,
      Math.floor((deadlineAt - performance.now()) / remainingCalls--),
    );
    const callDeadline = Math.min(deadlineAt, performance.now() + callTimeout);
    const exec = async (queryArgs: string[], budget: number) => {
      if (scope === "system") {
        assertCurrent?.();
        return await execBusctlSystem(queryArgs, budget);
      }
      return await execBusctlUser(env, queryArgs, budget, assertCurrent);
    };
    let result = await exec(
      [
        ...(legacyOutput ? [] : ["--json=short"]),
        ...(opts?.requireLoaded ? ["--auto-start=no"] : []),
        ...args,
      ],
      callTimeout,
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
        throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
      }
      legacyOutput = true;
      result = await exec(
        [...(opts?.requireLoaded ? ["--auto-start=no"] : []), ...args],
        remaining,
      );
      assertCurrent?.();
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
      assertCurrent?.();
      throw new ServiceInspectionError(reason);
    }
    if (performance.now() >= (legacyOutput ? callDeadline : deadlineAt)) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    if (legacyOutput && result.termination !== "exit") {
      throw systemdInspectionError(result, unavailable().message, scope);
    }
    if (managerUid !== undefined && result.termination !== "exit") {
      throw systemdInspectionError(result, unavailable().message, scope);
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
      throw systemdInspectionError(result, unavailable().message, scope);
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
    (managerUid !== undefined
      ? await bindSystemdManagerOwner(query, managerUid, unavailable)
      : undefined);
  const destination = binding?.destination ?? manager;
  return {
    query,
    binding,
    destination,
    close: async () => {
      await managerPeer?.close();
    },
  };
}
