import { afterEach, expect, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onUserProfilesChanged } from "../../state/user-profile-events.js";
import {
  getUserProfileRole,
  readUserProfileAliases,
  resolveUserProfileId,
} from "../../state/user-profiles.js";
import {
  disposeSessionReadContexts,
  trackSessionReadProfileSubscription,
  trackSessionReadProjection,
} from "../session-read-contexts.test-support.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { readPreparedServerMethodModelCatalogs } from "./optional-model-catalog.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export { disposeSessionReadContexts, sessionReadHandlers };
const initializing = new WeakMap<GatewayRequestContext, Promise<void>>();
afterEach(disposeSessionReadContexts);
export function initializeSessionReadContext(context: GatewayRequestContext) {
  if (getSessionRowProjection(context)) {
    return Promise.resolve();
  }
  let pending = initializing.get(context);
  if (!pending) {
    const placements = context.workerSessionPlacementService;
    pending = createSessionRowProjection({
      cfg: context.getRuntimeConfig(),
      getConfig: context.getRuntimeConfig,
      getModelCatalog: () =>
        readPreparedServerMethodModelCatalogs(context, listAgentIds(context.getRuntimeConfig())),
      context,
      placementFactsReader: placements
        ? {
            async readProjection(sessionIds) {
              const records = placements.getMany(sessionIds);
              const environments = new Map();
              for (const placement of records.values()) {
                const environmentId = placement.environmentId;
                const environment = environmentId
                  ? context.workerEnvironmentService?.get(environmentId)
                  : undefined;
                if (environmentId && environment) {
                  environments.set(environmentId, {
                    ...environment,
                    environmentId,
                    profileSnapshot: { settings: {} },
                    nodeDeviceId: environment.nodeDeviceId ?? null,
                    attachedSessionIds: [...(environment.attachedSessionIds ?? [])],
                  });
                }
              }
              return {
                placements: records,
                moves: placements.getPlacementMoves?.(sessionIds) ?? new Map(),
                workspaceResultReconcilingSessionIds:
                  placements.getWorkspaceResultReconcilingSessionIds?.(sessionIds) ?? new Set(),
                environments,
              };
            },
          }
        : undefined,
    }).then((projection) => {
      trackSessionReadProjection(projection);
      bindSessionRowProjection(context, () => projection);
    });
    initializing.set(context, pending);
  }
  return pending;
}

export function identifiedClient(profileId: string): GatewayClient {
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  const refresh = () => {
    const identity = client.authenticatedUserProfile?.profileId ?? profileId;
    const resolved = resolveUserProfileId(identity);
    const canonical = resolved ?? identity;
    client.preparedSessionProfile = {
      profileId: canonical,
      aliases: readUserProfileAliases(canonical),
      role: resolved ? getUserProfileRole(canonical) : null,
    };
  };
  refresh();
  trackSessionReadProfileSubscription(onUserProfilesChanged(refresh));
  return client;
}

export function requestContext(config: OpenClawConfig): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: async () => [],
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

export async function listSessions(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  request: SessionsListParams;
}) {
  await initializeSessionReadContext(params.context);
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.list"]?.({
    req: { type: "req", id: "session-list-test", method: "sessions.list" },
    params: params.request,
    client: params.client,
    context: params.context,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as {
    count: number;
    nextOffset: number | null;
    sessions: GatewaySessionRow[];
    totalCount: number;
  };
}

export async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  for (const [agentId, name, updatedAt, owner, overrides] of [
    ["main", "active", 400, "owner@example.com", {}],
    ["main", "draft", 300, "owner@example.com", { visibility: "draft" }],
    ["main", "archived", 200, "viewer@example.com", { archivedAt: 200 }],
    ["work", "active", 100, "viewer@example.com", {}],
  ] as const) {
    replaceSessionEntrySync(
      { agentId, sessionKey: `agent:${agentId}:${name}` },
      mergeSessionEntry(undefined, {
        sessionId: `${agentId}-${name}`,
        updatedAt,
        createdActor: { type: "human", source: "profile", id: owner },
        visibility: "shared",
        ...overrides,
      }),
    );
  }
  return config;
}

export async function seedSessionsWithActivityTimes() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(400);
  const config = await seedSessions();
  for (const [name, updatedAt] of [
    ["active", 400],
    ["draft", 300],
    ["archived", 200],
  ] as const) {
    const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error(`Missing seeded session ${scope.sessionKey}`);
    }
    replaceSessionEntrySync(scope, { ...entry, updatedAt });
    expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
  }
  return { clock, config };
}
