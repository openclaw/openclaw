import { describe, expect, it, vi } from "vitest";
import { validateUsersMentionableResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as userProfileReads from "../state/user-profile-reads.js";
import {
  ensureProfileForEmail,
  linkEmail,
  setDisplayName,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { seedUserProfileRole } from "../state/user-profiles.test-support.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
} from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

function holdDirectoryRead() {
  const readDirectory = userProfileReads.readUserProfileDirectory;
  const ready = createDeferred();
  const release = createDeferred();
  const spy = vi
    .spyOn(userProfileReads, "readUserProfileDirectory")
    .mockImplementationOnce(async (...args) => {
      const result = await readDirectory(...args).then(
        (directory) => {
          ready.resolve();
          return directory;
        },
        (error: unknown) => {
          ready.reject(error);
          throw error;
        },
      );
      await release.promise;
      return result;
    });
  return { ready: ready.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

describe("human mention directory", () => {
  it.each([
    { change: "requester invalidation", code: "FORBIDDEN" },
    { change: "session visibility", code: "INVALID_REQUEST" },
    { change: "disposal", code: "UNAVAILABLE" },
  ] as const)("keeps $change current at final RPC publication", async ({ change, code }) => {
    await withInbox(async (f) => {
      const params = { sessionKey: SESSION_KEY, query: "Alice" };
      expect(await f.call("users.mentionable", params)).toMatchObject({
        ok: true,
        payload: { users: [{ profileId: f.alice.id }] },
      });
      let changed = false;
      const frames: { ok: boolean; changed: boolean }[] = [];
      const revocation = Promise.resolve().then(() => {
        if (change === "requester invalidation") {
          Object.assign(f.bobClient, { invalidated: true });
        } else if (change === "session visibility") {
          const scope = { agentId: "main", sessionKey: SESSION_KEY };
          const entry = loadSessionEntry(scope);
          if (!entry) {
            throw new Error("Missing mention fixture session");
          }
          replaceSessionEntrySync(scope, { ...entry, visibility: "draft" });
        } else {
          f.inbox.dispose();
        }
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
      expect(await f.call("users.mentionable", params)).toMatchObject({
        ok: false,
        error: { code },
      });
    });
  });

  it.each([false, true])(
    "propagates a response exception once (preparation fails: %s)",
    async (preparationFails) => {
      await withInbox(async (f) => {
        const params = { sessionKey: SESSION_KEY, query: "Alice" };
        const readFailure = preparationFails
          ? vi
              .spyOn(userProfileReads, "readUserProfileDirectory")
              .mockRejectedValueOnce(new Error("synthetic directory failure"))
          : undefined;
        const responseError = new Error("synthetic response failure");
        const onResponse = vi.fn<GatewayRequestHandlerOptions["respond"]>((ok, _payload, error) => {
          expect(ok).toBe(!preparationFails);
          if (preparationFails) {
            expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
          }
          throw responseError;
        });
        try {
          await expect(f.call("users.mentionable", params, f.bobClient, onResponse)).rejects.toBe(
            responseError,
          );
          expect(onResponse).toHaveBeenCalledTimes(1);
        } finally {
          readFailure?.mockRestore();
        }
      });
    },
  );

  it("discards a completed directory read when a linked handle changes before selection", async () => {
    await withInbox(async (f) => {
      const syncLogin = (login: string) =>
        syncGitHubIdentity({
          identity: { accountId: 42, login },
          authenticationAlias: { kind: "email", email: "bob@mentions.example.test" },
        });
      syncLogin("bob-before");
      const held = holdDirectoryRead();
      const pending = f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "bob-after" },
        f.aliceClient,
      );
      try {
        await held.ready;
        syncLogin("bob-after");
        setDisplayName(f.bob.id, "Robert Updated");
        held.release();
        const response = await pending;
        expect(response.error).toBeUndefined();
        expect(response).toMatchObject({
          ok: true,
          payload: { users: [{ profileId: f.bob.id, displayName: "Robert Updated" }] },
        });
        expect(
          await f.call(
            "users.mentionable",
            { sessionKey: SESSION_KEY, query: "bob-before" },
            f.aliceClient,
          ),
        ).toMatchObject({ ok: true, payload: { users: [] } });
      } finally {
        held.release();
        await pending;
        held.restore();
      }
    });
  });

  it.each([
    { change: "requester invalidation", code: "FORBIDDEN" },
    { change: "session visibility", code: "INVALID_REQUEST" },
    { change: "disposal", code: "UNAVAILABLE" },
  ] as const)("rechecks $change after directory preparation", async ({ change, code }) => {
    await withInbox(async (f) => {
      const held = holdDirectoryRead();
      const pending = f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "Alice" },
        f.bobClient,
      );
      try {
        await held.ready;
        if (change === "requester invalidation") {
          Object.assign(f.bobClient, { invalidated: true });
        } else if (change === "session visibility") {
          await f.setSession({ visibility: "draft" });
        } else {
          f.inbox.dispose();
        }
        held.release();
        expect(await pending).toMatchObject({ ok: false, error: { code } });
      } finally {
        held.release();
        await pending;
        held.restore();
      }
    });
  });

  it("resolves verified handles and full names to the same recipient without exposing account data", async () => {
    await withInbox(async (f) => {
      syncGitHubIdentity({
        identity: { accountId: 42, login: "bobby", name: "Robert Example" },
        authenticationAlias: { kind: "email", email: "bob@mentions.example.test" },
      });
      setDisplayName(f.bob.id, "Robert Example");
      syncGitHubIdentity({
        identity: { accountId: 43, login: "bob-work" },
        authenticationAlias: { kind: "email", email: "bob-work@mentions.example.test" },
      });
      linkEmail("bob-work@mentions.example.test", f.bob.id);
      for (const query of ["bobby", "BOBBY", "bob-work", "Robert Example"]) {
        const response = await f.call(
          "users.mentionable",
          { sessionKey: SESSION_KEY, query },
          f.aliceClient,
        );
        if (!response.ok || !validateUsersMentionableResult(response.payload)) {
          throw new Error("Invalid mention directory response");
        }
        expect(response.payload.users).toHaveLength(1);
        expect(response.payload.users[0]).toEqual({
          profileId: f.bob.id,
          displayName: "Robert Example",
          avatarUrl: expect.any(String),
          online: true,
        });
      }
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
      ).toEqual({ ok: true, value: [f.bob.id] });
      f.post();
      expect(read(f.inbox, f.bobClient).items).toHaveLength(1);
      syncGitHubIdentity({
        identity: { accountId: 42, login: "robert-new" },
        authenticationAlias: { kind: "email", email: "bob@mentions.example.test" },
      });
      expect(
        await f.call(
          "users.mentionable",
          { sessionKey: SESSION_KEY, query: "bobby" },
          f.aliceClient,
        ),
      ).toMatchObject({ ok: true, payload: { users: [] } });
      expect(
        await f.call(
          "users.mentionable",
          { sessionKey: SESSION_KEY, query: "robert-new" },
          f.aliceClient,
        ),
      ).toMatchObject({ ok: true, payload: { users: [{ profileId: f.bob.id }] } });
    });
  });

  it("includes offline people without leaking administrative profile fields or binding raw presence", async () => {
    await withInbox(async (f) => {
      const offline = ensureProfileForEmail("offline@mentions.example.test");
      setDisplayName(offline.id, "Bob");
      f.clients.push({ ...soloClient(), authenticatedUserId: offline.id, connId: "raw-offline" });
      const response = await f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "Bob" },
        f.aliceClient,
      );
      expect(response.ok && validateUsersMentionableResult(response.payload)).toBe(true);
      if (!validateUsersMentionableResult(response.payload)) {
        throw new Error("Invalid directory result");
      }
      const users = response.payload.users;
      expect(users.map((user) => [user.profileId, user.online])).toEqual([
        [f.bob.id, true],
        [offline.id, false],
      ]);
      expect(new Set(users.map((user) => user.displayName)).size).toBe(2);
      for (const user of users) {
        expect(Object.keys(user).toSorted()).toEqual([
          "avatarUrl",
          "displayName",
          "online",
          "profileId",
        ]);
      }
      setDisplayName(offline.id, "Dana");
      const renamed = await f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "Dana" },
        f.aliceClient,
      );
      expect(renamed).toMatchObject({
        ok: true,
        payload: { users: [{ profileId: offline.id, displayName: "Dana", online: false }] },
      });
    });
  });

  it.each([
    {
      name: "administrator receiving a draft",
      role: "administrator",
      sessionKey: SESSION_KEY,
      entry: { visibility: "draft" },
      visible: true,
      storedSources: 1,
    },
    {
      name: "owner-only recipient of a shared session",
      role: "owner-only",
      sessionKey: SESSION_KEY,
      entry: { visibility: "shared" },
      visible: false,
      storedSources: 1,
    },
    {
      name: "administrator in an entry-flag incognito session",
      role: "administrator",
      sessionKey: "agent:main:dashboard:mention-incognito-flag",
      entry: { visibility: "shared", incognito: true },
      visible: false,
      storedSources: 0,
    },
    {
      name: "administrator in a canonical-key incognito session",
      role: "administrator",
      sessionKey: "agent:main:dashboard:incognito-mention-key",
      entry: { visibility: "shared" },
      visible: false,
      storedSources: 0,
    },
  ] as const)(
    "applies offline recipient policy across directory, admission, and delivery: $name",
    async ({ role, sessionKey, entry, visible, storedSources }) => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              "owner-only": {
                agents: "*",
                scopes: ["operator.read"],
                sessions: { others: "none" },
              },
              administrator: {
                agents: "*",
                scopes: ["operator.admin"],
                sessions: { others: "none" },
              },
            },
          },
        },
      };
      await withInbox(async (f) => {
        seedUserProfileRole(f.alice.id, "administrator");
        invalidateOperatorRolePolicy(f.alice.id);
        seedUserProfileRole(f.bob.id, role);
        invalidateOperatorRolePolicy(f.bob.id);
        f.aliceClient.connect.scopes = ["operator.admin"];
        f.bobClient.connect.scopes = ["operator.admin"];
        f.clients.length = 0;
        const sessionId = sessionKey === SESSION_KEY ? SESSION_ID : "incognito-policy-session";
        await f.setSession({ sessionId, ...entry }, sessionKey);
        const directory = await f.call(
          "users.mentionable",
          { sessionKey, query: "Bob" },
          f.aliceClient,
        );
        if (!directory.ok || !validateUsersMentionableResult(directory.payload)) {
          throw new Error("Invalid mention directory response");
        }
        const admission = f.inbox.validateRecipients(f.aliceClient, { sessionKey }, [f.bob.id]);
        f.post("policy-source", { sessionKey, sessionId });
        expect({
          users: directory.payload.users.map((user) => [user.profileId, user.online]),
          accepted: admission.ok,
          inboxKeys: read(f.inbox, f.bobClient).items.map((item) => item.sessionKey),
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
          storedSources,
        });
      }, cfg);
    },
  );

  it("allows a mention draft for a non-owner of the fixed global store", async () => {
    await withInbox(
      async (f) => {
        const draft = { agentId: "ops", query: "Bob" };
        expect(await f.call("users.mentionable", draft, f.aliceClient)).toMatchObject({
          ok: true,
          payload: { users: [{ profileId: f.bob.id, displayName: "Bob" }] },
        });
        expect(f.inbox.validateRecipients(f.aliceClient, draft, [f.bob.id])).toEqual({
          ok: true,
          value: [f.bob.id],
        });
        expect(read(f.inbox, f.bobClient).items).toEqual([]);
      },
      {
        session: { scope: "global", store: "/synthetic/fixed-global.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      },
    );
  });

  it("applies creation and current visibility policy without accepting unavailable recipients", async () => {
    await withInbox(async (f) => {
      expect(await f.call("users.mentionable", { agentId: "main" }, f.aliceClient)).toMatchObject({
        ok: true,
        payload: { truncated: false },
      });
      expect(
        await f.call("users.mentionable", { agentId: "main", visibility: "draft" }, f.aliceClient),
      ).toMatchObject({ ok: true, payload: { users: [] } });
      expect((await f.call("users.mentionable", { agentId: "missing" }, f.aliceClient)).ok).toBe(
        false,
      );
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.alice.id]).ok,
      ).toBe(false);
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, ["missing-person"])
          .ok,
      ).toBe(false);
      await f.setSession({ visibility: "draft" });
      const hidden = await f.call("users.mentionable", { sessionKey: SESSION_KEY }, f.bobClient);
      expect(hidden).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Session was not found." },
      });
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]).ok,
      ).toBe(false);
    });
  });

  it("reports truncated results while a narrower search returns the matching offline person", async () => {
    await withInbox(async (f) => {
      for (let index = 0; index < 105; index++) {
        const profile = ensureProfileForEmail(`teammate-${index}@mentions.example.test`);
        setDisplayName(profile.id, `Teammate ${index}`);
      }
      const result = await f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "Teammate" },
        f.aliceClient,
      );
      if (!result.ok || !validateUsersMentionableResult(result.payload)) {
        throw new Error("Invalid mention directory response");
      }
      expect(result.payload.truncated).toBe(true);
      expect(result.payload.users).toHaveLength(100);
      expect(
        await f.call(
          "users.mentionable",
          { sessionKey: SESSION_KEY, query: "Teammate 104" },
          f.aliceClient,
        ),
      ).toMatchObject({
        ok: true,
        payload: { users: [{ displayName: "Teammate 104", online: false }], truncated: false },
      });
    });
  });
});
