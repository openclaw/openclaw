import { expect, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import { prepareControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const METHOD = "controlUi.sessionPullRequests.subscribe";
export const sessionKey = "agent:main:guest-publication";
export const branch = { owner: "synthetic", repo: "publication", branch: "guest-change" };
export const snapshot: ControlUiSessionPullRequests = {
  pullRequests: [],
  branch,
  rateLimited: false,
};
export const readerChanges = [
  "unchanged",
  "role",
  "connection",
  "profile",
  "visibility",
  "grant",
  "replacement grant",
] as const;
export type Load = NonNullable<
  Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0]["load"]
>;

let fixtureSequence = 0;

export async function createFixture(
  scope: OperatorScope,
  useDefaultLoader = false,
  initialSessionPatch: Partial<SessionEntry> = {},
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const fixtureId = ++fixtureSequence;
  const readerEmail = `guest-publication-reader-${fixtureId}@example.test`;
  const profile = ensureProfileForEmail(readerEmail);
  const other = ensureProfileForEmail(`publication-owner-${fixtureId}@example.test`);
  const seeded = new Set<string>();
  const sessionId = `${sessionKey}-${fixtureId}`;
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            agents: ["main"],
            sessions: { others: "view" },
            scopes: [scope],
          },
        },
      },
    },
  };
  setUserProfileRole(profile.id, "reader");
  setRuntimeConfigSnapshot(cfg);
  const seed = async (key: string, creator = profile.id, patch: Partial<SessionEntry> = {}) => {
    if (!seeded.has(key)) {
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: key })).toBeUndefined();
      seeded.add(key);
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: `${key}-${fixtureId}`,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: creator },
        spawnedCwd: "/synthetic/guest-publication",
        ...patch,
      },
    );
  };
  await seed(sessionKey, profile.id, initialSessionPatch);
  const connections = createGatewayConnectionState({
    scheduler,
    bootId: "publication-read",
    cfg,
    getRuntimeConfig,
  });
  const addReader = (connId: string) => {
    const socket = createGatewayWsTestSocket();
    const client = createOperatorWsClient({ connId, socket, scopes: [scope] });
    const access = new AbortController();
    client.internal = {
      ...client.internal,
      operatorAccessAuthority: {
        signal: access.signal,
        assertCurrent: () => access.signal.throwIfAborted(),
      },
    };
    client.authenticatedUserProfile = {
      profileId: profile.id,
      avatarRevision: "fixture",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    connections.clients.add(client);
    return { client, socket, access };
  };
  const reader = addReader("guest-publication-reader");
  const load = vi.fn<Load>(async () => snapshot);
  const subscriptions = createControlUiSessionPullRequestSubscriptions({
    scheduler,
    broadcastToConnIds: connections.broadcastToConnIds,
    isConnectionActive: connections.isConnectionActive,
    prepareRead: async (connId, session) => {
      const client = connections.clients.getByConnectionId(connId);
      return client
        ? await prepareControlUiSessionPrRead({
            client,
            ...session,
            getRuntimeConfig,
            getSessionRowProjection: () => getSessionRowProjection(context),
            isCurrentClient: () => connections.clients.getByConnectionId(connId) === client,
          })
        : undefined;
    },
    ...(useDefaultLoader ? {} : { load }),
  });
  const context = createGatewayRequestContext(makeContextParams(connections));
  context.getRuntimeConfig = getRuntimeConfig;
  context.controlUiSessionPullRequests = subscriptions;
  await initializeSessionReadContext(context);
  return {
    ...reader,
    clock,
    addReader,
    profile,
    other,
    sessionId,
    cfg,
    seed,
    load,
    subscriptions,
    context,
    async changeReader(change: (typeof readerChanges)[number], key = sessionKey) {
      if (change === "role") {
        const roles = cfg.gateway!.roles!;
        setRuntimeConfigSnapshot({
          ...cfg,
          gateway: {
            ...cfg.gateway,
            roles: {
              ...roles,
              definitions: {
                ...roles.definitions,
                reader: { ...roles.definitions.reader!, scopes: [] },
              },
            },
          },
        });
      } else if (change === "connection") {
        reader.client.invalidated = true;
      } else if (change === "profile") {
        linkEmail(readerEmail, other.id);
      } else if (change === "visibility") {
        await seed(key, other.id, { visibility: "draft", updatedAt: 2 });
      } else if (change === "grant") {
        reader.access.abort(new Error("Original access retired"));
      } else if (change === "replacement grant") {
        const replacement = new AbortController();
        reader.client.internal = {
          ...reader.client.internal,
          operatorAccessAuthority: {
            signal: replacement.signal,
            assertCurrent: () => replacement.signal.throwIfAborted(),
          },
        };
      }
    },
    async subscribe(keys = [sessionKey], client = reader.client) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "guest-publication-watch",
          method: METHOD,
          params: { sessionKeys: keys },
        },
        client,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { subscribed: keys.length > 0 }, undefined);
    },
    async close() {
      await subscriptions.stop();
      await scheduler.stop();
      connections.clients.clear();
      await disposeSessionReadContexts();
    },
    async removeSessions() {
      for (const key of seeded) {
        const original = loadSessionEntryReadOnly({ agentId: "main", sessionKey: key });
        if (original) {
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: loadGatewaySessionEntryReadOnly(key, { agentId: "main" }).storePath,
            target: { canonicalKey: key, storeKeys: [key] },
            expectedSessionId: original.sessionId,
            archiveTranscript: false,
          });
        }
      }
    },
  };
}
