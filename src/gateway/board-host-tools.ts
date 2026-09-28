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
import {
  GITHUB_ACTIONS_BINDING_ID,
  resolveGitHubActionsRequest,
} from "../boards/github-actions-capability.js";
import {
  capturePluginRegistryLifecycleEpoch,
  isPluginRegistryLifecycleEpochActive,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import {
  BoardGatewayUnavailableError,
  type BoardViewTicketAuthorityInput,
  verifyBoardViewTicket,
  requireBoardViewTicketAuthority,
} from "./board-view-ticket.js";
import { withAuthorizedBoardWidgetView } from "./board-widget-view.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { cronHandlers } from "./server-methods/cron.js";
import { healthHandlers } from "./server-methods/health.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { usageHandlers } from "./server-methods/usage.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

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
): string {
  return bindingId === GITHUB_ACTIONS_BINDING_ID
    ? resolveGitHubActionsRequest(params).capability
    : bindingId;
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
    const selected = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
    if (
      !selected.ok ||
      resolveSessionStoreKey({
        cfg,
        sessionKey: target.sessionKey,
        storeAgentId: selected.agentId,
      }) !== target.sessionKey
    ) {
      throw new BoardValidationError(
        "invalid_operation",
        "board widget session identity changed; reload the dashboard",
      );
    }
    return { sessionKey: target.sessionKey, agentId: selected.agentId };
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
  const assertActive = () => {
    try {
      // Retained board work also belongs to the requesting caller and session authorization.
      invocation.signal?.throwIfAborted();
      invocation.sessionMutationCommitGuard?.();
      invocation.sessionMutationAuthorization?.assertCurrent();
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
  };
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

const BOARD_DATA_HANDLERS: Record<BoardDataBindingId, GatewayRequestHandlers[string]> = {
  "sessions.list": sessionReadHandlers["sessions.list"]!,
  // Board reads are one-shot and cannot converge an incomplete marker.
  "usage.status": (invocation) => usageHandlers["usage.status"]!({ ...invocation, client: null }),
  "usage.cost": usageHandlers["usage.cost"]!,
  "cron.list": cronHandlers["cron.list"]!,
  "cron.status": cronHandlers["cron.status"]!,
  "agents.list": agentsHandlers["agents.list"]!,
  health: healthHandlers.health!,
};

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
  if (bindingId === GITHUB_ACTIONS_BINDING_ID) {
    const { readBoardGitHubActions } = await import("./github-actions-read.js");
    return await readBoardGitHubActions(params, invocation.context, authority, publish);
  }
  if (isBoardDataBindingId(bindingId)) {
    return await invokeGatewayHandler(
      BOARD_DATA_HANDLERS[bindingId],
      bindingId,
      params,
      invocation,
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
  return await invokeGatewayHandler(
    registration.handler,
    registration.method,
    params,
    invocation,
    authority,
    publish,
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
    cronHandlers["cron.run"]!,
    "cron.run",
    { id: jobId, mode: "force" },
    invocation,
    authority,
    publish,
  );
}
