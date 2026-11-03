import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { boardWidgetHasGrantedTool } from "../boards/board-capabilities.js";
import { CORE_BOARD_DATA_BINDING_IDS } from "../boards/board-host-capability-ids.js";
import { BoardValidationError } from "../boards/board-layout.js";
import { BoardEventPayloadError } from "../boards/board-notices.js";
import type { BoardStore, BoardSessionTarget } from "../boards/board-store.js";
import { GITHUB_ACTIONS_BINDING_ID } from "../boards/legacy-github-actions-grant.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { withDashboardDataBindingRead } from "../plugins/dashboard-data-binding-scope.js";
import type {
  PluginDashboardDataBindingHost,
  PreparedPluginDashboardDataBinding,
} from "../plugins/dashboard-data-binding.types.js";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import {
  BoardGatewayUnavailableError,
  type BoardViewTicketAuthorityInput,
  verifyBoardViewTicket,
  requireBoardViewTicketAuthority,
} from "./board-view-ticket.js";
import { withAuthorizedBoardWidgetView } from "./board-widget-view.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import { prepareGatewayRequestHandler } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { resolveRequestedSessionStoreTarget } from "./session-store-key.js";

type BoardDataBindingId = (typeof CORE_BOARD_DATA_BINDING_IDS)[number];
type GatewayHandlerInvocation = Parameters<GatewayRequestHandlers[string]>[0];

export type BoardRequestAuthority = {
  assertActive: () => void;
  pluginRegistry?: PluginRegistry;
  ticketAuthority: BoardViewTicketAuthorityInput;
};

export type BoardCapabilityAuthority = BoardRequestAuthority & {
  boardSession: Required<BoardSessionTarget>;
  /** Validate the stored grant and start work together; assertActive only checks request liveness. */
  useCurrent: <T>(start: () => T) => Promise<Awaited<T>>;
};

