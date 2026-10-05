import { expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import {
  activeRunContext,
  waitForArchivePhase,
} from "./server.sessions.archive-lifecycle.test-support.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["sessions.patch", "sessions.patchMany"] as const)(
  "%s requires an explicit archive grant before cancelling owned work",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const key = "agent:main:archive-capability";
    const client = roleClient("view", "archive-capability");
    client.connect.scopes = ["operator.sessions.write"];
    const cfg = { ...rolePolicyConfig(), session: { store: storePath } };
    await writeSessionStore({
      entries: {
        [key]: sessionStoreEntry("archive-capability", {
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        }),
      },
    });
    const persistence = createDeferredCore();
    const active = activeRunContext({
      sessionKey: key,
      sessionId: "archive-capability",
      runId: "archive-capability-run",
      persistence,
    });
    try {
      const context = createDirectChatContext({ ...active.context, getRuntimeConfig: () => cfg });
      await initializeSessionReadContext(context);
      for (const archived of [true, false]) {
        expect(
          await request(method, client, context, [key], { archived, icon: "book" }),
        ).toMatchObject([
          false,
          undefined,
          { code: "FORBIDDEN", details: { missingScope: "operator.sessions.archive" } },
        ]);
        expect(active.controller.signal.aborted).toBe(false);
        expectNoSessionQueueCleanup();
        expect(loadSessionEntry({ sessionKey: key, storePath })?.archivedAt).toBeUndefined();
      }
      const organized = await request(method, client, context, [key], { icon: "book" });
      expect(organized?.[0]).toBe(true);
      if (method === "sessions.patchMany") {
        expect(organized?.[1]).toMatchObject({ outcomes: [{ ok: true }] });
      }
      expect(loadSessionEntry({ sessionKey: key, storePath })?.icon).toBe("book");
    } finally {
      persistence.resolve();
      active.unsubscribe();
    }
  },
);

test("rechecks the archive capability after an active run drains", async ({ signal }) => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:archive-revocation";
  const client = roleClient("view", "archive-revocation");
  client.connect.scopes = ["operator.sessions.write", "operator.sessions.archive"];
  const cfg = { ...rolePolicyConfig(), session: { store: storePath } };
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry("archive-revocation", {
        createdActor: {
          type: "human",
          source: "profile",
          id: client.authenticatedUserProfile!.profileId,
        },
      }),
    },
  });
  const persistence = createDeferredCore();
  const active = activeRunContext({
    sessionKey: key,
    sessionId: "archive-revocation",
    runId: "archive-revocation-run",
    persistence,
  });
  const context = createDirectChatContext({ ...active.context, getRuntimeConfig: () => cfg });
  await initializeSessionReadContext(context);
  const pending = request("sessions.patch", client, context, [key], { archived: true });
  try {
    await waitForArchivePhase(active.terminalStarted, pending, signal);
    cfg.gateway!.roles!.definitions.view!.scopes = ["operator.sessions.write"];
    persistence.resolve();
    expect(await pending).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.archivedAt).toBeUndefined();
  } finally {
    persistence.resolve();
    await Promise.allSettled([pending]);
    active.unsubscribe();
  }
});

async function request(
  method: "sessions.patch" | "sessions.patchMany",
  client: GatewayClient,
  context: GatewayRequestContext,
  keys: string[],
  patch: Record<string, unknown>,
) {
  const respond = vi.fn();
  const targets = keys.map((key) => ({
    key,
    expectedSessionId: loadSessionEntry({
      sessionKey: key,
      storePath: context.getRuntimeConfig().session?.store,
    })?.sessionId,
  }));
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "archive-permissions",
      method,
      params: method === "sessions.patchMany" ? { targets, patch } : { ...targets[0], ...patch },
    },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0];
}

test.each(["sessions.patch", "sessions.patchMany"] as const)(
  "%s restricts archive and restore to creators and admins through the gateway router",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const creator = roleClient("view", "archive-creator");
    const member = roleClient("write", "archive-member");
    const creatorId = creator.authenticatedUserProfile!.profileId;
    const memberId = member.authenticatedUserProfile!.profileId;
    const adminProfile = ensureProfileForEmail("archive-admin@example.test");
    setUserProfileRole(adminProfile.id, "admin");
    const admin = sharingPolicyClient({ user: adminProfile.id, scopes: ["operator.admin"] });
    const ownKey = "agent:main:archive-member-created";
    const foreignKey = "agent:main:archive-foreign-created";
    const restoredKey = "agent:main:archive-foreign-archived";
    const cfg = { ...rolePolicyConfig(), session: { store: storePath } };
    cfg.gateway!.roles!.definitions.admin = {
      sessions: { others: "write" },
      agents: "*",
      scopes: ["operator.admin"],
    };
    await writeSessionStore({
      entries: {
        [ownKey]: sessionStoreEntry("member-created", {
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: memberId },
        }),
        [foreignKey]: sessionStoreEntry("foreign-created", {
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: creatorId },
          owner: { actor: { type: "human", id: memberId } },
        }),
        [restoredKey]: sessionStoreEntry("foreign-archived", {
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: creatorId },
          archivedAt: 1,
        }),
      },
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    await initializeSessionReadContext(context);
    const read = (sessionKey: string) => loadSessionEntry({ sessionKey, storePath });
    const before = [ownKey, foreignKey, restoredKey].map(read);

    for (const [archived, key] of [
      [true, foreignKey],
      [false, restoredKey],
    ] as const) {
      const keys = method === "sessions.patchMany" ? [ownKey, key] : [key];
      const result = await request(method, member, context, keys, { archived });
      expect(result).toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
      expect([ownKey, foreignKey, restoredKey].map(read)).toEqual(before);
      expectNoSessionQueueCleanup();
    }

    expect((await request(method, member, context, [foreignKey], { pinned: true }))?.[0]).toBe(
      true,
    );
    expect(read(foreignKey)?.pinnedAt).toEqual(expect.any(Number));
    for (const [role, client, key] of [
      ["member creator", member, ownKey],
      ["creator", creator, foreignKey],
      ["admin", admin, foreignKey],
    ] as const) {
      for (const archived of [true, false]) {
        const result = await request(method, client, context, [key], { archived });
        expect(result?.[0], JSON.stringify({ method, role, key, archived, result })).toBe(true);
        expect(read(key)?.archivedAt).toEqual(archived ? expect.any(Number) : undefined);
      }
    }
  },
);

test("keeps identityless solo archive and restore available", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:archive-solo";
  await writeSessionStore({ entries: { [key]: sessionStoreEntry("solo") } });
  const cfg = { session: { store: storePath } };
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  await initializeSessionReadContext(context);
  for (const archived of [true, false]) {
    expect(
      (await request("sessions.patch", sharingPolicyClient({}), context, [key], { archived }))?.[0],
    ).toBe(true);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.archivedAt).toEqual(
      archived ? expect.any(Number) : undefined,
    );
  }
});
