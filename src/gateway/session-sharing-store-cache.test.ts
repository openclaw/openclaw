import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as targetsDiscovery from "../config/sessions/targets-discovery.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  initializeSessionReadContext,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import {
  canReceiveSessionEvent,
  prepareProjectedSessionSharing,
  resolveSessionSharingTargetAsync,
} from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";

const authorizationReleases: Array<() => void> = [];

afterEach(() => {
  for (const release of authorizationReleases.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

async function captureMutationAuthorization(
  params: Parameters<typeof resolveSessionMutationAuthorizationAsync>[0],
) {
  const result = await resolveSessionMutationAuthorizationAsync(params);
  if (result.authorization?.release) {
    authorizationReleases.push(result.authorization.release);
  }
  return result;
}

function identifiedClient(userId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: userId,
    authenticatedUserProfile: {
      profileId: userId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

describe("session event authorization store work", () => {
  it("does not capture a replacement for an already prepared mutation target", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {};
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:prepared-target" };
      const entry = {
        sessionId: "prepared-session",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" } as const,
      };
      await sessionAccessor.upsertSessionEntryCore(scope, entry);
      // Drain setup's deferred maintenance before observing the worker-backed target read.
      await closeOpenClawAgentDatabasesAsync(state.env.OPENCLAW_STATE_DIR);
      const reads = observeHostDataSql();
      let target;
      try {
        target = await resolveSessionSharingTargetAsync({ cfg, ...scope });
        expect(reads.queries).toEqual([]);
      } finally {
        reads.restore();
      }
      if (!target) {
        throw new Error("prepared target was not created");
      }
      const params = {
        client: identifiedClient("owner"),
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => cfg } as never,
        method: "chat.send",
        requestParams: scope,
      };
      const expectedTarget = {
        ...scope,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
        sessionId: entry.sessionId,
      };
      const original = await captureMutationAuthorization({
        ...params,
        expectedTarget,
      });
      expect(original.error).toBeNull();
      expect(original.authorization).toBeDefined();
      await sessionAccessor.upsertSessionEntryCore(scope, { ...entry, sessionId: "replacement" });
      expect((await captureMutationAuthorization(params)).error).toBeNull();
      const replacement = await captureMutationAuthorization({
        ...params,
        expectedTarget,
      });
      expect(replacement.error).toMatchObject({
        details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" },
      });
      expect(replacement.authorization).toBeUndefined();
      expect(() => original.authorization?.assertCurrent()).toThrow("session changed");
    });
  });

  it.each([1, 32])(
    "bounds metadata work for %i event targets while refreshing membership",
    async (targetCount) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const keys = Array.from(
          { length: 64 },
          (_, index) => `agent:main:event-${targetCount}-${index}`,
        );
        const sessionKeys = keys.slice(0, targetCount);
        for (const sessionKey of keys) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: sessionKey,
              updatedAt: 1,
              visibility: "suggest",
              createdActor: { type: "human", source: "profile", id: "owner" },
            },
          );
        }
        for (const sessionKey of sessionKeys) {
          addSessionMember(
            { agentId: "main", sessionKey },
            { identityId: "member", addedBy: "owner" },
          );
        }
        sessionAccessor.listSessionEntriesCore({
          agentId: "main",
          clone: false,
          projection: "list",
        });
        const materializedKeys: string[] = [];
        const context = requestContext({});
        await initializeSessionReadContext(context);
        const projection = getSessionRowProjection(context)!;
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        const listEntries = sessionAccessor.listSessionEntriesCore;
        vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation((scope) => {
          const entries = listEntries(scope);
          materializedKeys.push(...entries.map(({ sessionKey }) => sessionKey));
          return entries;
        });
        const receive = (user: string, event = "session.suggestion") => {
          const client = identifiedClient(user);
          return canReceiveSessionEvent({
            cfg: {},
            client,
            sessionKeys,
            event,
            payload: { suggestion: { author: { id: "author" } } },
            prepared: {
              sharing: prepareProjectedSessionSharing({
                cfg: {},
                client,
                isMember: (target, id) =>
                  projection.hasMembership(target.storePath, target.storeKey, id),
              }),
              target: (key) => projection.sharingTarget({ key, agentId: "main" }),
            },
          });
        };
        expect(receive("member", "session.message")).toBe(true);
        materializedKeys.length = 0;
        expect(receive("member", "session.message")).toBe(true);
        expect(materializedKeys).toEqual([]);

        const checkRecipient = (user: string, allowed: boolean) => {
          materializedKeys.length = 0;
          expect(receive(user)).toBe(allowed);
          // Sparse events must not enumerate unrelated rows; dense checks share one store view.
          expect(materializedKeys.length).toBeLessThanOrEqual(targetCount === 1 ? 0 : keys.length);
        };
        checkRecipient("member", true);
        checkRecipient("owner", true);
        checkRecipient("viewer", false);
        checkRecipient("author", true);
        const revokedKey = sessionKeys.at(-1)!;
        removeSessionMember({ agentId: "main", sessionKey: revokedKey }, "member");
        checkRecipient("member", false);
        addSessionMember(
          { agentId: "main", sessionKey: revokedKey },
          { identityId: "member", addedBy: "owner" },
        );
        checkRecipient("member", true);
      });
    },
  );
});