export function assertBoardCapabilityParamsSize(
  params: Record<string, unknown>,
  capability: "action" | "data binding",
): void {
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 8 * 1024) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget ${capability} params exceed 8192 UTF-8 bytes`,
    );
  }
}

export function boardDataBindingCapability(
  bindingId: string,
  params: Record<string, unknown>,
  registry?: PluginRegistry,
): string {
  const registration = registry?.dashboardDataBindings.get(bindingId);
  if (!registration?.runtime) {
    return bindingId;
  }
  const grant = registration.runtime.resolveGrant(params);
  // A plugin may narrow its own grant, never translate a different capability into access.
  if (grant !== bindingId && !grant.startsWith(`${bindingId}:`)) {
    throw new BoardValidationError(
      "invalid_operation",
      "dashboard binding resolved a grant outside its namespace",
    );
  }
  return grant;
}

function createDashboardDataBindingHost(
  invocation: GatewayHandlerInvocation,
  authority: BoardRequestAuthority & {
    boardSession: Required<BoardSessionTarget>;
    useCurrent?: BoardCapabilityAuthority["useCurrent"];
  },
  bindingId: string,
): PluginDashboardDataBindingHost {
  const registration = authority.pluginRegistry?.dashboardDataBindings.get(bindingId);
  const assertCurrent = () => {
    authority.assertActive();
    if (
      !registration ||
      authority.pluginRegistry?.dashboardDataBindings.get(bindingId) !== registration
    ) {
      throw new BoardGatewayUnavailableError();
    }
  };
  const host: PluginDashboardDataBindingHost = {
    agentId: authority.boardSession.agentId,
    getConfig: () => {
      assertCurrent();
      return invocation.context.getRuntimeConfig();
    },
    getSourceConfig: () => {
      assertCurrent();
      return (
        getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ??
        invocation.context.getRuntimeConfig()
      );
    },
    cacheScope: invocation.context,
    assertCurrent,
    useCurrent: async <T>(start: () => T): Promise<Awaited<T>> => {
      assertCurrent();
      const result = authority.useCurrent
        ? await authority.useCurrent(() => {
            assertCurrent();
            return start();
          })
        : await start();
      assertCurrent();
      return result;
    },
    trackExecution: async <T>(run: () => T | Promise<T>): Promise<Awaited<T>> => {
      assertCurrent();
      return await invocation.context.trackExecution(() => {
        assertCurrent();
        return run();
      });
    },
  };
  return host;
}

/** Credential preflight is plugin-owned; the Board still commits under exact caller/session authority. */
export async function prepareBoardDataBindingGrants(
  grants: readonly string[],
  invocation: GatewayHandlerInvocation,
  authority: BoardRequestAuthority & { boardSession: Required<BoardSessionTarget> },
): Promise<PreparedPluginDashboardDataBinding> {
  const prepared: PreparedPluginDashboardDataBinding[] = [];
  let active = true;
  const assertPreflightCurrent = () => {
    if (!active) {
      throw new Error("Dashboard data binding preflight is closed");
    }
    authority.assertActive();
  };
  const registrations = authority.pluginRegistry?.dashboardDataBindings;
  // This binding predates plugin ownership. Keep its persisted grants, never a native fallback.
  if (
    grants.some((grant) => grant.startsWith(`${GITHUB_ACTIONS_BINDING_ID}:`)) &&
    !registrations?.has(GITHUB_ACTIONS_BINDING_ID)
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      "Dashboard data binding is unavailable; enable the plugin that provides it and retry",
    );
  }
  try {
    for (const registration of registrations?.values() ?? []) {
      const runtime = registration.runtime;
      if (
        runtime &&
        grants.some(
          (grant) =>
            grant === registration.capabilityId ||
            grant.startsWith(`${registration.capabilityId}:`),
        )
      ) {
        const host = createDashboardDataBindingHost(
          invocation,
          { ...authority, assertActive: assertPreflightCurrent },
          registration.capabilityId,
        );
        const binding = await runtime.prepare(host);
        host.assertCurrent();
        binding.assertCurrent();
        prepared.push({
          assertCurrent: () => {
            host.assertCurrent();
            binding.assertCurrent();
          },
          start: (run) => host.useCurrent(() => binding.start(run)),
        });
      }
    }
  } catch (error) {
    active = false;
    throw error;
  }

  const assertCurrent = () => {
    assertPreflightCurrent();
    for (const binding of prepared) {
      binding.assertCurrent();
    }
  };
  return {
    assertCurrent,
    start: async <T>(run: () => T): Promise<Awaited<T>> => {
      const startAt = async (index: number): Promise<Awaited<T>> =>
        index === prepared.length
          ? await run()
          : await prepared[index]!.start(() => startAt(index + 1));
      try {
        assertCurrent();
        const value = await startAt(0);
        assertCurrent();
        return value;
      } finally {
        active = false;
      }
    },
  };
}

/** Retained reads/actions own the exact live widget grant, not just its Gateway. */
export function captureBoardCapabilityAuthority(
  store: BoardStore,
  ticket: string,
  invocation: GatewayHandlerInvocation,
  capability: string,
): BoardCapabilityAuthority {
  const authority = captureBoardRequestAuthority(invocation);
  const claims = verifyBoardViewTicket(ticket);
  if (!claims) {
    throw new BoardValidationError("invalid_operation", "board widget view ticket is invalid");
  }
  requireBoardViewTicketAuthority(claims, invocation.context);
  const resolveSession = (target: BoardSessionTarget) => {
    authority.assertActive();
    const cfg = invocation.context.getRuntimeConfig();
    const selected = resolveRequestedSessionStoreTarget(cfg, target.sessionKey, target.agentId);
    if (!selected.ok || selected.value.sessionKey !== target.sessionKey) {
      throw new BoardValidationError(
        "invalid_operation",
        "board widget session identity changed; reload the dashboard",
      );
    }
    return selected.value;
  };
  const boardSession = resolveSession(claims);
  return {
    ...authority,
    boardSession,
    useCurrent: async <T>(start: () => T): Promise<Awaited<T>> =>
      await withAuthorizedBoardWidgetView(
        store,
        ticket,
        (view) => {
          const current = resolveSession(view);
          if (
            current.agentId !== boardSession.agentId ||
            current.sessionKey !== boardSession.sessionKey
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              "board widget session identity changed; reload the dashboard",
            );
          }
          if (
            !boardWidgetHasGrantedTool(view.document.declared, view.document.grantState, capability)
          ) {
            throw new BoardValidationError(
              "invalid_operation",
              `board widget tool is not granted: ${capability}`,
            );
          }
          return start();
        },
        { gatewayContext: invocation.context },
      ),
  };
}

export function captureBoardRequestAuthority(
  invocation: GatewayHandlerInvocation,
): BoardRequestAuthority {
  const context = invocation.context;
  const resolveGatewayContext = context.resolveGatewayContext;
  if (!resolveGatewayContext) {
    throw new BoardGatewayUnavailableError();
  }
  const methodRegistry = context.getGatewayMethodRegistry?.();
  const pluginRegistry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry() ?? undefined;
  const pluginRegistryEpoch = pluginRegistry
    ? capturePluginRegistryLifecycleEpoch(pluginRegistry)
    : undefined;
  const assertActive = composeSessionSourceAssertion(
    [
      captureExternalSessionCommitGuard(invocation.sessionMutationCommitGuard),
      captureExternalSessionCommitGuard(invocation.sessionMutationAuthorization?.assertCurrent),
    ],
    (assertSources) => {
      try {
        // Retained board work also belongs to the requesting caller and session authorization.
        invocation.signal?.throwIfAborted();
        assertSources();
        if (
          isGatewaySubordinateWorkAdmissionClosed() ||
          resolveGatewayContext() !== context ||
          context.resolveGatewayContext !== resolveGatewayContext ||
          (methodRegistry && context.getGatewayMethodRegistry?.() !== methodRegistry) ||
          (pluginRegistry &&
            (!pluginRegistryEpoch ||
              !isPluginRegistryLifecycleEpochActive(pluginRegistry, pluginRegistryEpoch)))
        ) {
          throw new BoardGatewayUnavailableError();
        }
      } catch (error) {
        if (error instanceof BoardGatewayUnavailableError) {
          throw error;
        }
        throw new BoardGatewayUnavailableError();
      }
    },
  );
  assertActive();
  return {
    assertActive,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ticketAuthority: {
      gatewayContext: context,
      resolveGatewayContext,
      ...(pluginRegistry ? { pluginRegistry } : {}),
    },
  };
}

export function respondBoardError(
  error: unknown,
  respond: GatewayHandlerInvocation["respond"],
): void {
  if (error instanceof BoardGatewayUnavailableError) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
    return;
  }
  if (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}

function isBoardDataBindingId(value: string): value is BoardDataBindingId {
  return (CORE_BOARD_DATA_BINDING_IDS as readonly string[]).includes(value);
}

async function invokeGatewayHandler(
  handler: GatewayRequestHandlers[string],
  method: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
  authority: BoardCapabilityAuthority,
  publish: GatewayHandlerInvocation["respond"],
): Promise<void> {
  let outcome:
    | { kind: "reply"; ok: boolean; payload: unknown; error: ErrorShape | undefined }
    | { kind: "thrown"; error: unknown }
    | undefined;
  await authority.useCurrent(async () => {
    try {
      await handler({
        ...invocation,
        req: { ...invocation.req, method, params },
        params,
        respond: (ok, payload, error) => {
          outcome ??= { kind: "reply", ok, payload, error };
        },
      });
    } catch (error) {
      outcome = { kind: "thrown", error };
    }
  });
  await authority.useCurrent(() => {
    if (!outcome) {
      publish(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `${method} did not return a result`),
      );
    } else if (outcome.kind === "thrown") {
      respondBoardError(outcome.error, publish);
    } else if (!outcome.ok) {
      publish(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, outcome.error?.message || `${method} failed`),
      );
    } else {
      publish(true, outcome.payload);
    }
  });
}

export async function readBoardDataBinding(
  bindingId: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
  authority: BoardCapabilityAuthority,
  publish: GatewayHandlerInvocation["respond"],
): Promise<void> {
  if (isBoardDataBindingId(bindingId)) {
    const handler = await prepareGatewayRequestHandler(coreGatewayHandlers[bindingId]!);
    return await invokeGatewayHandler(
      handler,
      bindingId,
      params,
      // Board reads are one-shot and cannot converge an incomplete marker.
      bindingId === "usage.status" ? { ...invocation, client: null } : invocation,
      authority,
      publish,
    );
  }
  const registration = authority.pluginRegistry?.dashboardDataBindings.get(bindingId);
  if (!registration) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget data binding is not allowed: ${bindingId}`,
    );
  }
  const host = createDashboardDataBindingHost(invocation, authority, bindingId);
  return await withDashboardDataBindingRead(host, () =>
    invokeGatewayHandler(
      registration.handler,
      registration.method,
      params,
      invocation,
      authority,
      publish,
    ),
  );
}

