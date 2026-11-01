import { expect, it, vi } from "vitest";
import { validateUsersMentionableResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as userProfileReads from "../state/user-profile-reads.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  SESSION_KEY,
  expectMentionError,
  SESSION_ID,
  withMentionInbox as withInbox,
  mentionRoles,
} from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type MentionFixture = Parameters<Parameters<typeof withInbox>[0]>[0];

const directoryParams = (query = "Alice", sessionKey = SESSION_KEY) => ({ sessionKey, query });
const syncBob = (login: string, accountId = 42, email = "bob@mentions.example.test") =>
  syncGitHubIdentity({
    identity: { accountId, login },
    authenticationAlias: { kind: "email", email },
  });

function expectUsers(response: unknown, users: unknown[]) {
  expect(response).toMatchObject({ ok: true, payload: { users } });
}

async function searchDirectory(f: MentionFixture, query: string, sessionKey = SESSION_KEY) {
  const response = await f.call(
    "users.mentionable",
    directoryParams(query, sessionKey),
    f.aliceClient,
  );
  if (!response.ok || !validateUsersMentionableResult(response.payload)) {
    throw new Error("Invalid mention directory response");
  }
  return response.payload;
}

async function withHeldDirectory(
  f: MentionFixture,
  query: string,
  client: MentionFixture["bobClient"],
  change: () => void | Promise<void>,
) {
  const readDirectory = userProfileReads.readUserProfileDirectory;
  const ready = createDeferred();
  const release = createDeferred();
  const spy = vi
    .spyOn(userProfileReads, "readUserProfileDirectory")
    .mockImplementationOnce(async (...args) => {
      const result = readDirectory(...args);
      void result.then(() => ready.resolve(), ready.reject);
      await result;
      await release.promise;
      return result;
    });
  const pending = f.call("users.mentionable", directoryParams(query), client);
  try {
    await ready.promise;
    await change();
    release.resolve();
    return await pending;
  } finally {
    release.resolve();
    await pending;
    spy.mockRestore();
  }
}

it("keeps requester invalidation current at final RPC publication", () =>
  withInbox(async (f) => {
    const params = directoryParams();
    expectUsers(await f.call("users.mentionable", params), [{ profileId: f.alice.id }]);
    let changed = false;
    const frames: { ok: boolean; changed: boolean }[] = [];
    const revocation = Promise.resolve().then(() => {
      Object.assign(f.bobClient, { invalidated: true });
      changed = true;
    });
    try {
      await f.call("users.mentionable", params, f.bobClient, (ok) => {
        frames.push({ ok, changed });
      });
    } finally {
      await revocation;
    }
    expect(frames).toHaveLength(1);
    expect(frames.some((frame) => frame.ok && frame.changed)).toBe(false);
    expectMentionError(await f.call("users.mentionable", params), "FORBIDDEN");
  }));

it("propagates a response exception once after directory preparation fails", () =>
  withInbox(async (f) => {
    const params = directoryParams();
    const readFailure = vi
      .spyOn(userProfileReads, "readUserProfileDirectory")
      .mockRejectedValueOnce(new Error("synthetic directory failure"));
    const responseError = new Error("synthetic response failure");
    const onResponse = vi.fn<GatewayRequestHandlerOptions["respond"]>((ok, _payload, error) => {
      expect({ ok, error }).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      throw responseError;
    });
    try {
      await expect(f.call("users.mentionable", params, f.bobClient, onResponse)).rejects.toBe(
        responseError,
      );
      expect(onResponse).toHaveBeenCalledTimes(1);
    } finally {
      readFailure.mockRestore();
    }
  }));

it("discards a completed directory read when a linked handle changes before selection", () =>
  withInbox(async (f) => {
    syncBob("bob-before");
    const response = await withHeldDirectory(f, "bob-after", f.aliceClient, () => {
      syncBob("bob-after");
      setDisplayName(f.bob.id, "Robert Updated");
    });
    expectUsers(response, [{ profileId: f.bob.id, displayName: "Robert Updated" }]);
    expect(await searchDirectory(f, "bob-before")).toMatchObject({ users: [] });
  }));

it.each([
  { change: "requester invalidation", code: "FORBIDDEN" },
  { change: "session visibility", code: "INVALID_REQUEST" },
  { change: "disposal", code: "UNAVAILABLE" },
] as const)("rechecks $change after directory preparation", async ({ change, code }) => {
  await withInbox(async (f) => {
    const response = await withHeldDirectory(f, "Alice", f.bobClient, async () => {
      if (change === "requester invalidation") {
        Object.assign(f.bobClient, { invalidated: true });
      } else if (change === "session visibility") {
        await f.setSession({ visibility: "draft" });
      } else {
        await f.inbox.dispose();
      }
    });
    expectMentionError(response, code);
  });
});

it("resolves verified handles and optional full names without exposing account data", () =>
  withInbox(async (f) => {
    syncBob("bobby");
    setDisplayName(f.bob.id, "Robert Example");
    syncBob("bob-work", 43, "bob-work@mentions.example.test");
    linkEmail("bob-work@mentions.example.test", f.bob.id);
    for (const query of ["bobby", "BOBBY", "bob-work", "Robert Example"]) {
      const { users } = await searchDirectory(f, query);
      expect(users).toEqual([
        {
          profileId: f.bob.id,
          displayName: "Robert Example",
          avatarUrl: expect.any(String),
          online: true,
        },
      ]);
    }
    expect(
      f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
    ).toEqual({ ok: true, value: [f.bob.id] });
    syncBob("robert-new");
    setDisplayName(f.bob.id, null);
    expect(await searchDirectory(f, "bobby")).toMatchObject({ users: [] });
    expect(await searchDirectory(f, "robert-new")).toMatchObject({
      users: [{ profileId: f.bob.id, displayName: "robert-new" }],
    });
  }));

