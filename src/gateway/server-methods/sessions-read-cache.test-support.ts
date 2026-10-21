import { afterEach, expect, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onUserProfilesChanged } from "../../state/user-profile-events.js";
import { readUserProfileSnapshotSync } from "../../state/user-profile-list-item.test-support.js";
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
import type { SessionsListResult } from "../session-utils.types.js";
import type { WorkerPlacementMoveIntent } from "../worker-environments/placement-move-intent.types.js";
import type { WorkerSessionPlacementReader } from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import type { WorkerEnvironmentServiceContract } from "../worker-environments/service-contract.js";
import { readPreparedServerMethodModelCatalogs } from "./optional-model-catalog.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export { disposeSessionReadContexts, sessionReadHandlers };
export function profileSessionEntry(
  sessionId: string,
  updatedAt: number,
  profileId: string,
): SessionEntry {
  return {
    sessionId,
    updatedAt,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: profileId },
  };
}
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
      getPolicyConfig: context.getCommittedRuntimeConfig ?? context.getRuntimeConfig,
      getModelCatalog: () =>
        readPreparedServerMethodModelCatalogs(context, listAgentIds(context.getRuntimeConfig())),
      context,
      placementFactsReader: placements
        ? createSessionPlacementFactsReader(placements, (id) =>
            context.workerEnvironmentService?.get(id),
          )
        : undefined,
    }).then((projection) => {
      trackSessionReadProjection(projection);
      bindSessionRowProjection(context, () => projection);
    });
    initializing.set(context, pending);
  }
  return pending;
}

export function createSessionPlacementFactsReader(
  placements: WorkerSessionPlacementReader,
  getEnvironment?: WorkerEnvironmentServiceContract["get"],
  moves: ReadonlyMap<string, WorkerPlacementMoveIntent> = new Map(),
): Pick<WorkerSessionPlacementStore, "readProjection"> {
  return {
    async readProjection(sessionIds) {
      const records = placements.getManyAsync
        ? await placements.getManyAsync(sessionIds)
        : placements.getMany(sessionIds);
      const environments = new Map();
      for (const placement of records.values()) {
        const environmentId = placement.environmentId;
        const environment = environmentId ? getEnvironment?.(environmentId) : undefined;
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
        moves: new Map([...moves].filter(([id]) => sessionIds.includes(id))),
        pendingResults: new Map(),
        workspaceJournalOwnerSessionIds: new Set(),
        workspaceResultReconcilingSessionIds: new Set(),
        workspaceRecoveryPendingSessionIds: new Set(),
        environments,
      };
    },
  };
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
    authenticatedUserProfile: { profileId, displayName: profileId, hasAvatar: false, updatedAt: 1 },
  };
  const refresh = () => {
    const identity = client.authenticatedUserProfile?.profileId ?? profileId;
    const { profiles } = readUserProfileSnapshotSync();
    const source = profiles.find((profile) => profile.id === identity);
    const canonical = source?.mergedInto ?? source?.id ?? identity;
    const profile = profiles.find((candidate) => candidate.id === canonical);
    client.preparedSessionProfile = {
      profileId: canonical,
      aliases: new Set([
        canonical,
        ...profiles.filter((candidate) => candidate.mergedInto === canonical).map(({ id }) => id),
      ]),
      role: profile?.role ?? null,
    };
  };
  refresh();
  trackSessionReadProfileSubscription(onUserProfilesChanged(refresh));
  return client;
}

export function requestContext(config: OpenClawConfig): GatewayRequestContext {
  return {
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
    forgetConnectionAncestors: vi.fn(),
    loadGatewayModelCatalog: async () => [],
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

export async function listSessions(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  request: SessionsListParams;
  acceptsSerializedJson?: boolean;
}) {
  await initializeSessionReadContext(params.context);
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.list"]?.({
    req: { type: "req", id: "session-list-test", method: "sessions.list" },
    params: params.request,
    acceptsSerializedJson: params.acceptsSerializedJson,
    client: params.client,
    context: params.context,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as SessionsListResult;
}

export async function seedSessions(activityTimes = false): Promise<OpenClawConfig> {
  const config: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };
  setRuntimeConfigSnapshot(config);
  for (const [agentId, name, updatedAt, owner, overrides] of [
    ["main", "active", 400, "owner@example.com", {}],
    ["main", "draft", 300, "owner@example.com", { visibility: "draft" }],
    ["main", "archived", 200, "viewer@example.com", { archivedAt: 200 }],
    ["work", "active", 100, "viewer@example.com", {}],
  ] as const) {
    const scope = { agentId, sessionKey: `agent:${agentId}:${name}` };
    const entry = mergeSessionEntry(undefined, {
      ...profileSessionEntry(`${agentId}-${name}`, updatedAt, owner),
      ...overrides,
    });
    // mergeSessionEntry stamps the current time; activity fixtures need historical main rows.
    if (activityTimes && agentId === "main") {
      entry.updatedAt = updatedAt;
    }
    replaceSessionEntrySync(scope, entry);
    if (activityTimes && agentId === "main") {
      expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
    }
  }
  return config;
}

export async function seedSessionsWithActivityTimes() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(400);
  return { clock, config: await seedSessions(true) };
}
