import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { setupPersistentSessionCreateTestHarness } from "./server.sessions.create.test-support.js";
import * as sharingAuthorization from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { gatewayReplyMock, rpcReq, testState } from "./test-helpers.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const publicationBoundary = vi.hoisted(
  (): {
    afterCold: (() => Promise<void>) | undefined;
    afterWarm: (() => Promise<void>) | undefined;
  } => ({ afterCold: undefined, afterWarm: undefined }),
);

vi.mock("./server-methods/session-create-idempotency.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-methods/session-create-idempotency.js")>();
  const idempotentSessionCreate: typeof actual.idempotentSessionCreate = (handler, replay) =>
    actual.idempotentSessionCreate(
      async (request) => {
        await handler(request);
        await publicationBoundary.afterCold?.();
      },
      replay
        ? async (request, result) => {
            const replayed = await replay(request, result);
            await publicationBoundary.afterWarm?.();
            return replayed;
          }
        : undefined,
    );
  return { ...actual, idempotentSessionCreate };
});

const { createSessionStoreDir, openClient } = setupPersistentSessionCreateTestHarness();
let storePath: string;
const resetPublicationBoundary = () => {
  publicationBoundary.afterCold = undefined;
  publicationBoundary.afterWarm = undefined;
};
beforeEach(async () => {
  resetPublicationBoundary();
  ({ storePath } = await createSessionStoreDir());
});
// This project shares a warm graph; no completed fixture may retain publication hooks.
afterEach(resetPublicationBoundary);

type CreatedSession = { key: string; sessionId: string; entry: SessionEntry; runStarted?: boolean };
const expectOk = (result: { ok: boolean }) => expect(result.ok).toBe(true);
function readEntry(sessionKey = "agent:main:main") {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

test("sessions.create publishes absent access canonically before a read and turn", async () => {
  testState.sessionConfig = undefined;
  const key = "agent:main:dashboard:canonical-absent-access";
  const owner = await import("./session-create-service.js");
  const create = owner.createGatewaySession;
  const committed: SessionEntry[] = [];
  using observe = vi.spyOn(owner, "createGatewaySession").mockImplementation((params) =>
    create({
      ...params,
      onCreatedSessionCommitted(session) {
        committed.push(structuredClone(session.entry));
        params.onCreatedSessionCommitted?.(session);
      },
    }),
  );
  const { ws } = await openClient();
  try {
    const created = await rpcReq<CreatedSession>(ws, "sessions.create", { key, agentId: "main" });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
    expect(committed).toHaveLength(1);
    expect(Object.hasOwn(committed[0]!, "access")).toBe(false);
    const stored = readEntry(key);
    expect(stored?.sessionId).toBe(created.payload?.sessionId);
    expect(Object.hasOwn(stored!, "access")).toBe(false);
    expectOk(await rpcReq(ws, "chat.history", { sessionKey: key, limit: 10 }));
    expectOk(
      await rpcReq(ws, "chat.send", {
        sessionKey: key,
        message: "turn after canonical creation",
        idempotencyKey: "canonical-absent-access-turn",
      }),
    );
    await vi.waitFor(() =>
      expect(gatewayReplyMock.mock.calls.some(([ctx]) => ctx.SessionKey === key)).toBe(true),
    );
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
});

test.each(["requester", "membership"] as const)(
  "durable replay refuses %s revocation after authorization and before metadata disclosure",
  async (change) => {
    const client = roleClient("view", "durable-replay-member");
    const profileId = client.authenticatedUserProfile!.profileId;
    const creator = ensureProfileForEmail("durable-replay-creator@example.test").id;
    const key = "agent:main:dashboard:restricted-replay";
    const scope = { agentId: "main", storePath, sessionKey: key };
    replaceSessionEntrySync(scope, {
      sessionId: "restricted-original",
      lifecycleRevision: "original",
      updatedAt: 1,
      label: "Private replay metadata",
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: creator },
    });
    await addSessionMember(scope, { identityId: profileId, addedBy: creator });
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    const deviceOwner = {};
    const source = captureGatewayDeviceRevocation(
      deviceOwner,
      { deviceId: "replay-device", role: "operator" },
      () => true,
    );
    const request = () =>
      directSessionReq<CreatedSession>(
        "sessions.create",
        {
          agentId: "main",
          key,
          idempotencyKey: "restricted-replay-once",
        },
        {
          client,
          hasCurrentClientAuthority: source.isCurrent,
          // Distinct context removes the process-local cache without manufacturing a receipt.
          context: { dedupe: new Map(), getRuntimeConfig: () => cfg },
        },
      );
    try {
      expectOk(await request());
      expect(await request()).toMatchObject({
        ok: true,
        payload: {
          key,
          sessionId: "restricted-original",
          creationReplayed: true,
          entry: { label: "Private replay metadata" },
        },
      });
      const authorize = sharingAuthorization.resolveSessionMutationAuthorizationAsync;
      let revoked = false;
      // Delay only completion: real policy, membership writer, and revocation owner run unchanged.
      using _ = vi
        .spyOn(sharingAuthorization, "resolveSessionMutationAuthorizationAsync")
        .mockImplementation(async (input) => {
          const result = await authorize(input);
          if (input.method === "sessions.create" && input.expectedTarget && !revoked) {
            expect(result.error).toBeNull();
            expect(result.authorization).toBeDefined();
            revoked = true;
            if (change === "requester") {
              invalidateGatewayDeviceRevocation(deviceOwner, "replay-device", "operator");
            } else {
              expect(await removeSessionMember(scope, profileId)).toMatchObject({
                identityId: profileId,
              });
            }
          }
          return result;
        });
      const refused = await request();
      expect(revoked).toBe(true);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.payload).toBeUndefined();
      expect(JSON.stringify(refused)).not.toContain("Private replay metadata");
      expect(readEntry(key)?.sessionId).toBe("restricted-original");
      console.info(
        `PASS durable replay ${change} revoked after live authorization: no session metadata disclosed`,
      );
    } finally {
      source.release();
    }
  },
);

