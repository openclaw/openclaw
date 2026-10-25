import { vi } from "vitest";
import { GATEWAY_SERVER_CAPS as CAPS } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { SessionDeleteBatchResult } from "../lib/sessions/session-capability.ts";
import { requestSessionPatchMany } from "../lib/sessions/session-mutation-operations.runtime.ts";
import { createNavigationPreferencesFixture } from "../test-helpers/application-context-fixtures.ts";
import { SESSION_MUTATION_TEST_METHODS } from "../test-helpers/gateway-methods.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionOrganizerDependencies } from "./session-organizer.ts";

export function sessionRow(
  index: number,
  overrides: Partial<SidebarRecentSession> = {},
): SidebarRecentSession {
  return {
    key: `agent:main:batch-${index}`,
    label: `Batch ${index}`,
    sessionId: `session-${index}`,
    sharingRole: "owner",
    pinned: index === 0 || index === 100,
    ...overrides,
  } as SidebarRecentSession;
}

export function sessionTarget(row: SidebarRecentSession) {
  return { key: row.key, agentId: "main", expectedSessionId: row.sessionId };
}

export function createHarness(
  params: {
    methods?: string[] | null;
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
  // Reconnect retires the dialog's signal; renewal models beginSessionMutation().
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
          return Object.assign(targetIdentity(target), { ok: false as const, error });
        }
        return Object.assign(targetIdentity(target), { ok: true as const });
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
              capabilities: [CAPS.SESSION_UNREAD_ACK_CONTRACT],
            },
      auth: { role: "operator", scopes: params.scopes ?? ["operator.write"] },
    },
  } as ApplicationGatewaySnapshot;
  const finishArchive = vi.fn();
  const mocks = {
    finishArchive,
    beginArchive: vi.fn(() => finishArchive),
    patch: vi.fn(async (key: string) => ({ ok: true, key })),
    reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
    refreshTheme: vi.fn(),
    deleteMany: vi.fn(async (): Promise<SessionDeleteBatchResult> => ({
      deleted: [],
      errors: [],
      preservedWorktrees: [],
    })),
    deleteOne: vi.fn(async () => ({ deleted: true })),
    groupsDelete: vi.fn(async () => "completed" as const),
    publishSessionMutationError: vi.fn(),
    pruneSidebarSessionEntry: vi.fn(),
    replaceCurrentSession: vi.fn(),
    request,
  };
  const connection = {};
  const scope = {
    epoch: 1,
    context: {
      navigation: createNavigationPreferencesFixture(),
      agents: { state: { agentsList: null } },
      theme: { refresh: mocks.refreshTheme },
      placementStartup: { pause: vi.fn() },
    },
    gateway: { snapshot },
    sessions: {
      beginArchive: mocks.beginArchive,
      captureConnectionScope: () => connection,
      isConnectionScopeCurrent: () => current,
      patch: mocks.patch,
      patchMany: (
        targets: SessionsPatchManyParams["targets"],
        patchParams: SessionsPatchManyParams["patch"],
      ) => requestSessionPatchMany(client, { targets, patch: patchParams }),
      reconcileMutation: mocks.reconcileMutation,
      delete: mocks.deleteOne,
      deleteMany: mocks.deleteMany,
      groupsDelete: mocks.groupsDelete,
    } as unknown as SessionCapability,
    client,
    selectedAgentId: "main",
    signal: abortController.signal,
  } as unknown as SidebarSessionMutationScope;
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError: mocks.publishSessionMutationError,
      refreshSidebarSessions: vi.fn(),
    },
    sidebarSessionStatusFilter: () => "active",
    pruneSidebarSessionEntry: mocks.pruneSidebarSessionEntry,
    replaceCurrentSession: mocks.replaceCurrentSession,
  } as unknown as SessionOrganizerDependencies;
  return {
    ...mocks,
    host,
    retireScope: () => {
      current = false;
      abortController.abort();
    },
    renewScope: () => {
      current = true;
      abortController = new AbortController();
      scope.signal = abortController.signal;
    },
    scope,
  };
}

function targetIdentity(target: SessionsPatchManyParams["targets"][number]) {
  return target.agentId ? { key: target.key, agentId: target.agentId } : { key: target.key };
}
