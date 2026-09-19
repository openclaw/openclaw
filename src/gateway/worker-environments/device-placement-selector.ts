import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../node-registry.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import { deviceUnavailableText } from "./device-provider.js";

type DevicePlacementSelection =
  | { ok: true; candidates: { deviceId: string; availableSlots: number }[] }
  | { ok: false; error: string };

export async function selectDevicePlacementCandidates(params: {
  environments: readonly EnvironmentSummary[];
  nodeRegistry: Pick<NodeRegistry, "get">;
  environmentService: object | undefined;
  requirement: DevicePlacementRequirement | undefined;
  runtimeId: string;
  executionMode: "worker-turn" | "remote-exec";
  config: OpenClawConfig;
  getPendingDispatchCount?: (deviceId: string) => number;
  getAdmittedSessionCounts?: () => ReadonlyMap<string, number> | undefined;
}): Promise<DevicePlacementSelection> {
  const { requirement } = params;
  if (!requirement) {
    return {
      ok: false,
      error: `runtime ${params.runtimeId} does not support paired-device placement; select a compatible runtime or cloud worker provider`,
    };
  }

  const nodes = params.environments
    .filter((environment) => environment.type === "node")
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const outdated = nodes.find((node) =>
    node.issues?.some((issue) => issue.code === "update-required"),
  );
  const outdatedError =
    outdated &&
    deviceUnavailableText(outdated.id.slice("node:".length), {
      available: false,
      issue: outdated.issues?.[0],
    });
  const hosts = nodes.filter((node) => node.sessionHost === true);
  if (hosts.length === 0) {
    return {
      ok: false,
      error:
        outdatedError ??
        "no paired session-host nodes are available; pair a node, enable session hosting, then retry",
    };
  }

  const connected = hosts.filter((node) => node.status === "available");
  if (connected.length === 0) {
    const deviceId = hosts[0]!.id.slice("node:".length);
    return {
      ok: false,
      error: `all paired session-host nodes are disconnected; ${deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "disconnected",
      })}`,
    };
  }

  const attempts = await Promise.all(
    connected
      .filter((node) => !node.issues?.some((issue) => issue.code === "update-required"))
      .map(async (node) => {
        const deviceId = node.id.slice("node:".length);
        const eligibility = await resolveDevicePlacementEligibility({
          environmentService: params.environmentService,
          deviceId,
          runtimeId: params.runtimeId,
          executionMode: params.executionMode,
          requirement,
          config: params.config,
          currentNode: params.nodeRegistry.get(deviceId),
        });
        return {
          deviceId,
          totalSlots: eligibility.ok ? eligibility.node.workerHost.capacity.total : 0,
          availableSlots: eligibility.ok
            ? Math.max(
                0,
                eligibility.availableSlots - (params.getPendingDispatchCount?.(deviceId) ?? 0),
              )
            : (node.workerSlots?.available ?? 0),
          eligibility,
        };
      }),
  );
  const admittedSessions = requirement.consumesWorkerSlot
    ? params.getAdmittedSessionCounts?.()
    : undefined;
  const candidates = attempts
    .filter(
      (attempt) =>
        attempt.eligibility.ok && (!requirement.consumesWorkerSlot || attempt.availableSlots > 0),
    )
    .toSorted(
      (left, right) =>
        // Admitted turns include work preparing its first physical launch. This is
        // a placement preference, never another physical-capacity reservation.
        (requirement.consumesWorkerSlot
          ? (admittedSessions?.get(left.deviceId) ?? 0) * right.totalSlots -
            (admittedSessions?.get(right.deviceId) ?? 0) * left.totalSlots
          : 0) ||
        (requirement.consumesWorkerSlot ? right.availableSlots - left.availableSlots : 0) ||
        left.deviceId.localeCompare(right.deviceId),
    )
    .map(({ deviceId, availableSlots }) => ({ deviceId, availableSlots }));

  if (candidates.length > 0) {
    return { ok: true, candidates };
  }
  if (attempts.length === 0 && outdatedError) {
    return { ok: false, error: outdatedError };
  }
  const updateRequired = attempts.find(({ eligibility }) => !eligibility.ok && eligibility.issue);
  if (updateRequired && !updateRequired.eligibility.ok) {
    return { ok: false, error: updateRequired.eligibility.error };
  }
  const atCapacity =
    requirement.consumesWorkerSlot && attempts.every(({ availableSlots }) => availableSlots === 0);
  if (atCapacity) {
    return {
      ok: false,
      error: `all paired session-host nodes are at capacity; ${deviceUnavailableText(
        attempts[0]!.deviceId,
        { available: false, unavailableReason: "at-capacity" },
      )}`,
    };
  }
  const failed = attempts.find(({ eligibility }) => !eligibility.ok);
  return {
    ok: false,
    error:
      failed && !failed.eligibility.ok
        ? failed.eligibility.error
        : "no paired session-host node supports this runtime; check node commands and reconnect an eligible host",
  };
}