describe("session mutation authorization store caches", () => {
  it.each(["sessions.patch", "chat.send", "sessions.patchMany"])(
    "bounds single-target metadata work and refreshes every %s guard",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const sessionKey = "agent:main:scalar-authorization";
        const entry = { sessionId: "scalar-authorization", updatedAt: 1 };
        await sessionAccessor.upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
        for (let index = 0; index < 24; index += 1) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
            { sessionId: `unrelated-${index}`, updatedAt: 1 },
          );
        }
        sessionAccessor.listSessionEntriesCore({
          agentId: "main",
          clone: false,
          projection: "list",
        });
        const context = requestContext({});
        await initializeSessionReadContext(context);
        await getSessionRowProjection(context)!.prepareMembership();
        const inventory = vi.spyOn(sessionAccessor, "listSessionEntriesCore");
        const result = await captureMutationAuthorization({
          client: identifiedClient("viewer@example.test"),
          method,
          requestParams:
            method === "sessions.patchMany"
              ? { targets: [{ key: sessionKey }], patch: { unread: false } }
              : method === "sessions.patch"
                ? { key: sessionKey, unread: false }
                : { sessionKey },
          context,
        });
        expect(result.error).toBeNull();
        expect(result.authorization).toBeDefined();
        expect(() => result.authorization!.assertCurrent()).not.toThrow();
        expect(() => result.authorization!.assertCurrent()).not.toThrow();
        expect(inventory).not.toHaveBeenCalled();

        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { ...entry, updatedAt: 2, visibility: "draft" },
        );
        expect(() => result.authorization!.assertCurrent()).toThrow(
          "session is draft for this connection",
        );
      });
    },
  );

  it.each([
    { key: "agent:research:main", agentId: undefined, expectedAgent: "research" },
    { key: "global", agentId: "research", expectedAgent: "research" },
    { key: "global", agentId: undefined, expectedAgent: "ops" },
    { key: "agent:research:ordinary", agentId: undefined, expectedAgent: "research" },
    { key: "agent:research:ordinary", agentId: " ", expectedAgent: "research" },
    { key: "agent:main:main", agentId: " ", expectedAgent: "ops" },
  ])("preserves the requested owner for $key with explicit agent $agentId", async (target) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
            authInheritance: { agentId: "ops" },
          },
          entries: { ops: { workspace: state.statePath("workspace") }, research: {} },
        },
        talk: { agentId: "ops" },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      for (const agentId of ["ops", "research"]) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId, sessionKey: "global" },
          { sessionId: `global-${agentId}`, updatedAt: 1 },
        );
      }
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "research", sessionKey: "agent:research:ordinary" },
        { sessionId: "ordinary-research", updatedAt: 1 },
      );
      const resolved = await resolveGatewaySessionStoreTargetWithStoreAsync({
        cfg,
        key: target.key,
        agentId: target.agentId,
        readOnly: true,
        exactRead: true,
      });
      const canonicalKey = target.key.endsWith(":ordinary") ? target.key : "global";
      expect(resolved).toMatchObject({
        agentId: target.expectedAgent,
        canonicalKey,
        store: {
          [canonicalKey]: {
            sessionId: `${canonicalKey === "global" ? "global" : "ordinary"}-${target.expectedAgent}`,
          },
        },
      });
    });
  });

  it.each(["research", "ops"])(
    "checks %s participation in the selected global publication",
    async (viewer) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          session: { scope: "global" },
          agents: {
            ownership: "explicit",
            defaults: {
              heartbeat: { agentId: "ops" },
              systemAgent: { agentId: "ops" },
              authInheritance: { agentId: "ops" },
            },
            entries: { ops: { workspace: state.statePath("workspace") }, research: {} },
          },
          talk: { agentId: "ops" },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        for (const agentId of ["ops", "research"]) {
          await sessionAccessor.upsertSessionEntryCore(
            { agentId, sessionKey: "global" },
            {
              sessionId: `global-${agentId}`,
              updatedAt: 1,
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: `${agentId}@example.test` },
            },
          );
        }
        const context = requestContext(cfg);
        await initializeSessionReadContext(context);
        await getSessionRowProjection(context)!.prepareMembership();
        const client = identifiedClient(`${viewer}@example.test`);
        const scoped = await captureMutationAuthorization({
          client,
          method: "sessions.github.publish",
          requestParams: { sessionKey: "global", agentId: "research" },
          context,
        });
        if (viewer === "research") {
          expect(scoped.error).toBeNull();
        } else {
          expect(scoped.error).toMatchObject({
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          });
        }
        const alias = await captureMutationAuthorization({
          client,
          method: "sessions.github.publish",
          requestParams: { sessionKey: "agent:research:main" },
          context,
        });
        if (viewer === "research") {
          expect(alias.error).toBeNull();
          expect(alias.authorization).toBeDefined();
          expect(() => alias.authorization?.assertCurrent()).not.toThrow();
        } else {
          expect(alias.error).toMatchObject({
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          });
          expect(alias.authorization).toBeUndefined();
        }
      });
    },
  );

  it("fails a patchMany request when a nested target is incognito", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:dashboard:incognito-patch-many";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-incognito", updatedAt: 1, incognito: true },
      );
      const result = await captureMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: sessionKey, agentId: "main" }],
          patch: { archived: true },
        },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });
      expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
    });
  });

  it("authorizes every patchMany target before dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sharedKey = "agent:main:batch-shared";
      const draftKey = "agent:main:batch-private";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: sharedKey },
        { sessionId: "session-shared", updatedAt: 1, visibility: "shared" },
      );
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: draftKey },
        {
          sessionId: "session-private",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      const context = requestContext({});
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      const result = await captureMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: sharedKey }, { key: draftKey }],
          patch: { unread: false },
        },
        context,
      });

      expect(result.authorization).toBeUndefined();
      expect(result.error).toMatchObject({
        code: "INVALID_REQUEST",
        details: { code: "SESSION_PARTICIPATION_REQUIRED", sessionKey: draftKey },
      });
    });
  });

  it("reuses metadata for padded patchMany targets and fences replacements", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:padded-batch-target";
      const prompt = "authorization does not need this prompt snapshot".repeat(512);
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-original",
          updatedAt: 1,
          visibility: "shared",
          skillsSnapshot: { prompt, skills: [] },
        },
      );
      const target = { sessionKey: ` ${sessionKey} `, agentId: " main " };
      const context = requestContext({});
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      const result = await captureMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: {
          targets: [{ key: target.sessionKey, agentId: target.agentId }],
          patch: { unread: false },
        },
        context,
      });

      expect(result.error).toBeNull();
      expect(result.authorization).toBeDefined();
      const authorization = result.authorization!;
      const parseSpy = vi.spyOn(JSON, "parse");
      expect(() => authorization.assertTargetCurrent(target)).not.toThrow();
      expect(parseSpy.mock.calls.some(([serialized]) => serialized.includes(prompt))).toBe(false);
      parseSpy.mockRestore();

      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-replacement", updatedAt: 2, visibility: "shared" },
      );

      expect(() => authorization.assertTargetCurrent(target)).toThrow(
        "session changed before sessions.patchMany; retry the request",
      );
    });
  });

  it("bounds malformed patchMany target discovery before schema validation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const hiddenKey = "agent:main:dashboard:incognito-over-limit";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: hiddenKey },
        { sessionId: "session-hidden", updatedAt: 1, incognito: true },
      );
      const targets = Array.from({ length: 101 }, (_, index) => ({
        key: `agent:main:over-limit-${index}`,
      }));
      targets.push({ key: hiddenKey });

      const result = await captureMutationAuthorization({
        client: identifiedClient("viewer@example.com"),
        method: "sessions.patchMany",
        requestParams: { targets, patch: { archived: true } },
        context: { chatAbortControllers: new Map(), getRuntimeConfig: () => ({}) } as never,
      });

      expect(result.error).toBeNull();
      expect(result.authorization).toBeDefined();
    });
  });

  it("uses resident metadata when one request resolves multiple targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      for (const [sessionKey, sessionId] of [
        ["agent:main:cache-one", "session-cache-one"],
        ["agent:main:cache-two", "session-cache-two"],
      ] as const) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId, updatedAt: 1, visibility: "shared", category: "Cache Test" },
        );
      }

      const context = requestContext(cfg);
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();

      const materializations = new Map<string, number>();
      const originalListSessionEntries = sessionAccessor.listSessionEntriesCore;
      vi.spyOn(sessionAccessor, "listSessionEntriesCore").mockImplementation((scope) => {
        const entries = originalListSessionEntries(scope);
        if (scope?.clone === false) {
          const storePath = scope.storePath ?? "default";
          materializations.set(storePath, (materializations.get(storePath) ?? 0) + 1);
        }
        return entries;
      });
      const discoverySpy = vi.spyOn(
        targetsDiscovery,
        "resolveExistingAgentSessionStoreTargetsSync",
      );

      expect(
        (
          await captureMutationAuthorization({
            client: identifiedClient("viewer@example.com"),
            method: "sessions.groups.delete",
            requestParams: { name: "Cache Test" },
            context,
          })
        ).error,
      ).toBeNull();

      expect([...materializations.values()]).toEqual([]);
      expect(discoverySpy.mock.calls.filter((call) => call[1] === "main")).toHaveLength(0);
    });
  });
});
