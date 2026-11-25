import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import * as profileAliases from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { resolveSessionEventAgentScope } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "../session-sharing.js";
import { canReceivePreparedSessionEvent } from "../session-sharing.test-utils.js";
import { observeAliasRootProbes } from "./session-catalog.profile-probes.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function withCreatorRows(
  run: (fixture: {
    stateDir: string;
    callerId: string;
    creatorId: string;
    keys: string[];
  }) => Promise<void>,
  count = 100,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prepareProfileCatalog: true,
      env: {
        OPENCLAW_STATE_DIR: undefined,
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        NODE_ENV: "production",
      },
    },
    async (state) => {
      setRuntimeConfigSnapshot({});
      const caller = ensureProfileForEmail("caller@preparation.test");
      const creator = ensureProfileForEmail("creator@preparation.test");
      ensureProfileForEmail("unrelated@preparation.test");
      const keys = Array.from({ length: count }, (_, i) => `agent:main:prepared-${i}`);
      for (const [index, sessionKey] of keys.entries()) {
        await writeSession(sessionKey, creator.id, {
          sessionId: `prepared-${index}`,
          updatedAt: index + 1,
          pluginOwnerId: "fixture",
        });
      }
      await run({ stateDir: state.stateDir, callerId: caller.id, creatorId: creator.id, keys });
    },
  );
}

function writeSession(
  sessionKey: string,
  owner: string,
  entry: Partial<SessionEntry> = {},
  agentId = "main",
  storePath?: string,
) {
  return upsertSessionEntryCore(
    { agentId, sessionKey, storePath },
    {
      sessionId: `${agentId}-${sessionKey}`,
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: owner },
      ...entry,
    },
  );
}

const suggestion = { suggestion: { author: { id: "someone-else" } } };

function eventClients(profileId: string) {
  return ["first", "second"].map((connId) => {
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
    const client = Object.assign(identifiedClient(profileId), {
      connId,
      socket,
    }) as unknown as GatewayWsClient;
    return { client, socket };
  });
}

async function prepareEventAccess(cfg: OpenClawConfig, eventConfig = () => cfg) {
  const context = requestContext(cfg);
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  await projection.prepareMembership();
  return {
    projection,
    receive(
      ...[client, sessionKeys, agentId, event, payload]: Parameters<
        NonNullable<Parameters<typeof createGatewayBroadcaster>[0]["canReceiveSessionEvent"]>
      >
    ) {
      return canReceiveSessionEvent({
        cfg: eventConfig(),
        client,
        sessionKeys,
        agentId,
        event,
        payload,
        prepared: {
          sharing: prepareProjectedSessionSharing({
            cfg,
            client,
            isMember: (target, identity) =>
              projection.hasMembership(target.storePath, target.storeKey, identity),
          }),
          target: (key, owner) => {
            const scope = resolveSessionEventAgentScope(cfg, key, owner);
            return scope?.[1] ? projection.sharingTarget({ key, agentId: scope[1] }) : null;
          },
        },
      });
    },
  };
}

