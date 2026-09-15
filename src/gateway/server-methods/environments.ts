import {
  type DesktopObserveParams,
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateDesktopLaunchParams,
  validateDesktopObserveParams,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateEnvironmentsListParams,
  validateEnvironmentsPrepareParams,
  validateEnvironmentsStatusParams,
  validateWorkerDesktopObserveParams,
  validateWorkerDesktopLaunchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { projectPairedDeviceNodeBindings } from "../../infra/device-pairing-node-state.js";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { isDesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { getNodeDesktopService } from "../desktop/node-source-context.js";
import {
  resolveDesktopObserveRequester,
  type DesktopObserveRequester,
} from "../desktop/observe-requester.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { createKnownNodeCatalog, listKnownNodes } from "../node-catalog.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import { resolveWorkerPlacementCapabilities } from "../worker-environments/placement-capabilities.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import {
  applySessionPlacementDisabledReasonToNodes,
  resolveEnvironmentsListSessionPlacement,
} from "../worker-environments/session-placement-preflight.js";
import { formatForLog } from "../ws-log.js";
import {
  GATEWAY_ENVIRONMENT,
  summarizeNodeEnvironment,
  summarizeWorkerEnvironment,
} from "./environments-summary.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

export { summarizeWorkerEnvironment } from "./environments-summary.js";

/**
 * Projects gateway-visible environments for the session host picker.
 * Runtime-scoped requiredNodeCommand authority is included when runtimeId is set.
 * Session-scoped symlink / prepared-auth blockers are stamped by environments.list
 * via resolveEnvironmentsListSessionPlacement when workspacePath / runtimeId are set.
 */
export async function listGatewayEnvironments(
  context: GatewayRequestContext,
  workers = listWorkerEnvironments(context),
  runtimeId?: string,
): Promise<EnvironmentSummary[]> {
  const [devices, nodes] = await Promise.all([listDevicePairing(), listNodePairing()]);
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

async function respondDesktopObserve(params: {
  request: DesktopObserveParams;
  respond: RespondFn;
  context: GatewayRequestContext;
  requester?: DesktopObserveRequester;
}) {
  if (params.request.source.kind === "host") {
    if (params.context.getRuntimeConfig().desktop?.host?.enabled !== true) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway host desktop is disabled; enable the Desktop lab (config: desktop.host.enabled=true), then restart the gateway",
        ),
      );
      return;
    }
    if (!params.context.hostDesktopService) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway host desktop is not active; desktop.host.enabled changes require a gateway restart",
        ),
      );
      return;
    }
    try {
      params.respond(
        true,
        await params.context.hostDesktopService.observe({
          control: params.request.control ?? false,
          requester: params.requester,
          ...("credentials" in params.request && params.request.credentials
            ? { credentials: params.request.credentials }
            : {}),
        }),
        undefined,
      );
    } catch (error) {
      if (isDesktopCredentialsRequiredError(error)) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: {
              code: error.detailCode,
              auth: error.auth,
            },
          }),
        );
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error
            ? error.message
            : "gateway host desktop observe unavailable; verify the VNC server and retry",
        ),
      );
    }
    return;
  }

  if (params.request.source.kind === "node") {
    const service = getNodeDesktopService(params.context);
    if (!service) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node desktop is disabled; explicitly allow desktop.stream, then restart the gateway",
        ),
      );
      return;
    }
    try {
      params.respond(
        true,
        await service.observe({
          nodeId: params.request.source.nodeId,
          control: params.request.control ?? false,
          requester: params.requester,
          ...("credentials" in params.request && params.request.credentials
            ? { credentials: params.request.credentials }
            : {}),
        }),
        undefined,
      );
    } catch (error) {
      if (isDesktopCredentialsRequiredError(error)) {
        params.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
            details: { code: error.detailCode, auth: error.auth },
          }),
        );
        return;
      }
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : "node desktop observe unavailable",
        ),
      );
    }
    return;
  }

  const service = params.context.workerEnvironmentService;
  if (!service) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
    );
    return;
  }
  try {
    const result = await service.observeDesktop({
      environmentId: params.request.source.environmentId,
      control: params.request.control ?? false,
      requester: params.requester,
    });
    params.respond(true, result, undefined);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid = code === "environment_not_found" || code === "invalid_state";
    params.respond(
      false,
      undefined,
      errorShape(
        invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        invalid && error instanceof Error ? error.message : "worker desktop observe unavailable",
      ),
    );
  }
}

async function respondDesktopLaunch(params: {
  environmentId: string;
  app: "browser" | "terminal";
  respond: RespondFn;
  context: GatewayRequestContext;
}) {
  const service = params.context.workerEnvironmentService;
  if (!service) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
    );
    return;
  }
  try {
    params.respond(
      true,
      await service.launchDesktopApp({ environmentId: params.environmentId, app: params.app }),
      undefined,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid =
      code === "environment_not_found" ||
      code === "invalid_state" ||
      code === "desktop_app_not_found" ||
      code === "unsupported_platform";
    const actionable = invalid || code === "launcher_failure";
    params.respond(
      false,
      undefined,
      errorShape(
        invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        actionable && error instanceof Error
          ? error.message
          : "worker desktop app launch unavailable; try again",
      ),
    );
  }
}

export const environmentsHandlers: GatewayRequestHandlers = {
  "environments.list": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateEnvironmentsListParams, "environments.list", respond)) {
      return;
    }
    const runtimeId =
      typeof params.runtimeId === "string" && params.runtimeId.trim()
        ? params.runtimeId.trim()
        : undefined;
    const workspacePath =
      typeof params.workspacePath === "string" && params.workspacePath.trim()
        ? params.workspacePath.trim()
        : undefined;
    if (runtimeId || workspacePath) {
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
      const config = context.getRuntimeConfig();
      const [listed, placement] = await Promise.all([
        listGatewayEnvironments(context, workers, runtimeId),
        resolveEnvironmentsListSessionPlacement({
          config,
          runtimeId,
          workspacePath,
        }),
      ]);
      const { sessionPlacement, sessionDisabledReason, hasSessionPlacement } = placement;
      const summarizedAtMs = Date.now();
      const environments = [
        ...applySessionPlacementDisabledReasonToNodes(listed, sessionDisabledReason),
        ...workers.map((record) => summarizeWorkerEnvironment(record, summarizedAtMs)),
      ];
      const profiles = await listWorkerProfilesWithMachines(context);
      respond(
        true,
        {
          environments,
          ...(profiles.length > 0 ? { profiles } : {}),
          ...(hasSessionPlacement ? { sessionPlacement } : {}),
        },
        undefined,
      );
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
};