test.each(["cold", "warm"] as const)(
  "durable %s replay refuses membership removal at final response publication",
  async (cache) => {
    const client = roleClient("view", "publication-replay-member");
    const profileId = client.authenticatedUserProfile!.profileId;
    const creator = ensureProfileForEmail("publication-replay-creator@example.test").id;
    const key = "agent:main:dashboard:publication-replay";
    const scope = { agentId: "main", storePath, sessionKey: key };
    replaceSessionEntrySync(scope, {
      sessionId: "publication-original",
      lifecycleRevision: "publication-original",
      updatedAt: 1,
      label: "Original replay metadata",
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: creator },
    });
    await addSessionMember(scope, { identityId: profileId, addedBy: creator });
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    const context = { dedupe: new Map(), getRuntimeConfig: () => cfg };
    const request = () =>
      directSessionReq<CreatedSession>(
        "sessions.create",
        { agentId: "main", key, idempotencyKey: "publication-replay-once" },
        {
          client,
          context: cache === "warm" ? context : { ...context, dedupe: new Map() },
        },
      );
    expectOk(await request());
    expect(await request()).toMatchObject({
      ok: true,
      payload: {
        key,
        sessionId: "publication-original",
        entry: { label: "Original replay metadata" },
      },
    });
    let removals = 0;
    // Decorate only completion: real replay authorization, idempotency, and membership writes run.
    // The handoff remains after replay preparation even when cleanup moves past publication.
    publicationBoundary[cache === "warm" ? "afterWarm" : "afterCold"] = async () => {
      expect(await removeSessionMember(scope, profileId)).toMatchObject({ identityId: profileId });
      removals++;
    };
    const denied = await request();
    expect(removals).toBe(1);
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      },
    });
    expect(denied.payload).toBeUndefined();
    expect(JSON.stringify(denied)).not.toContain("Original replay metadata");
    expect(readEntry(key)?.sessionId).toBe("publication-original");
    console.info(
      `PASS ${cache} replay membership removal at final callback: no metadata published`,
    );
  },
);