it("includes offline people without leaking administrative profile fields or binding raw presence", () =>
  withInbox(async (f) => {
    const offline = ensureProfileForEmail("offline@mentions.example.test");
    setDisplayName(offline.id, "Bob");
    f.clients.push({ ...soloClient(), authenticatedUserId: offline.id, connId: "raw-offline" });
    const { users } = await searchDirectory(f, "Bob");
    expect(users.map((user) => [user.profileId, user.online])).toEqual([
      [f.bob.id, true],
      [offline.id, false],
    ]);
    expect(new Set(users.map((user) => user.displayName)).size).toBe(2);
    const fields = ["avatarUrl", "displayName", "online", "profileId"];
    for (const user of users) {
      expect(Object.keys(user).toSorted()).toEqual(fields);
    }
  }));

it.each([
  ["administrator", "", "draft", undefined, true],
  ["owner-only", "", "shared", undefined, false],
  ["administrator", "mention-incognito-flag", "shared", true, false],
  ["administrator", "incognito-mention-key", "shared", undefined, false],
] as const)(
  "applies offline recipient policy across directory, admission, and delivery: %s %s %s",
  async (role, suffix, visibility, incognito, visible) => {
    const cfg = mentionRoles({
      "owner-only": { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
      administrator: { agents: "*", scopes: ["operator.admin"], sessions: { others: "none" } },
    });
    await withInbox(async (f) => {
      setUserProfileRole(f.alice.id, "administrator");
      invalidateOperatorRolePolicy(f.alice.id);
      setUserProfileRole(f.bob.id, role);
      invalidateOperatorRolePolicy(f.bob.id);
      f.aliceClient.connect.scopes = ["operator.admin"];
      f.bobClient.connect.scopes = ["operator.admin"];
      f.clients.length = 0;
      const sessionKey = suffix ? `agent:main:dashboard:${suffix}` : SESSION_KEY;
      const sessionId = sessionKey === SESSION_KEY ? SESSION_ID : "incognito-policy-session";
      await f.setSession(
        { sessionId, visibility, ...(incognito === undefined ? {} : { incognito }) },
        sessionKey,
      );
      const directory = await searchDirectory(f, "Bob", sessionKey);
      const admission = await f.inbox.validateRecipientsAsync(f.aliceClient, { sessionKey }, [
        f.bob.id,
      ]);
      await f.post("policy-source", { sessionKey, sessionId });
      expect({
        users: directory.users.map((user) => [user.profileId, user.online]),
        accepted: admission.ok,
        inboxKeys: (await f.items()).map((item) => item.sessionKey),
        pushedRecipients: f.push.mock.calls.map(([mention]) => mention.recipientProfileId),
        storedSources: openOpenClawStateDatabase()
          .db.prepare(
            "SELECT state_key FROM config_machine_state WHERE state_key GLOB 'notifications.mentions.source.*'",
          )
          .all().length,
      }).toEqual({
        users: visible ? [[f.bob.id, false]] : [],
        accepted: visible,
        inboxKeys: visible ? [sessionKey] : [],
        pushedRecipients: visible ? [f.bob.id] : [],
        storedSources: suffix ? 0 : 1,
      });
    }, cfg);
  },
);

it("allows a mention draft for a non-owner of the fixed global store", () =>
  withInbox(
    async (f) => {
      const draft = { agentId: "ops", query: "Bob" };
      expectUsers(await f.call("users.mentionable", draft, f.aliceClient), [
        { profileId: f.bob.id, displayName: "Bob" },
      ]);
      const admitted = await f.inbox.validateRecipientsAsync(f.aliceClient, draft, [f.bob.id]);
      expect(admitted).toEqual({ ok: true, value: [f.bob.id] });
      expect(await f.items()).toEqual([]);
    },
    {
      session: { scope: "global", store: "/synthetic/fixed-global.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    },
  ));

it("applies creation and current visibility policy without accepting unavailable recipients", () =>
  withInbox(async (f) => {
    const list = (params: Record<string, unknown>) =>
      f.call("users.mentionable", params, f.aliceClient);
    expect(await list({ agentId: "main" })).toMatchObject({
      ok: true,
      payload: { truncated: false },
    });
    expectUsers(await list({ agentId: "main", visibility: "draft" }), []);
    expect(await list({ agentId: "missing" })).toMatchObject({ ok: false });
    const session = { sessionKey: SESSION_KEY };
    const expectRejected = async (profileId: string) =>
      expect(
        await f.inbox.validateRecipientsAsync(f.aliceClient, session, [profileId]),
      ).toMatchObject({ ok: false });
    await expectRejected(f.alice.id);
    await expectRejected("missing-person");
    await f.setSession({ visibility: "draft" });
    const hidden = await f.call("users.mentionable", session, f.bobClient);
    expectMentionError(hidden, "INVALID_REQUEST", { message: "Session was not found." });
    await expectRejected(f.bob.id);
  }));
