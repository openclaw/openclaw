import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMentionsListResult } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as involvement from "../config/sessions/session-accessor.sqlite-involvement.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import * as profileReads from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import * as mentionStore from "./mention-inbox-store.js";
import { createMentionInbox } from "./mention-inbox.js";
import * as mentionPersistence from "./mention-inbox.persistence.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
  dismissMentionInbox,
  listMentionInbox,
  seedRetainedMentionSources,
} from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { identifiedClient, soloClient } from "./server-methods/sessions-sharing.test-support.js";

afterEach(() => vi.useRealTimers());

describe("temporary human mention Inbox", () => {
  it("retains original ids, order, and expiry across Gateway restart without replaying push", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      await f.post("first");
      await vi.advanceTimersByTimeAsync(1_000);
      await f.post("second");
      const retained = (await read(f.inbox, f.bobClient)).items;
      expect(retained.map((item) => item.messageId)).toEqual(["message-second", "message-first"]);
      await f.inbox.dispose();
      f.push.mockClear();
      await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
      const restarted = f.openInbox("restarted-gateway");

      expect(await read(restarted, f.bobClient)).toMatchObject({
        gatewayInstanceId: "restarted-gateway",
        items: retained,
      });
      await f.post("first", {}, restarted);
      await f.post("second", {}, restarted);
      expect(f.push).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 1_000);
      expect((await read(restarted, f.bobClient)).items).toEqual([retained[0]]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await read(restarted, f.bobClient)).items).toEqual([]);
    });
  });

  it.each(["normal", "transient failure", "dispose after failure"] as const)(
    "restarts expiry cleanup without a connected client or an Inbox read (%s)",
    async (scenario) => {
      await withInbox(async (f) => {
        vi.useFakeTimers();
        f.clients.length = 0;
        const { db } = openOpenClawStateDatabase();
        const storedSources = () =>
          db
            .prepare(
              "SELECT state_key FROM config_machine_state WHERE state_key GLOB 'notifications.mentions.source.*'",
            )
            .all();
        await f.post("original-deadline");
        expect(storedSources()).toHaveLength(1);
        await f.inbox.dispose();
        await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
        const initialExpiry = createDeferred();
        const retryScheduled = createDeferred<ReturnType<typeof setTimeout>>();
        let mutationFinished = createDeferred();
        let mutationFailed = false;
        const mutate = mentionPersistence.mutateMentionInbox;
        const mutations = vi
          .spyOn(mentionPersistence, "mutateMentionInbox")
          .mockImplementation(async (...args) => {
            try {
              return await mutate(...args);
            } catch (error) {
              mutationFailed = true;
              throw error;
            } finally {
              mutationFinished.resolve();
            }
          });
        const schedule = globalThis.setTimeout;
        const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(
          new Proxy(schedule, {
            apply(target, receiver, args) {
              const timer = Reflect.apply(target, receiver, args);
              if (args[1] === 24 * 60 * 60_000) {
                initialExpiry.resolve();
              } else if (mutationFailed && args[1] === 60_000) {
                retryScheduled.resolve(timer);
              }
              return timer;
            },
          }),
        );
        try {
          const restarted = f.openInbox("restarted-gateway");
          // Observe startup's scheduled deadline, not a policy callback that can
          // run while worker preparation is still in flight.
          await initialExpiry.promise;
          expect(storedSources()).toHaveLength(1);
          if (scenario !== "normal") {
            db.exec(`CREATE TRIGGER reject_mention_expiry BEFORE DELETE ON config_machine_state
              WHEN OLD.state_key GLOB 'notifications.mentions.source.*'
              BEGIN SELECT RAISE(ABORT, 'synthetic mention expiry failure'); END`);
          }
          mutationFinished = createDeferred();
          try {
            vi.advanceTimersByTime(24 * 60 * 60_000);
            await (scenario === "normal" ? mutationFinished.promise : retryScheduled.promise);
            expect(storedSources()).toHaveLength(scenario === "normal" ? 0 : 1);
          } finally {
            if (scenario !== "normal") {
              db.exec("DROP TRIGGER reject_mention_expiry");
            }
          }
          if (scenario !== "normal") {
            if (scenario === "dispose after failure") {
              const retryTimer = await retryScheduled.promise;
              const clearTimer = vi.spyOn(globalThis, "clearTimeout");
              try {
                await restarted.dispose();
                expect(clearTimer).toHaveBeenCalledWith(retryTimer);
              } finally {
                clearTimer.mockRestore();
              }
            }
            mutationFinished = createDeferred();
            mutationFailed = false;
            vi.advanceTimersByTime(60_000);
            if (scenario === "transient failure") {
              await mutationFinished.promise;
            }
            expect(storedSources()).toHaveLength(scenario === "dispose after failure" ? 1 : 0);
            if (scenario === "dispose after failure") {
              f.openInbox("next-gateway");
              await mutationFinished.promise;
              expect(storedSources()).toEqual([]);
            }
          }
        } finally {
          timers.mockRestore();
          mutations.mockRestore();
        }
        expect(f.push).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("prunes expired sources while live sources retain unavailable targets", async () => {
    const cfg: OpenClawConfig = { agents: { list: [{ id: "main" }] } };
    await withInbox(async (f) => {
      await f.post("expired-unavailable-target");
      await f.post("live-unavailable-target");
      await f.setSession({ sessionId: "unrelated-main-session" }, "agent:main:main");
      cfg.agents = { list: [{ id: "replacement" }] };
      await f.inbox.invalidate();
      expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({ ok: false });
      runOpenClawStateWriteTransaction(({ db }) => {
        const snapshot = mentionStore.readMentionStoreSnapshotInDatabase(-1, db)!;
        expect(snapshot.sources).toHaveLength(2);
        const source = snapshot.sources[0]!;
        source.expiresAt = Date.now() - 1;
        source.message!.content.createdAt = source.expiresAt - mentionStore.MENTION_RETENTION_MS;
        mentionStore.writeMentionStoreChanges(db, snapshot.head, new Map([[source.key, source]]));
      });
      await f.inbox.invalidate();
      expect(
        mentionStore.readMentionStoreSnapshotInDatabase(-1, openOpenClawStateDatabase().db)
          ?.sources,
      ).toMatchObject([{ message: { content: { messageId: "message-live-unavailable-target" } } }]);
      expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({ ok: false });
    }, cfg);
  });

  it("expires a retained cohort atomically and persists deletion across restart", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      f.clients.length = 0;
      await f.post("expiry-cohort-0");
      seedRetainedMentionSources(
        Array.from({ length: 31 }, (_, index) => ({
          sourceId: `expiry-cohort-${index + 1}`,
          recipientProfileIds: [f.bob.id],
        })),
      );
      const { db } = openOpenClawStateDatabase();
      const state = () => db.prepare("SELECT * FROM config_machine_state ORDER BY state_key").all();
      const before = state();
      const sources = before.filter((row) =>
        String(row.state_key).startsWith("notifications.mentions.source."),
      );
      expect(sources).toHaveLength(32);
      db.exec(`CREATE TRIGGER reject_cohort_expiry BEFORE DELETE ON config_machine_state
        WHEN OLD.state_key = '${String(sources[16]!.state_key)}'
        BEGIN SELECT RAISE(ABORT, 'synthetic cohort expiry failure'); END`);
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      try {
        expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
        expect(state()).toEqual(before);
      } finally {
        db.exec("DROP TRIGGER reject_cohort_expiry");
      }

      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect(
        state().filter((row) => String(row.state_key).startsWith("notifications.mentions.source.")),
      ).toEqual([]);
      await f.inbox.dispose();
      const restarted = f.openInbox("after-cohort-expiry");
      expect((await read(restarted, f.bobClient)).items).toEqual([]);
    });
  });

  it("caps per-profile retention and keeps dismissed and evicted sources consumed across restart", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      await f.post("retained-0");
      seedRetainedMentionSources(
        Array.from({ length: 99 }, (_, index) => ({
          sourceId: `retained-${index + 1}`,
          recipientProfileIds: [f.bob.id],
        })),
      );
      expect((await read(f.inbox, f.bobClient)).items).toHaveLength(100);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(true);
      await f.post("retained-100");
      const retained = (await read(f.inbox, f.bobClient)).items;
      expect(retained.map((item) => item.messageId)).toEqual(
        Array.from({ length: 100 }, (_, index) => `message-retained-${100 - index}`),
      );
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        false,
        true,
      ]);
      await f.post("retained-0");
      expect((await read(f.inbox, f.bobClient)).items).toEqual(retained);
      expect((await dismissMentionInbox(f.inbox, f.bobClient, [retained[0]!.id])).ok).toBe(true);
      const expected = retained.slice(1);
      await f.inbox.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("restarted-gateway");

      expect((await read(restarted, f.bobClient)).items).toEqual(expected);
      for (const source of ["retained-0", "retained-100", "retained-50"]) {
        await f.post(source, {}, restarted);
      }
      expect((await read(restarted, f.bobClient)).items).toEqual(expected);
      expect(f.push).not.toHaveBeenCalled();
      expect(
        (
          await dismissMentionInbox(
            restarted,
            f.bobClient,
            expected.map((item) => item.id),
          )
        ).ok,
      ).toBe(true);
      await f.post("retained-99", {}, restarted);
      expect((await read(restarted, f.bobClient)).items).toEqual([]);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it("persists entries and dismissal without changing sqlite_schema or user_version", async () => {
    const schema = () => {
      const { db } = openOpenClawStateDatabase();
      return {
        schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY type, name").all(),
        userVersion: db.prepare("PRAGMA user_version").get(),
      };
    };
    let before: ReturnType<typeof schema> | undefined;
    await withInbox(
      async (f) => {
        await f.post("dismissed");
        await f.post("retained");
        const original = (await read(f.inbox, f.bobClient)).items;
        expect((await dismissMentionInbox(f.inbox, f.bobClient, [original[1]!.id])).ok).toBe(true);
        await f.inbox.dispose();
        const restarted = f.openInbox("restarted-gateway");
        expect((await read(restarted, f.bobClient)).items).toEqual([original[0]]);
        expect(schema()).toEqual(before);
      },
      {},
      { beforeInbox: () => (before = schema()) },
    );
  });

  it.each(["dismissal", "new input"] as const)(
    "retains committed state and withholds push when storage rejects %s",
    async (operation) => {
      await withInbox(async (f) => {
        await f.post("original");
        const retained = (await read(f.inbox, f.bobClient)).items;
        const { db } = openOpenClawStateDatabase();
        for (const action of ["INSERT", "UPDATE", "DELETE"]) {
          db.exec(`CREATE TRIGGER reject_mention_${action} BEFORE ${action} ON config_machine_state
            WHEN ${action === "DELETE" ? "OLD" : "NEW"}.state_key LIKE 'notifications.mentions.%'
            BEGIN SELECT RAISE(ABORT, 'synthetic mention write failure'); END`);
        }
        f.push.mockClear();
        f.broadcast.mockClear();
        try {
          if (operation === "dismissal") {
            expect(
              await dismissMentionInbox(f.inbox, f.bobClient, [retained[0]!.id]),
            ).toMatchObject({
              ok: false,
              error: { code: "UNAVAILABLE" },
            });
          } else {
            await expect(f.post("retryable-source")).resolves.toBeUndefined();
          }
          expect((await read(f.inbox, f.bobClient)).items).toEqual(retained);
          expect(f.push).not.toHaveBeenCalled();
          expect(f.broadcast).not.toHaveBeenCalled();
        } finally {
          for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            db.exec(`DROP TRIGGER reject_mention_${action}`);
          }
        }
        await f.inbox.dispose();
        const restarted = f.openInbox("restarted-gateway");
        expect((await read(restarted, f.bobClient)).items).toEqual(retained);
        if (operation === "dismissal") {
          expect((await dismissMentionInbox(restarted, f.bobClient, [retained[0]!.id])).ok).toBe(
            true,
          );
          expect((await read(restarted, f.bobClient)).items).toEqual([]);
        } else {
          await f.post("retryable-source", {}, restarted);
          expect((await read(restarted, f.bobClient)).items).toHaveLength(2);
          expect(f.push).toHaveBeenCalledTimes(1);
        }
      });
    },
  );

  it("targets only the named person, synchronizes dismissal, and does not replay consumed input", async () => {
    await withInbox(async (f) => {
      for (const client of f.clients) {
        await read(f.inbox, client);
      }
      await f.post();
      const result = await f.call("mentions.list", {});
      expect(result.ok && validateMentionsListResult(result.payload)).toBe(true);
      const first = (await read(f.inbox, f.bobClient)).items[0];
      expect(first).toMatchObject({
        senderProfileId: f.alice.id,
        senderLabel: "Alice",
        sessionTitle: "Design review",
        excerpt: "@Bob review this change",
      });
      expect((await read(f.inbox, f.aliceClient)).items).toEqual([]);
      expect((await read(f.inbox, f.carolClient)).items).toEqual([]);
      expect(f.broadcast.mock.calls.map((call) => [...call[2]])).toEqual([
        ["bob-one"],
        ["bob-two"],
      ]);
      expect(f.push.mock.calls[0]?.[0]).toMatchObject({ recipientProfileId: f.bob.id });
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(true);
      if (!first) {
        throw new Error("Recipient did not receive the mention");
      }

      await f.call("mentions.dismiss", { ids: [first.id, "unknown-mention"] }, f.aliceClient);
      expect((await read(f.inbox, f.bobClient)).items).toHaveLength(1);
      await f.call("mentions.dismiss", { ids: [first.id] });
      expect((await read(f.inbox, f.bobSecond)).items).toEqual([]);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(false);
      await f.post();
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
      await f.post("source-two");
      expect((await read(f.inbox, f.bobClient)).items).toHaveLength(1);
      expect(f.push).toHaveBeenCalledTimes(2);
    });
  });

  it("never exposes a recipient selector, a raw identity, or a fabricated successful empty Inbox", async () => {
    await withInbox(async (f) => {
      await f.post();
      expect(
        (await f.call("mentions.list", { profileId: f.bob.id }, f.aliceClient)).error?.code,
      ).toBe("INVALID_REQUEST");
      const raw = { ...soloClient(), connId: "raw", authenticatedUserId: f.bob.id };
      expect(await listMentionInbox(f.inbox, raw)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await listMentionInbox(f.inbox, { ...f.bobClient, invalidated: true })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(
        await listMentionInbox(f.inbox, { ...raw, authenticatedGitHubIdentitySync: vi.fn() }),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      await f.inbox.dispose();
      expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      expect(
        await f.call("users.mentionable", { sessionKey: SESSION_KEY }, f.aliceClient),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      expect(
        await f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    });
  });

  it("keeps view revisions private and retracts a now-hidden session", async () => {
    await withInbox(async (f) => {
      const initial = await read(f.inbox, f.bobClient);
      await f.post("carol-source", { recipientProfileIds: [f.carol.id] });
      expect((await read(f.inbox, f.bobClient)).revision).toBe(initial.revision);
      expect(f.broadcast.mock.calls.some((call) => call[2].has("bob-one"))).toBe(false);
      await f.post();
      const visible = await read(f.inbox, f.bobClient);
      await f.setSession({ visibility: "draft" });
      await f.inbox.invalidate();
      const hidden = await read(f.inbox, f.bobClient);
      expect(hidden.items).toEqual([]);
      expect(hidden.revision).toBeGreaterThan(visible.revision);
      f.broadcast.mockClear();
      await f.post("hidden-source");
      expect((await read(f.inbox, f.bobClient)).revision).toBe(hidden.revision);
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.push.mock.calls[1]?.[0].isCurrent()).toBe(false);
    });
  });

  it.each([true, false])(
    "retains acknowledgement across profile merges and projects current sender labels (dismissed first: %s)",
    async (dismissedFirst) => {
      await withInbox(async (f) => {
        const old = ensureProfileForEmail("bob-old@mentions.example.test");
        const oldClient = { ...identifiedClient(old.id, "Bob"), connId: "old-bob" };
        const recipientProfileIds = dismissedFirst ? [old.id, f.bob.id] : [f.bob.id, old.id];
        f.clients.push(oldClient);
        await f.post("two-profiles", { recipientProfileIds });
        const item = (await read(f.inbox, oldClient)).items[0];
        if (!item) {
          throw new Error("Old profile did not receive the mention");
        }
        await dismissMentionInbox(f.inbox, oldClient, [item.id]);
        linkEmail("bob-old@mentions.example.test", f.bob.id);
        await Promise.resolve();
        expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
        expect((await read(f.inbox, oldClient)).items).toEqual([]);
        await f.post("two-profiles", { recipientProfileIds });
        expect(f.push).toHaveBeenCalledTimes(2);
        await f.post("after-merge", { recipientProfileIds });
        expect((await read(f.inbox, oldClient)).items).toHaveLength(1);
        setDisplayName(f.alice.id, "Alice Updated");
        await Promise.resolve();
        const retained = (await read(f.inbox, f.bobClient)).items;
        expect(retained[0]?.senderLabel).toBe("Alice Updated");
        await f.inbox.dispose();
        f.push.mockClear();
        const restarted = f.openInbox("restarted-gateway");

        expect((await read(restarted, f.bobClient)).items).toEqual(retained);
        expect((await read(restarted, oldClient)).items).toEqual(retained);
        await f.post("two-profiles", { recipientProfileIds }, restarted);
        await f.post("after-merge", { recipientProfileIds }, restarted);
        expect((await read(restarted, f.bobClient)).items).toEqual(retained);
        expect(f.push).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps recipient excerpts independent and drops dismissed preview metadata", async () => {
    await withInbox(async (f) => {
      const excerpt = "@Bob check the API. @Carol check the spacing.";
      await f.post("shared-source", {
        recipientProfileIds: [f.bob.id, f.carol.id],
        excerpt,
        mentions: [
          { profileId: f.bob.id, start: 0, end: 4 },
          {
            profileId: f.carol.id,
            start: excerpt.indexOf("@Carol"),
            end: excerpt.indexOf("@Carol") + 6,
          },
        ],
      });
      const bob = (await read(f.inbox, f.bobClient)).items[0]!;
      const carol = (await read(f.inbox, f.carolClient)).items[0]!;
      expect(bob.id).not.toBe(carol.id);
      bob.excerpt = "Changed by a caller";
      bob.excerptMention!.start = 999;
      expect((await read(f.inbox, f.bobClient)).items[0]!.excerptMention!.start).toBe(0);
      expect((await read(f.inbox, f.carolClient)).items).toEqual([carol]);
      await dismissMentionInbox(f.inbox, f.bobClient, [bob.id]);
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect((await read(f.inbox, f.carolClient)).items).toEqual([carol]);
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        false,
        true,
      ]);
      const stored = mentionStore.readMentionStoreSnapshotInDatabase(
        -1,
        openOpenClawStateDatabase().db,
      )!.sources[0]!.message!.recipientExcerpts!;
      expect(stored.map(({ profileId }) => profileId)).toEqual([f.carol.id]);
      await f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
      expect(f.push).toHaveBeenCalledTimes(2);
    });
  });

  it("retains selected excerpt positions when recipient profiles merge and restart", async () => {
    await withInbox(async (f) => {
      const old = ensureProfileForEmail("old-excerpt@mentions.example.test");
      const oldClient = { ...identifiedClient(old.id, "Old Bob"), connId: "old-excerpt" };
      f.clients.push(oldClient);
      const excerpt = "Before release, @Old Bob check the API.";
      const start = excerpt.indexOf("@Old Bob");
      await f.post("selected-old-profile", {
        recipientProfileIds: [old.id],
        excerpt,
        mentions: [{ profileId: old.id, start, end: start + 8 }],
      });
      const original = (await read(f.inbox, oldClient)).items;
      expect(original[0]!.excerptMention).toEqual({ start, end: start + 8 });
      linkEmail("old-excerpt@mentions.example.test", f.bob.id);
      await Promise.resolve();
      expect((await read(f.inbox, f.bobClient)).items).toEqual(original);
      await f.inbox.dispose();
      const restarted = f.openInbox("excerpt-merge-restart");
      expect((await read(restarted, f.bobClient)).items).toEqual(original);
      expect(
        mentionStore.readMentionStoreSnapshotInDatabase(-1, openOpenClawStateDatabase().db)!
          .sources[0]!.message!.recipientExcerpts![0]!.profileId,
      ).toBe(f.bob.id);
    });
  });

  it("rebuilds the merged profile's bound in arrival order without resurrecting evictions", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      const old = ensureProfileForEmail("bob-merged@mentions.example.test");
      const post = (index: number, target = f.inbox) =>
        f.post(`merged-${index}`, { recipientProfileIds: [index % 2 ? f.bob.id : old.id] }, target);
      const seed = (start: number, count: number) =>
        seedRetainedMentionSources(
          Array.from({ length: count }, (_, offset) => {
            const index = start + offset;
            return {
              sourceId: `merged-${index}`,
              recipientProfileIds: [index % 2 ? f.bob.id : old.id],
            };
          }),
        );
      await post(0);
      seed(1, 48);
      // Real notifications straddle the merged eviction boundary, for both aliases.
      await post(49);
      await post(50);
      await post(51);
      seed(52, 97);
      await post(149);
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);
      linkEmail("bob-merged@mentions.example.test", f.bob.id);
      await Promise.resolve();
      const retained = (await read(f.inbox, f.bobClient)).items;
      expect(retained.map((item) => item.messageId)).toEqual(
        Array.from({ length: 100 }, (_, index) => `message-merged-${149 - index}`),
      );
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        false,
        false,
        true,
        true,
        true,
      ]);
      await post(0);
      await post(48);
      expect((await read(f.inbox, f.bobClient)).items).toEqual(retained);
      await dismissMentionInbox(
        f.inbox,
        f.bobClient,
        retained.map((item) => item.id),
      );
      await post(149);
      await post(148);
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect(f.push.mock.calls.every(([notification]) => !notification.isCurrent())).toBe(true);
      await f.inbox.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("merged-retention-restart");
      await post(48, restarted);
      await post(148, restarted);
      expect((await read(restarted, f.bobClient)).items).toEqual([]);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it.each([
    { rolesEnabled: false, admin: false, visible: true },
    { rolesEnabled: true, admin: false, visible: false },
    { rolesEnabled: true, admin: true, visible: true },
  ])("preserves shared-owner reads: %j", async ({ rolesEnabled, admin, visible }) => {
    const cfg: OpenClawConfig = rolesEnabled
      ? {
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              },
            },
          },
        }
      : {};
    await withInbox(async (f) => {
      const owner = ensureGatewayOwnerProfile("Owner");
      const client = identifiedClient(owner.id, "Owner");
      client.connect.scopes = [admin ? "operator.admin" : "operator.read"];
      await f.post("owner", { recipientProfileIds: [owner.id] });
      expect((await read(f.inbox, client)).items).toHaveLength(visible ? 1 : 0);
      expect((await f.call("users.mentionable", { sessionKey: SESSION_KEY }, client)).ok).toBe(
        visible,
      );
    }, cfg);
  });

  it("fences delayed push preparation on role revocation, session replacement, and disposal", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            denied: { agents: [], scopes: [], sessions: { others: "none" } },
          },
        },
      },
    };
    await withInbox(async (f) => {
      await f.post();
      const delayed = f.push.mock.calls[0]?.[0];
      expect(delayed?.isCurrent()).toBe(true);
      setUserProfileRole(f.bob.id, "denied");
      invalidateOperatorRolePolicy(f.bob.id);
      await Promise.resolve();
      expect(delayed?.isCurrent()).toBe(false);
      expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      setUserProfileRole(f.bob.id, "reader");
      invalidateOperatorRolePolicy(f.bob.id);
      await f.setSession({ sessionId: "replacement-session" });
      emitSessionIdentityMutation({
        agentId: "main",
        kind: "replace",
        previous: { sessionId: SESSION_ID, sessionKeys: [SESSION_KEY] },
        current: { sessionId: "replacement-session", sessionKeys: [SESSION_KEY] },
      });
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect(delayed?.isCurrent()).toBe(false);
      await f.inbox.dispose();
      expect(delayed?.isCurrent()).toBe(false);
    }, cfg);
  });

  it("expires on the Gateway clock and does not backfill after a new Gateway lifetime", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      await f.post("first");
      expect((await read(f.inbox, f.bobClient)).items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await f.post("second");
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000 - 1_000);
      expect((await read(f.inbox, f.bobClient)).items.map((item) => item.messageId)).toEqual([
        "message-second",
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      await f.post("new-deadline");
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      await f.inbox.dispose();
      const replacement = createMentionInbox({
        gatewayInstanceId: "replacement-gateway",
        getRuntimeConfig: () => ({}),
        getClients: () => f.clients,
        broadcastToConnIds: f.broadcast,
      });
      try {
        expect(await read(replacement, f.bobClient)).toMatchObject({
          gatewayInstanceId: "replacement-gateway",
          items: [],
        });
      } finally {
        await replacement.dispose();
      }
    });
  });

  it("enforces the global bound and keeps evicted sources consumed", async () => {
    await withInbox(
      async (f) => {
        f.clients.length = 0;
        const profiles = Array.from(
          { length: 101 },
          (_, index) => ensureProfileForEmail(`capacity-${index}@mentions.example.test`).id,
        );
        const recipientsFor = (index: number) =>
          Array.from(
            { length: 10 },
            (_, offset) => profiles[(index * 10 + offset) % profiles.length]!,
          );
        const post = (index: number) =>
          f.post(`source-${index}`, {
            messageId: `message-${index}`,
            excerpt: undefined,
            recipientProfileIds: recipientsFor(index),
          });
        await post(0);
        seedRetainedMentionSources(
          Array.from({ length: 999 }, (_, index) => ({
            sourceId: `source-${index + 1}`,
            messageId: `message-${index + 1}`,
            recipientProfileIds: recipientsFor(index + 1),
          })),
        );
        const firstRecipient = identifiedClient(profiles[0]!);
        expect(
          (await read(f.inbox, firstRecipient)).items.some(
            (item) => item.messageId === "message-0",
          ),
        ).toBe(true);
        await post(1_000);
        const retained = await Promise.all(
          profiles.map((id) => read(f.inbox, identifiedClient(id))),
        );
        expect(retained.reduce((sum, snapshot) => sum + snapshot.items.length, 0)).toBe(10_000);
        expect(
          retained
            .flatMap((snapshot) => snapshot.items)
            .some((item) => item.messageId === "message-1000"),
        ).toBe(true);
        expect(
          (await read(f.inbox, firstRecipient)).items.some(
            (item) => item.messageId === "message-0",
          ),
        ).toBe(false);
        await post(0);
        expect(
          (await read(f.inbox, firstRecipient)).items.some(
            (item) => item.messageId === "message-0",
          ),
        ).toBe(false);
      },
      {},
      { notifications: false },
    );
  });

  it.each(["profile", "session", "shutdown"] as const)(
    "refuses stale recipient preparation and joins accepted work (change: %s)",
    async (change) => {
      const shutdown = change === "shutdown";
      await withInbox(async (f) => {
        const ready = createDeferred();
        const release = createDeferred();
        const update = involvement.updateSessionProfileInvolvement;
        const held = vi
          .spyOn(involvement, "updateSessionProfileInvolvement")
          .mockImplementationOnce(async (...args) => {
            const result = await update(...args);
            ready.resolve();
            await release.promise;
            return result;
          });
        const post = f.post("held-recipient");
        try {
          await ready.promise;
          if (change === "session") {
            await f.setSession({ visibility: "draft" });
          } else {
            setDisplayName(f.bob.id, "Changed while preparing");
          }
          let closed = false;
          const closing = shutdown
            ? f.inbox.dispose().then(() => {
                closed = true;
              })
            : Promise.resolve();
          await Promise.resolve();
          expect(closed).toBe(false);
          release.resolve();
          await Promise.all([post, closing]);
          expect(closed).toBe(shutdown);
          expect(f.push).not.toHaveBeenCalled();
          if (shutdown) {
            using reads = vi.spyOn(mentionStore, "readMentionStoreSnapshot");
            expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({
              ok: false,
              error: { code: "UNAVAILABLE" },
            });
            expect(await dismissMentionInbox(f.inbox, f.bobClient, [])).toMatchObject({
              ok: false,
              error: { code: "UNAVAILABLE" },
            });
            expect(reads).not.toHaveBeenCalled();
          }
          if (change === "session") {
            await f.setSession({ visibility: "shared" });
          }
          const reopened = f.openInbox("after-drain");
          expect((await read(reopened, f.bobClient)).items).toEqual([]);
        } finally {
          release.resolve();
          await post;
          held.mockRestore();
        }
      });
    },
  );

  it.each(["view", "push", "policy"] as const)(
    "keeps committed items and isolates post-commit %s callback failures",
    async (failure) => {
      await withInbox(async (f) => {
        const newcomer =
          failure === "policy"
            ? ensureProfileForEmail("late-reader@mentions.example.test")
            : undefined;
        await read(f.inbox, f.aliceClient);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const published = createDeferred();
        const notified: string[] = [];
        f.broadcast.mockImplementation((_event, _payload, ids: Set<string>) => {
          notified.push(...ids);
          if (ids.has("carol")) {
            published.resolve();
          }
        });
        let publicationFailed = false;
        let retryScheduled = false;
        const schedule = globalThis.setTimeout;
        using _ = vi.spyOn(globalThis, "setTimeout").mockImplementation(
          new Proxy(schedule, {
            apply(target, receiver, args) {
              retryScheduled ||= publicationFailed && args[1] > 0 && args[1] <= 60_000;
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
        if (failure === "view") {
          f.broadcast.mockImplementationOnce(() => {
            publicationFailed = true;
            throw new Error("view publication failed");
          });
        } else if (failure === "push") {
          f.push.mockImplementationOnce(() => {
            throw new Error("push callback failed");
          });
        }
        const mutate = mentionPersistence.mutateMentionInbox;
        const readPolicy = profileReads.executeExistingOpenClawStateRead;
        let failPreparation = false;
        const mutation = vi
          .spyOn(mentionPersistence, "mutateMentionInbox")
          .mockImplementation(async (...args) => {
            const result = await mutate(...args);
            if (newcomer && args[1].action.kind === "record") {
              f.clients.push(identifiedClient(newcomer.id, "Late reader"));
              failPreparation = true;
            }
            return result;
          });
        const preparation = vi
          .spyOn(profileReads, "executeExistingOpenClawStateRead")
          .mockImplementation((...args) => {
            if (failPreparation && args[1].type === "mentions.policy") {
              failPreparation = false;
              publicationFailed = true;
              return Promise.reject(new Error("postcommit policy preparation failed"));
            }
            return readPolicy(...args);
          });
        try {
          await expect(
            f.post("callback-failure", { recipientProfileIds: [f.bob.id, f.carol.id] }),
          ).resolves.toBeUndefined();
          expect(f.push).toHaveBeenCalledTimes(2);
          if (failure !== "push") {
            expect(retryScheduled).toBe(true);
            vi.advanceTimersByTime(60_000);
            await published.promise;
          }
          expect(notified).toEqual(["bob-one", "bob-two", "carol"]);
          expect((await read(f.inbox, f.bobClient)).items).toHaveLength(1);
          expect((await read(f.inbox, f.carolClient)).items).toHaveLength(1);
          expect(f.push).toHaveBeenCalledTimes(2);
        } finally {
          mutation.mockRestore();
          preparation.mockRestore();
        }
      });
    },
  );
});
