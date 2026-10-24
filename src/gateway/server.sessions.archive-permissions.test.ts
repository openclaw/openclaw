import { expect, test, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
type Entry = Parameters<typeof sessionStoreEntry>[1];

async function request(
  method: "sessions.patch" | "sessions.patchMany",
  client: GatewayClient,
  context: GatewayRequestContext,
  keys: string[],
  patch: Record<string, unknown>,
) {
  const respond = vi.fn();
  const storePath = context.getRuntimeConfig().session?.store;
  const targets = keys.map((key) => ({
    key,
    expectedSessionId: loadSessionEntry({ sessionKey: key, storePath })?.sessionId,
  }));
  const params = method === "sessions.patchMany" ? { targets, patch } : { ...targets[0], ...patch };
  const req = { type: "req" as const, id: "archive-permissions", method, params };
  await handleGatewayRequest({ req, client, context, isWebchatConnect: () => false, respond });
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
    const shared = (id: string, actorId: string, extra: Entry = {}) =>
      sessionStoreEntry(id, {
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: actorId },
        ...extra,
      });
    await writeSessionStore({
      entries: {
        [ownKey]: shared("member-created", memberId),
        [foreignKey]: shared("foreign-created", creatorId, {
          owner: { actor: { type: "human", id: memberId } },
        }),
        [restoredKey]: shared("foreign-archived", creatorId, { archivedAt: 1 }),
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

test("archiving a non-default agent ignores the compatibility owner's ownerless run", async () => {
  const { storePath } = await createSessionStoreDir();
  const cfg = retainLegacyDefaultAgentId(
    {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: storePath },
    },
    "ops",
  );
  const sessionKey = "agent:research:archive-owner-scope";
  const sessionId = "session-archive-owner-scope";
  await writeSessionStore({
    agentId: "research",
    entries: { [sessionKey]: sessionStoreEntry(sessionId) },
    storePath,
  });

  const compatibilityRun = registerChatAbortController({
    runId: "run-ops-ownerless",
    sessionId,
    sessionKey: "legacy-unscoped",
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey: "legacy-unscoped",
      agentId: "ops",
      incarnation: sessionId,
    }),
    timeoutMs: 60_000,
  });

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true, expectedSessionId: sessionId },
    {
      context: {
        cancelRunBoundApprovals: vi.fn(),
        getRuntimeConfig: () => cfg,
      },
    },
  );

  expect(archived.ok, JSON.stringify(archived)).toBe(true);
  expect(compatibilityRun.controller.signal.aborted).toBe(false);
});
