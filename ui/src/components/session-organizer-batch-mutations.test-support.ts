import { vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { SessionDeleteBatchResult } from "../lib/sessions/session-capability.ts";
import { requestSessionPatchMany } from "../lib/sessions/session-requests.ts";
import { SESSION_MUTATION_TEST_METHODS } from "../test-helpers/gateway-methods.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerDependencies } from "./session-organizer.ts";

export function sessionRow(index: number): SidebarRecentSession {
  return {
    key: `agent:main:batch-${index}`,
    label: `Batch ${index}`,
    sessionId: `session-${index}`,
    sharingRole: "owner",
    pinned: index === 0 || index === 100,
  } as SidebarRecentSession;
}

export function sessionTarget(row: SidebarRecentSession) {
  return { key: row.key, agentId: "main", expectedSessionId: row.sessionId };
}

export function createHarness(
  params: {
    methods?: string[] | null;
    capabilities?: string[];
    scopes?: string[];
    current?: boolean;
    staleAfterRequest?: number;
    requestFailure?: { at: number; error: unknown };
    failedKeys?: readonly string[];
    phase?: ApplicationGatewaySnapshot["phase"];
  } = {},
) {
  let current = params.current ?? true;
  let requestCount = 0;
  // Mirrors SessionDataController's own controller: retiring the scope aborts
  // it so a dialog wired to `scope.signal` dismisses itself for real, and
  // renewing stands in for the next `beginSessionMutation()` after a reconnect.
  let abortController = new AbortController();
  const request = vi.fn(async (_method: string, rawParams?: unknown, _options?: unknown) => {
    const patchParams = rawParams as SessionsPatchManyParams;
    const requestFailure = params.requestFailure;
    requestCount += 1;
    if (requestFailure && requestCount === requestFailure.at) {
      throw requestFailure.error;
    }
    const result = {
      outcomes: patchParams.targets.map((target) => {
        if (params.failedKeys?.includes(target.key)) {
          const error = { code: "INVALID_REQUEST" as const, message: `failed ${target.key}` };
          return target.agentId
            ? { ok: false as const, key: target.key, agentId: target.agentId, error }
            : { ok: false as const, key: target.key, error };
        }
        if (target.agentId) {
          return { ok: true as const, key: target.key, agentId: target.agentId };
        }
        return { ok: true as const, key: target.key };
      }),
    } satisfies SessionsPatchManyResult;
    if (requestCount === params.staleAfterRequest) {
      current = false;
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: params.phase ?? "connected",
    hello: {
      features:
        params.methods === null
          ? {}
          : {
              methods: params.methods ?? [...SESSION_MUTATION_TEST_METHODS],
              capabilities: params.capabilities ?? [
                GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT,
              ],
            },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const finishArchive = vi.fn();
  const beginArchive = vi.fn(() => finishArchive);
  const patch = vi.fn(async (key: string) => ({ ok: true, key }));
  const reconcileMutation = vi.fn(async () => ({ status: "refreshed" as const }));
  const refreshTheme = vi.fn();
  const deleteMany = vi.fn(async (): Promise<SessionDeleteBatchResult> => ({
    deleted: [],
    errors: [],
    preservedWorktrees: [],
  }));
  const deleteOne = vi.fn(async () => ({ deleted: true }));
  const groupsDelete = vi.fn(async () => "completed" as const);
  const connection = {};
  const scope = {
    epoch: 1,
    context: {
      agents: { state: { agentsList: null } },
      theme: { refresh: refreshTheme },
      placementStartup: { pause: vi.fn() },
    },
    gateway: { snapshot },
    sessions: {
      beginArchive,
      captureConnectionScope: () => connection,
      isConnectionScopeCurrent: () => current,
      patch,
      patchMany: (
        targets: SessionsPatchManyParams["targets"],
        patchParams: SessionsPatchManyParams["patch"],
      ) => requestSessionPatchMany(client, { targets, patch: patchParams }),
      reconcileMutation,
      delete: deleteOne,
      deleteMany,
      groupsDelete,
    } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
    signal: abortController.signal,
  } as unknown as SidebarSessionMutationScope;
  const publishSessionMutationError = vi.fn();
  const pruneSidebarSessionEntry = vi.fn();
  const replaceCurrentSession = vi.fn();
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
      refreshSidebarSessions: vi.fn(),
    },
    sidebarSessionStatusFilter: () => "active",
    pruneSidebarSessionEntry,
    replaceCurrentSession,
  } as unknown as SessionOrganizerDependencies;
  return {
    beginArchive,
    finishArchive,
    deleteMany,
    deleteOne,
    groupsDelete,
    host,
    patch,
    pruneSidebarSessionEntry,
    publishSessionMutationError,
    reconcileMutation,
    refreshTheme,
    replaceCurrentSession,
    request,
    // Stands in for a reconnect or agent switch landing while a confirm is open.
    retireScope: () => {
      current = false;
      abortController.abort();
    },
    // Stands in for the next beginSessionMutation() a reconnect issues.
    renewScope: () => {
      current = true;
      abortController = new AbortController();
      scope.signal = abortController.signal;
    },
    scope,
  };
}
