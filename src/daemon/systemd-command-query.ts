import {
  runServiceInspectionGuard,
  withServiceInspectionBudget,
} from "./service-inspection-budget.js";
/** Deadline- and custody-bound effective command queries for the systemd reader. */
import {
  findServiceOwnershipRefusal,
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
  SystemdInspectionTimeout,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { createSystemdBusctlQuery } from "./systemd-busctl-query.js";
import { bindSystemdManagerOwner } from "./systemd-exec.js";
import { openSystemdUserManager } from "./systemd-peer-native.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

export async function createSystemdCommandQuery(
  env: GatewayServiceEnv,
  unitName: string,
  opts: GatewayServiceReadOptions | undefined,
  unavailable: () => Error,
) {
  return await withServiceInspectionBudget(async (budget) => {
    const manager = "org.freedesktop.systemd1";
    const SYSTEMD_MANAGER_QUERY_TIMEOUT_MS = 5_000;
    const timeoutMs =
      opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : SYSTEMD_MANAGER_QUERY_TIMEOUT_MS;
    const deadlineAt = budget.now() + timeoutMs;
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
    const privateInspectionFailed = (error: unknown, preserveReason = false): never => {
      assertGatewayServiceUpdateCurrent();
      const refusal = findServiceOwnershipRefusal(error);
      if (refusal) {
        throw refusal;
      }
      if (preserveReason && error instanceof ServiceInspectionError) {
        throw error;
      }
      throw new ServiceInspectionError("systemd-user-bus-unavailable");
    };
    const managerPeer =
      !opts?.requireLoaded && transport?.kind === "private"
        ? await openSystemdUserManager(transport.address, deadlineAt).catch(privateInspectionFailed)
        : undefined;
    const managerUid = scope === "system" ? 0 : inspection?.managerUid;
    const cliQuery = createSystemdBusctlQuery({
      env,
      scope,
      deadline: deadlineAt,
      calls: managerUid !== undefined ? 6 : 3,
      boundCalls: managerUid !== undefined,
      noAutoStart: Boolean(opts?.requireLoaded),
      unitName,
      unavailable,
      assertCurrent: (args) =>
        (args[0] === "call" && args[4] === "LoadUnit"
          ? undefined
          : inspection?.assertReadCurrent) ?? inspection?.assertCurrent,
    });
    // All manager D-Bus calls share one deadline so wedged reads reach local fallback promptly.
    const query = async (args: string[], signatures: string[]): Promise<unknown[] | null> => {
      if (managerPeer) {
        try {
          return await managerPeer.query(args, signatures, deadlineAt);
        } catch (error) {
          privateInspectionFailed(error, true);
        }
      }
      const assertCurrent =
        (args[0] === "call" && args[4] === "LoadUnit"
          ? undefined
          : inspection?.assertReadCurrent) ?? inspection?.assertCurrent;
      const check = `effective command ${args[0] === "call" ? args[4] : args.slice(4).join(", ")}`;
      if (budget.now() >= deadlineAt) {
        throw new SystemdInspectionTimeout(check);
      }
      if (peer) {
        runServiceInspectionGuard(assertCurrent);
        const values = await peer.query(args, signatures, deadlineAt, inspection);
        runServiceInspectionGuard(assertCurrent);
        if (budget.now() >= deadlineAt) {
          throw new SystemdInspectionTimeout(check);
        }
        return values;
      }
      return await cliQuery(args, signatures);
    };
    const binding =
      peer ??
      (managerUid !== undefined
        ? await bindSystemdManagerOwner(query, managerUid, unavailable)
        : undefined);
    const destination = binding?.destination ?? manager;
    return {
      query: (args: string[], signatures: string[]) => budget.run(() => query(args, signatures)),
      binding: binding
        ? { ...binding, verify: () => budget.run(() => binding.verify()) }
        : undefined,
      destination,
      close: async () => {
        await managerPeer?.close();
      },
    };
  });
}