describe("creator preparation at synchronous fan-out boundaries", () => {
  it("bounds cold/warm alias broadcast work", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      using _ = { [Symbol.dispose]: (await profileAliases.prepareUserProfileCatalog()).release };
      linkEmail("creator@preparation.test", callerId);
      profileAliases.readUserProfileAliases(callerId);
      const sessionKeys = ["prepared-0", keys[0]!].toSorted();
      const recipients = eventClients(callerId);
      const access = await prepareEventAccess({}, () => ({}));
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        canReceiveSessionEvent: (client, eventKeys, agentId, event, payload) => {
          const observer = observeAliasRootProbes(stateDir);
          const allowed = access.receive(client, eventKeys, agentId, event, payload);
          const probes = observer.finish();
          expect.soft(probes.aliasRootProbes).toBe(0);
          expect.soft(probes.otherRootProbes).toBeLessThanOrEqual(7);
          return allowed;
        },
      });
      for (let pass = 0; pass < 3; pass++) {
        broadcast("session.suggestion", suggestion, { sessionKeys, agentId: "main" });
      }
      for (const { socket } of recipients) {
        expect(socket.send).toHaveBeenCalledTimes(3);
        expect(socket.send.mock.calls.map(([frame]) => JSON.parse(String(frame)).seq)).toEqual([
          1, 2, 3,
        ]);
      }
    }, 1);
  });

  it("keeps warm typing events storage-free", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const sessionKey = keys[0]!;
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "draft" });
      profileAliases.readUserProfileAliases(callerId);
      const recipients = eventClients(callerId);
      const access = await prepareEventAccess({}, () => ({}));
      const subscribers = createSessionMessageSubscriberRegistry();
      for (const { client } of recipients) {
        subscribers.subscribe(client.connId, sessionKey);
      }
      let visible = false;
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        sessionMessageSubscribers: subscribers,
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) => {
          const observer = observeAliasRootProbes(stateDir);
          const allowed = access.receive(client, sessionKeys, agentId, event, payload);
          const probes = observer.finish();
          expect.soft(probes.otherRootProbes).toBe(0);
          expect(allowed).toBe(visible);
          return allowed;
        },
      });
      const emit = () => broadcast("session.typing", { sessionKey, agentId: "main", typing: true });
      emit();
      emit();
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "shared" });
      await access.projection.prepareMembership();
      visible = true;
      emit();
      for (const { socket } of recipients) {
        expect(socket.send).toHaveBeenCalledOnce();
      }
    }, 1);
  });

  it("rechecks stores and membership on reentry", async () => {
    await withCreatorRows(async ({ stateDir, callerId, keys }) => {
      const sessionKey = keys[0]!;
      const scope = { agentId: "main", sessionKey };
      const alternateStore = path.join(stateDir, "alternate/agents/main/sessions/sessions.json");
      await writeSession(
        sessionKey,
        "other-creator",
        { sessionId: "alternate" },
        "main",
        alternateStore,
      );
      addSessionMember(scope, { identityId: callerId, addedBy: "fixture" });
      const recipients = eventClients(callerId);
      const primaryConfig: OpenClawConfig = {};
      const alternateConfig: OpenClawConfig = { session: { store: alternateStore } };
      let primaryFacts = await prepareSessionMutationFacts({ cfg: primaryConfig, ...scope });
      const alternateFacts = await prepareSessionMutationFacts({ cfg: alternateConfig, ...scope });
      using _ = {
        [Symbol.dispose]: () => {
          primaryFacts.release();
          alternateFacts.release();
        },
      };
      let cfg = primaryConfig;
      const decisions: Array<[string, boolean]> = [];
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(recipients.map(({ client }) => client)),
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) => {
          const facts = () =>
            (cfg === primaryConfig ? primaryFacts : alternateFacts).readCurrent(cfg);
          const allowed = canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys,
            agentId,
            event,
            payload,
            prepared: {
              sharing: prepareProjectedSessionSharing({
                cfg,
                client,
                isMember: (_target, identity) => facts().membership.has(identity),
              }),
              target: () => facts().target,
            },
          });
          decisions.push([client.connId, allowed]);
          return allowed;
        },
      });
      const emit = () =>
        broadcast("session.suggestion", {
          suggestion: { sessionKey, agentId: "main", author: { id: "someone-else" } },
        });
      // Adversarial synchronous callback reentry, not ordinary network completion.
      recipients[0]!.socket.send.mockImplementationOnce(() => {
        cfg = alternateConfig;
        emit();
      });
      emit();
      expect(decisions).toEqual([
        ["first", true],
        ["first", false],
        ["second", false],
        ["second", false],
      ]);
      expect(recipients[0]!.socket.send).toHaveBeenCalledOnce();
      expect(recipients[1]!.socket.send).not.toHaveBeenCalled();
      cfg = primaryConfig;
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([2, 1]);
      removeSessionMember(scope, callerId);
      emit();
      primaryFacts.release();
      await closeOpenClawAgentDatabaseByPathAsync(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      primaryFacts = await prepareSessionMutationFacts({ cfg: primaryConfig, ...scope });
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([2, 1]);
      addSessionMember(scope, { identityId: callerId, addedBy: "fixture" });
      emit();
      expect(recipients.map(({ socket }) => socket.send.mock.calls.length)).toEqual([3, 2]);
    }, 1);
  });

  it("invalidates visibility on root replacement", async () => {
    await withCreatorRows(async ({ stateDir, creatorId, keys }) => {
      const sessionKey = keys[0]!;
      const client = eventClients(creatorId)[0]!.client;
      const receive = () =>
        canReceivePreparedSessionEvent({
          cfg: {},
          client,
          sessionKeys: keys,
          event: "session.suggestion",
          payload: suggestion,
        });
      expect(await receive()).toBe(true);
      // Disposal writes the shared registry; drain it before moving/recreating the root.
      await disposeOpenClawAgentDatabaseByPath(
        path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      );
      await cleanupSessionStateForTest({ stateDir });
      const legacyRoot = path.join(path.dirname(stateDir), ".clawdbot");
      fs.renameSync(stateDir, legacyRoot);
      expect(await receive()).toBe(false);
      fs.mkdirSync(stateDir);
      // Keep the visibility snapshot warm: suggestion roles must still select the new store.
      expect(await receive()).toBe(false);
      await writeSession(sessionKey, creatorId, { sessionId: "current-root" });
      expect(await receive()).toBe(true);
    }, 1);
  });

  it("isolates configured and sentinel stores", async () => {
    await withCreatorRows(async ({ callerId, creatorId, keys }) => {
      const cfg: OpenClawConfig = { agents: { entries: { work: {} } } };
      const workKey = "agent:work:prepared-work";
      const client = eventClients(creatorId)[0]!.client;
      const receive = (sessionKeys: string[], agentId?: string) =>
        access.receive(client, sessionKeys, agentId, "session.suggestion", suggestion);
      await writeSession(workKey, callerId, {}, "work");
      const workScope = { agentId: "work", sessionKey: workKey };
      addSessionMember(workScope, { identityId: creatorId, addedBy: callerId });
      const access = await prepareEventAccess(cfg);
      expect(receive([...keys, workKey])).toBe(true);
      removeSessionMember(workScope, creatorId);
      expect(receive([...keys, workKey])).toBe(false);
      expect(receive(keys)).toBe(true);
      await writeSession("global", creatorId);
      await writeSession("global", callerId, {}, "work");
      await access.projection.prepareMembership();
      for (let pass = 0; pass < 2; pass++) {
        expect(receive(["global"], "main")).toBe(true);
        expect(receive(["global"], "work")).toBe(false);
      }
    }, 1);
  });

  it("refreshes roles after row readiness", async () => {
    await withCreatorRows(async ({ callerId }) => {
      const client = identifiedClient(callerId);
      const context = requestContext({});
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      const original = projection.prepareSelection;
      const readiness = vi
        .spyOn(projection, "prepareSelection")
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          // Identity changes while the request awaits readiness, before selection and presentation.
          linkEmail("creator@preparation.test", callerId);
          return result;
        });
      const result = await listSessions({ client, context, request: { limit: 100 } });
      expect(readiness).toHaveBeenCalled();
      expect(result.sessions).toHaveLength(100);
      expect(result.sessions.every((row) => row.sharingRole === "owner")).toBe(true);
    });
  });

  it("refreshes preview aliases across yields", async () => {
    await withCreatorRows(async ({ callerId, keys }) => {
      const respond = vi.fn();
      const reader: GatewayOperatorRoleDefinition = {
        sessions: { others: "none" },
        agents: "*",
        scopes: ["operator.read"],
      };
      const context = requestContext({
        gateway: { roles: { default: "reader", definitions: { reader } } },
      });
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      // Start from requested rows so the test isolates the between-key alias change.
      for (const key of keys.slice(0, 2)) {
        expect(projection.describe({ agentId: "main", key })).toBeDefined();
      }
      const pending = sessionReadHandlers["sessions.preview"]?.({
        params: { keys: keys.slice(0, 2) },
        client: identifiedClient(callerId),
        context,
        respond,
      } as never);
      // The first key was denied synchronously; the second has not resumed from setImmediate.
      linkEmail("creator@preparation.test", callerId);
      await pending;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          previews: [
            { key: keys[0], status: "missing", items: [] },
            { key: keys[1], status: "empty", items: [] },
          ],
        }),
        undefined,
      );
    });
  });
});
