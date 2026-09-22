import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateDesktopLaunchParams,
  validateDesktopObserveParams,
  validateDesktopReleaseParams,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateEnvironmentsListParams,
  validateEnvironmentsPrepareParams,
  validateEnvironmentsStatusParams,
  validateWorkerDesktopObserveParams,
  validateWorkerDesktopLaunchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { projectPairedDeviceNodeBindings } from "../../infra/device-pairing-node-state.js";
import { projectNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveDesktopObserveRequester } from "../desktop/observe-requester.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { createKnownNodeCatalog, listKnownNodes } from "../node-catalog.js";
import {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../node-command-policy.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import { readNodeSessionWithheldCommands, type NodeSession } from "../node-registry.js";
import { resolveWorkerPlacementCapabilities } from "../worker-environments/placement-capabilities.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import type { WorkerEnvironmentState } from "../worker-environments/state.js";
import { formatForLog } from "../ws-log.js";
import { respondDesktopLaunch, respondDesktopObserve } from "./environments.desktop.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const GATEWAY_ENVIRONMENT: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  platform: process.platform,
  sessionHost: true,
  trust: "persistent",
  capabilities: ["agent.run", "sessions", "tools", "workspace"],
};
const WORKER_STATUS: Record<WorkerEnvironmentState, EnvironmentSummary["status"]> = {
  requested: "starting",
  provisioning: "starting",
  bootstrapping: "starting",
  ready: "available",
  attached: "available",
  idle: "available",
  draining: "stopping",
  destroying: "stopping",
  destroyed: "unavailable",
  failed: "error",
  orphaned: "error",
};
function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}
function summarizeNodeEnvironment(
  node: NodeListNode,
  config: Parameters<typeof resolveNodeCommandAllowlist>[0],
  requiredCommands: readonly string[],
  liveNode: NodeSession | undefined,
): EnvironmentSummary {
  // Expose both declared capabilities and command names so older node
  // runtimes still advertise useful execution surfaces in one stable list.
  const capabilities = uniqueSortedStrings(node.caps, node.commands);
  const platform = node.platform?.trim();
  const allowlist =
    node.connected === true
      ? resolveNodeCommandAllowlist(config, {
          platform: node.platform,
          deviceFamily: node.deviceFamily,
          commands: node.commands,
          approvedCommands: node.commands,
        })
      : undefined;
  const invocableCommands = allowlist
    ? uniqueSortedStrings(node.commands)
        .filter(
          (command) =>
            command.length <= 128 &&
            isNodeCommandAllowed({ command, declaredCommands: node.commands, allowlist }).ok,
        )
        .slice(0, 128)
    : [];
  const desktop = invocableCommands.includes(NODE_DESKTOP_STREAM_COMMAND);
  const requiredNodeCommand =
    allowlist && liveNode
      ? resolveRequiredNodeCommandAuthority({
          requiredCommands,
          declaredCommands: liveNode.declaredCommands,
          effectiveCommands: liveNode.commands,
          withheldCommands: readNodeSessionWithheldCommands(liveNode),
          allowlist,
        })
      : undefined;
  return {
    id: `node:${node.nodeId}`,
    type: "node",
    label: node.displayName ?? node.nodeId,
    status: node.connected ? "available" : "unavailable",
    ...(platform ? { platform } : {}),
    sessionHost: node.sessionHost === true,
    ...(node.workerSlots ? { workerSlots: { ...node.workerSlots } } : {}),
    ...(node.workerBundle ? { workerBundle: structuredClone(node.workerBundle) } : {}),
    ...(node.lastConnectedAtMs !== undefined ? { lastConnectedAtMs: node.lastConnectedAtMs } : {}),
    ...(node.lastDisconnectedAtMs !== undefined
      ? { lastDisconnectedAtMs: node.lastDisconnectedAtMs }
      : {}),
    ...(node.lastSeenAtMs !== undefined ? { lastSeenAtMs: node.lastSeenAtMs } : {}),
    ...(node.lastSeenReason ? { lastSeenReason: node.lastSeenReason } : {}),
    trust: "persistent",
    ...(desktop ? { desktop: true } : {}),
    ...(liveNode?.desktopAvailability
      ? { desktopAvailability: { ...liveNode.desktopAvailability } }
      : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(invocableCommands.length > 0 ? { invocableCommands } : {}),
    ...(requiredNodeCommand ? { requiredNodeCommand } : {}),
    ...(node.issues?.length ? { issues: [...node.issues] } : {}),
  };
}
/** Projects a durable worker row without exposing its SSH credential reference. */
export function summarizeWorkerEnvironment(
  record: WorkerEnvironmentServiceRecord,
  now = Date.now(),
): EnvironmentSummary {
  return {
    id: record.environmentId,
    type: "worker",
    status: WORKER_STATUS[record.state],
    ...(record.sharedHost === null
      ? {}
      : { trust: record.sharedHost ? "persistent" : "disposable" }),
    ...(record.desktopAvailable ? { desktop: true } : {}),
    ...(record.preparation
      ? { preparation: { purpose: record.preparation.purpose, key: record.preparation.key } }
      : {}),
    worker: {
      profileId: record.profileId,
      providerId: record.providerId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}),
      state: record.state,
      ageMs: Math.max(0, Math.trunc(now - record.createdAtMs)),
      ...(record.state === "idle" && record.idleSinceAtMs !== null
        ? { idleMs: Math.max(0, Math.trunc(now - record.idleSinceAtMs)) }
        : {}),
      attachedSessionIds: uniqueSortedStrings(record.attachedSessionIds),
      tunnelStatus: record.tunnelStatus,
      ...((record.state === "failed" || record.state === "orphaned") && record.error
        ? { error: record.error }
        : {}),
      ...(record.desktopAvailable ? { desktop: true } : {}),
      ...(record.desktopApps.length > 0 ? { desktopApps: [...record.desktopApps] } : {}),
    },
  };
}
export async function listGatewayEnvironments(
  context: GatewayRequestContext,
  workers = listWorkerEnvironments(context),
  runtimeId?: string,
): Promise<EnvironmentSummary[]> {
  const devices = await listDevicePairing();
  const nodes = projectNodePairing(devices.paired);
  // Orphaned or failed rows that retain a node binding still own its pairing role.
  // Only destroyed proves enrollment retirement; teardown-failed rows clear nodeDeviceId.
  const managedCloudNodeIds = new Set(
    workers.flatMap((environment) =>
      environment.providerId !== "device" &&
      environment.nodeDeviceId &&
      environment.state !== "destroyed"
        ? [environment.nodeDeviceId]
        : [],
    ),
  );
  const visibleDevices = devices.paired.filter(
    (device) => !managedCloudNodeIds.has(device.deviceId),
  );
  const connectedNodes = context.nodeRegistry.listConnectedForPairingStates(
    projectPairedDeviceNodeBindings(visibleDevices),
  );
  const runtimeState = collectNodeCatalogRuntimeState(context.nodeRegistry, connectedNodes);
  const connectedNodesById = new Map(connectedNodes.map((node) => [node.nodeId, node]));
  const requiredCommands = runtimeId
    ? (resolveWorkerPlacementCapabilities(runtimeId).devicePlacement?.requiredNodeCommands ?? [])
    : [];
  const catalog = createKnownNodeCatalog({
    pairedDevices: visibleDevices,
    pairedNodes: nodes.paired.filter((node) => !managedCloudNodeIds.has(node.nodeId)),
    connectedNodes: connectedNodes.filter((node) => !managedCloudNodeIds.has(node.nodeId)),
    ...runtimeState,
  });
  const config = context.getRuntimeConfig();
  const gateway =
    config.desktop?.host?.enabled === true
      ? { ...GATEWAY_ENVIRONMENT, desktop: true }
      : GATEWAY_ENVIRONMENT;
  return [
    gateway,
    ...listKnownNodes(catalog).map((node) =>
      summarizeNodeEnvironment(node, config, requiredCommands, connectedNodesById.get(node.nodeId)),
    ),
  ];
}
function listWorkerEnvironments(context: GatewayRequestContext): WorkerEnvironmentServiceRecord[] {
  try {
    return context.workerEnvironmentService?.list() ?? [];
  } catch {
    throw new Error("environment inventory unavailable");
  }
}
export function listWorkerProfiles(context: GatewayRequestContext) {
  if (!context.workerEnvironmentService || !context.workerPlacementDispatchService) {
    return [];
  }
  const profiles = context.getRuntimeConfig().cloudWorkers?.profiles ?? {};
  return Object.entries(profiles)
    .flatMap(([id, profile]) => {
      const providerId = typeof profile.provider === "string" ? profile.provider.trim() : "";
      return id.trim() && providerId ? [{ id: id.trim(), providerId }] : [];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
async function listWorkerProfilesWithMachines(context: GatewayRequestContext) {
  const summaries = listWorkerProfiles(context);
  return await Promise.all(
    summaries.map(async (summary) => {
      const executionModes = (["worker-turn", "remote-exec"] as const).filter(
        (mode) =>
          context.workerEnvironmentService?.supportsExecutionMode(summary.id, mode) === true,
      );
      const executionMode = executionModes[0];
      const resolvedSummary = Object.assign(
        summary,
        executionMode ? { executionMode, executionModes } : {},
      );
      try {
        const [options, operatingSystems] = await Promise.all([
          context.workerEnvironmentService?.listMachineOptions?.(summary.id),
          context.workerEnvironmentService?.listOperatingSystems?.(summary.id),
        ]);
        const machines = options ?? [];
        return Object.assign(
          resolvedSummary,
          machines.length > 0 ? { machines } : {},
          operatingSystems && operatingSystems.length > 1 ? { operatingSystems } : {},
        );
      } catch (error) {
        context.logGateway.warn(
          `worker machine catalog unavailable (${summary.id}): ${formatForLog(error)}`,
        );
        return resolvedSummary;
      }
    }),
  );
}
async function respondWorkerMutation(
  respond: RespondFn,
  run: () => Promise<WorkerEnvironmentServiceRecord>,
  invalidCodes: readonly string[],
  unavailableMessage: string,
) {
  try {
    respond(true, summarizeWorkerEnvironment(await run()), undefined);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid = typeof code === "string" && invalidCodes.includes(code);
    const message = invalid && error instanceof Error ? error.message : unavailableMessage;
    respond(
      false,
      undefined,
      errorShape(invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, message),
    );
  }
}

export const environmentsHandlers: GatewayRequestHandlers = {
  "environments.list": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateEnvironmentsListParams, "environments.list", respond)) {
      return;
    }
    if (params.runtimeId) {
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      const access = authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, scopes);
      if (!access.allowed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, `missing scope: ${access.missingScope}`),
        );
        return;
      }
    }
    await respondUnavailableOnThrow(respond, async () => {
      const workers = listWorkerEnvironments(context);
      const environments = await listGatewayEnvironments(context, workers, params.runtimeId);
      const summarizedAtMs = Date.now();
      environments.push(
        ...workers.map((record) => summarizeWorkerEnvironment(record, summarizedAtMs)),
      );
      const profiles = await listWorkerProfilesWithMachines(context);
      respond(true, { environments, ...(profiles.length > 0 ? { profiles } : {}) }, undefined);
    });
  },
  "environments.status": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateEnvironmentsStatusParams, "environments.status", respond)
    ) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const environment = (await listGatewayEnvironments(context)).find(
        (entry) => entry.id === params.environmentId,
      );
      if (environment) {
        respond(true, environment, undefined);
        return;
      }
      let worker: WorkerEnvironmentServiceRecord | undefined;
      try {
        worker = context.workerEnvironmentService?.get(params.environmentId);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "environment status unavailable"),
        );
        return;
      }
      respond(
        Boolean(worker),
        worker ? summarizeWorkerEnvironment(worker) : undefined,
        worker ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
      );
    });
  },
  "environments.create": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateEnvironmentsCreateParams, "environments.create", respond)
    ) {
      return;
    }
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cloud worker environments are not configured"),
      );
      return;
    }
    await respondWorkerMutation(
      respond,
      () => service.create(params.profileId, params.idempotencyKey),
      ["profile_not_found", "invalid_profile"],
      "worker environment creation failed",
    );
  },
  "environments.prepare": async ({ params, respond, context, hasCurrentClientAuthority }) => {
    if (
      !assertValidParams(params, validateEnvironmentsPrepareParams, "environments.prepare", respond)
    ) {
      return;
    }
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cloud worker environments are not configured"),
      );
      return;
    }
    try {
      respond(
        true,
        await service.prepare(params, () => {
          if (hasCurrentClientAuthority?.() === false) {
            throw new Error("Worker preparation caller authority was revoked");
          }
        }),
        undefined,
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const invalid =
        code === "profile_not_found" || code === "invalid_profile" || code === "invalid_project";
      const known = invalid || code === "capacity";
      respond(
        false,
        undefined,
        errorShape(
          invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          known && error instanceof Error ? error.message : "worker environment preparation failed",
          known ? { details: { code } } : undefined,
        ),
      );
    }
  },
  "environments.destroy": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateEnvironmentsDestroyParams, "environments.destroy", respond)
    ) {
      return;
    }
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"));
      return;
    }
    await respondWorkerMutation(
      respond,
      async () => {
        const placementService = context.workerPlacementDispatchService;
        if (params.force && !placementService?.forceDestroyEnvironment) {
          throw new Error("cloud worker placement control is unavailable");
        }
        const destroyed = params.force
          ? await placementService!.forceDestroyEnvironment!(params.environmentId, (error) => {
              context.logGateway.warn(
                `worker environment forced teardown cleanup failed: ${formatForLog(error)}`,
              );
            })
          : await service.destroyUnattached(params.environmentId);
        // Destruction is authoritative. Project the dead worker into its owning
        // placement before returning, or immediate session deletion stays fenced.
        try {
          await context.workerPlacementDispatchService?.reconcileActive?.(params.environmentId);
        } catch (error) {
          // The provider mutation has committed. Keep its success authoritative;
          // the periodic recovery sweep will retry this projection.
          context.logGateway.warn(
            `worker placement reconciliation after destroy failed: ${formatForLog(error)}`,
          );
        }
        return destroyed;
      },
      ["environment_not_found", "invalid_state"],
      "worker environment destruction failed",
    );
  },
  "worker.desktop.observe": async ({
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
  }) => {
    if (
      !assertValidParams(
        params,
        validateWorkerDesktopObserveParams,
        "worker.desktop.observe",
        respond,
      )
    ) {
      return;
    }
    await respondDesktopObserve({
      request: {
        source: { kind: "environment", environmentId: params.environmentId },
        ...(params.control === undefined ? {} : { control: params.control }),
      },
      respond,
      context,
      requester: resolveDesktopObserveRequester({ client, hasCurrentClientAuthority }),
    });
  },
  "worker.desktop.launch": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateWorkerDesktopLaunchParams,
        "worker.desktop.launch",
        respond,
      )
    ) {
      return;
    }
    await respondDesktopLaunch({
      environmentId: params.environmentId,
      app: params.app,
      respond,
      context,
    });
  },
  "desktop.observe": async ({ params, respond, context, client, hasCurrentClientAuthority }) => {
    if (!assertValidParams(params, validateDesktopObserveParams, "desktop.observe", respond)) {
      return;
    }
    await respondDesktopObserve({
      request: params,
      respond,
      context,
      requester: resolveDesktopObserveRequester({ client, hasCurrentClientAuthority }),
    });
  },
  "desktop.launch": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateDesktopLaunchParams, "desktop.launch", respond)) {
      return;
    }
    await respondDesktopLaunch({
      environmentId: params.source.environmentId,
      app: params.app,
      respond,
      context,
    });
  },
  "desktop.release": async ({ params, respond, client, hasCurrentClientAuthority }) => {
    if (!assertValidParams(params, validateDesktopReleaseParams, "desktop.release", respond)) {
      return;
    }
    const { releaseDesktopObserverToken } = await import("../desktop/observe-bridge.js");
    await respondUnavailableOnThrow(respond, async () => {
      const released = await releaseDesktopObserverToken(
        params.wsPath,
        resolveDesktopObserveRequester({ client, hasCurrentClientAuthority }),
      );
      respond(true, { released }, undefined);
    });
  },
};