export async function runBoardActionVerb(
  actionId: string,
  params: Record<string, unknown>,
  invocation: GatewayHandlerInvocation,
  authority: BoardCapabilityAuthority,
  publish: GatewayHandlerInvocation["respond"],
): Promise<void> {
  const registration = authority.pluginRegistry?.dashboardActionVerbs.get(actionId);
  if (!registration) {
    throw new BoardValidationError(
      "invalid_operation",
      `board widget action verb is not allowed: ${actionId}`,
    );
  }
  if (registration.paramShape) {
    const validation = validateJsonSchemaValue({
      schema: registration.paramShape,
      cacheKey: `dashboard-action:${registration.pluginId}:${registration.id}`,
      value: params,
    });
    if (!validation.ok) {
      throw new BoardValidationError(
        "invalid_operation",
        `board widget action params do not match ${actionId}: ${validation.errors.map((error) => error.text).join(", ")}`,
      );
    }
  }
  return await invokeGatewayHandler(
    registration.handler,
    registration.method,
    params,
    invocation,
    authority,
    publish,
  );
}

export async function triggerBoardCronJob(
  jobId: string,
  invocation: GatewayHandlerInvocation,
  authority: BoardCapabilityAuthority,
  publish: GatewayHandlerInvocation["respond"],
): Promise<void> {
  return await invokeGatewayHandler(
    await prepareGatewayRequestHandler(coreGatewayHandlers["cron.run"]!),
    "cron.run",
    { id: jobId, mode: "force" },
    invocation,
    authority,
    publish,
  );
}
