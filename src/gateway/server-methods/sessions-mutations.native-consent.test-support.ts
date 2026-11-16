import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export function startSessionMutationRequest(
  method: string,
  params: Record<string, unknown>,
  options: Pick<GatewayRequestHandlerOptions, "client" | "context"> &
    Partial<GatewayRequestHandlerOptions>,
) {
  const respond = vi.fn<RespondFn>(options.respond);
  const handler = (method === "sessions.create" ? sessionCreateHandlers : sessionMutationHandlers)[
    method
  ]!;
  const running = Promise.resolve(
    handler({
      req: { type: "req", id: method, method, params },
      isWebchatConnect: () => true,
      ...options,
      params,
      respond,
    }),
  );
  return { respond, responses: respond.mock.calls, running };
}

export function createSessionMutationCatalog(
  config: OpenClawConfig,
  state: Pick<OpenClawTestState, "agentDir" | "workspaceDir">,
  entries: ModelCatalogEntry[],
  routeVariants = entries,
) {
  return {
    config,
    entries,
    routeVariants,
    agentId: "main",
    agentDir: state.agentDir("main"),
    workspaceDir: state.workspaceDir,
    catalogComplete: true,
  };
}

export function createSessionMutationContext(
  config: OpenClawConfig = {},
  loadCatalog?: GatewayRequestContext["loadGatewayModelCatalog"],
  cron?: Pick<
    GatewayRequestContext["cron"],
    "list" | "updateWithPrecondition" | "getDefaultAgentId"
  >,
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: vi.fn(
      async (params: Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0]) => {
        const entries = loadCatalog ? await loadCatalog(params) : [];
        return { entries, routeVariants: entries };
      },
    ),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    dedupe: new Map(),
    ...(cron ? { cron } : {}),
  } as unknown as GatewayRequestContext;
}
