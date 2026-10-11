import { statSync } from "node:fs";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateMentionsListResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import * as mentionStore from "./mention-inbox-store.js";
import {
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
  type MentionStoreSource,
} from "./mention-inbox-store.js";
import * as mentionWorker from "./mention-inbox-worker.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
  listMentionInbox as listInbox,
  dismissMentionInbox as dismiss,
} from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { identifiedClient, soloClient } from "./server-methods/sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

function holdMentionRead() {
  const readSnapshot = mentionWorker.readMentionSnapshot;
  const ready = createDeferred();
  const release = createDeferred();
  const spy = vi
    .spyOn(mentionWorker, "readMentionSnapshot")
    .mockImplementationOnce(async (...args) => {
      const snapshot = await readSnapshot(...args);
      ready.resolve();
      await release.promise;
      return snapshot;
    });
  return { ready: ready.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

describe("temporary human mention Inbox", () => {
  it("merges a foreign dismissal between snapshot and mutation while keeping queued input FIFO", async () => {
    await withInbox(async (f) => {
      await f.post("original");
      const original = (await read(f.inbox, f.bobClient)).items[0]!;
      const peer = f.openInbox("foreign-writer");
      await peer.invalidateAsync();
      const held = holdMentionRead();
      const first = f.post("queued-first");
      const second = f.post("queued-second");
      try {
        await awaitGateBeforeSettlement(held.ready, first, "Mutation did not prepare its snapshot");
        expect((await dismiss(peer, f.bobClient, [original.id])).ok).toBe(true);
        held.release();
        await Promise.all([first, second]);
        expect((await read(f.inbox, f.bobClient)).items.map((item) => item.messageId)).toEqual([
          "message-queued-second",
          "message-queued-first",
        ]);
        await f.push.mock.calls[0]![0].prepare();
        expect(f.push.mock.calls[0]![0].isCurrent()).toBe(false);
      } finally {
        held.release();
        await Promise.allSettled([first, second]);
        held.restore();
      }
    });
  });

  it.each(["mentions.list", "mentions.dismiss"])(
    "rechecks the current requester after %s preparation",
    async (method) => {
      await withInbox(async (f) => {
        await f.post();
        const original = (await read(f.inbox, f.bobClient)).items[0]!;
        const held = holdMentionRead();
        const pending = f.call(method, method === "mentions.dismiss" ? { ids: [original.id] } : {});
        try {
          await awaitGateBeforeSettlement(held.ready, pending, "RPC did not prepare its snapshot");
          Object.assign(f.bobClient, { invalidated: true });
          held.release();
          expect(await pending).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
          expect((await read(f.inbox, f.bobSecond)).items).toEqual([original]);
        } finally {
          held.release();
          await pending;
          held.restore();
        }
      });
    },
  );

  it.each([false, true])(
    "publishes only acknowledged mutations and resyncs a lost result without replay (lost: %s)",
    async (lost) => {
      await withInbox(async (f) => {
        await f.post("original");
        f.push.mockClear();
        f.broadcast.mockClear();
        const commitChanges = mentionWorker.commitMentionChanges;
        const committed = createDeferred();
        const release = createDeferred();
        const readHead = mentionStore.getMentionStoreHeadAdmission;
        let staleHead: mentionStore.MentionStoreHead | undefined;
        const head = vi
          .spyOn(mentionStore, "getMentionStoreHeadAdmission")
          .mockImplementation((databasePath) => staleHead ?? readHead(databasePath));
        const spy = vi
          .spyOn(mentionWorker, "commitMentionChanges")
          .mockImplementationOnce(async (...args) => {
            const result = await commitChanges(...args);
            committed.resolve();
            await release.promise;
            if (lost) {
              // Native commit can outlive its worker's last head publication.
              staleHead = { ...args[1].expectedHead };
              throw new SqliteWorkerError("synthetic lost Mention Inbox reply", "outcome-unknown");
            }
            return result;
          });
        const pending = f.post("awaiting-receipt");
        try {
          await awaitGateBeforeSettlement(committed.promise, pending, "Mutation did not commit");
          expect(f.push).not.toHaveBeenCalled();
          expect(f.broadcast).not.toHaveBeenCalled();
          release.resolve();
          await pending;
          expect(f.push).toHaveBeenCalledTimes(lost ? 0 : 1);
          const snapshots = vi.spyOn(mentionWorker, "readMentionSnapshot");
          expect((await read(f.inbox, f.bobClient)).items.map((item) => item.messageId)).toEqual([
            "message-awaiting-receipt",
            "message-original",
          ]);
          if (lost) {
            expect(snapshots.mock.calls[0]?.[1]).toBe(-1);
          }
          staleHead = undefined;
          snapshots.mockRestore();
          expect(
            spy.mock.calls.filter(([, mutation]) =>
              mutation.changes.some(
                ([, source]) => source?.message?.content.messageId === "message-awaiting-receipt",
              ),
            ),
          ).toHaveLength(1);
          await f.post("awaiting-receipt");
          expect(f.push).toHaveBeenCalledTimes(lost ? 0 : 1);
        } finally {
          release.resolve();
          await pending;
          spy.mockRestore();
          head.mockRestore();
        }
      });
    },
  );

  it("drains accepted committed input during disposal while refusing new input", async () => {
    await withInbox(async (f) => {
      const accepted = f.post("accepted-before-dispose");
      const disposal = f.inbox.dispose();
      await f.post("refused-after-dispose");
      await Promise.all([accepted, disposal]);
      const restarted = f.openInbox("after-disposal");
      expect((await read(restarted, f.bobClient)).items.map((item) => item.messageId)).toEqual([
        "message-accepted-before-dispose",
      ]);
      expect(f.push).toHaveBeenCalledOnce();
    });
  });

  it("fences committed input when the Gateway scheduler closes", async () => {
    await withInbox(async (f) => {
      await f.post("before-close");
      const before = readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db);
      f.scheduler.beginClose();
      await f.post("after-close");
      expect(readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)).toEqual(before);
      expect(f.push).toHaveBeenCalledTimes(1);
      expect(await listInbox(f.inbox, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    });
  });

  it("settles an accepted dismissal after the Gateway scheduler closes", async () => {
    await withInbox(async (f) => {
      await f.post("dismiss-at-close");
      const item = (await read(f.inbox, f.bobClient)).items[0]!;
      const held = holdMentionRead();
      const pending = dismiss(f.inbox, f.bobClient, [item.id]);
      let disposal: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          held.ready,
          pending,
          "Dismissal did not prepare its snapshot",
        );
        f.scheduler.beginClose();
        disposal = f.inbox.dispose();
        held.release();
        await Promise.all([pending, disposal]);
        expect(readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)?.sources).toEqual([
          expect.objectContaining({ recipients: [[f.bob.id, null]] }),
        ]);
      } finally {
        held.release();
        await Promise.allSettled([pending, disposal]);
        held.restore();
      }
    });
  });

  it("joins expiry descendants after callback disposal without stopping sibling work", async () => {
    await withInbox(async (f) => {
      await f.post("expiry-join");
      const release = createDeferred();
      const disposing = createDeferred();
      const settled: string[] = [];
      let disposal: Promise<void> | undefined;
      f.broadcast.mockImplementationOnce(() => {
        void trackAsyncWork(async () => {
          await release.promise;
          settled.push("descendant");
        });
        disposal = Promise.resolve(f.inbox.dispose()).then(() => {
          settled.push("disposed");
        });
        disposing.resolve();
      });
      const wake = f.clock.advanceBy(7 * 24 * 60 * 60_000);
      try {
        await awaitGateBeforeSettlement(
          disposing.promise,
          Promise.resolve(wake),
          "Expiry refresh did not reach its publication callback",
        );
        const sibling = vi.fn();
        f.scheduler.schedule({ id: "mention-test:sibling", delayMs: 1, run: sibling });
        await f.clock.advanceBy(1);
        expect(sibling).toHaveBeenCalledOnce();
        expect(settled).toEqual([]);
      } finally {
        release.resolve();
        await Promise.all([wake, disposal]);
      }
      expect(settled).toEqual(["descendant", "disposed"]);
    });
  });

  it("retries failed refresh before an already armed distant expiry", async () => {
    await withInbox(async (f) => {
      await f.post("distant-expiry");
      const snapshot = readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)!;
      vi.spyOn(mentionWorker, "readMentionSnapshot").mockRejectedValueOnce(
        new SqliteWorkerError("Mention snapshot is temporarily unavailable", "unavailable"),
      );
      await f.inbox.invalidateAsync();
      runOpenClawStateWriteTransaction(({ db: writer }) =>
        writeMentionStoreChanges(
          writer,
          snapshot.head,
          new Map([[snapshot.sources[0]!.key, undefined]]),
        ),
      );
      f.broadcast.mockClear();
      await f.clock.advanceBy(60_000);
      expect(f.broadcast).toHaveBeenCalledWith(
        "mentions.changed",
        { gatewayInstanceId: "mention-gateway", revision: 2 },
        new Set([f.bobClient.connId]),
      );
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
    });
  });

  it("retains original ids, order, and expiry across Gateway restart without replaying push", async () => {
    await withInbox(async (f) => {
      await f.post("first");
      await f.clock.advanceBy(1_000);
      await f.post("second");
      const retained = (await read(f.inbox, f.bobClient)).items;
      expect(retained.map((item) => item.messageId)).toEqual(["message-second", "message-first"]);
      await f.inbox.dispose();
      f.push.mockClear();
      await f.clock.advanceBy(6 * 24 * 60 * 60_000);
      const restarted = f.openInbox("restarted-gateway");

      expect(await read(restarted, f.bobClient)).toMatchObject({
        gatewayInstanceId: "restarted-gateway",
        items: retained,
      });
      await f.post("first", {}, restarted);
      await f.post("second", {}, restarted);
      expect(f.push).not.toHaveBeenCalled();
      await f.clock.advanceBy(24 * 60 * 60_000 - 1_000);
      expect((await read(restarted, f.bobClient)).items).toEqual([retained[0]]);
      await f.clock.advanceBy(1_000);
      expect((await read(restarted, f.bobClient)).items).toEqual([]);
    });
  });

  it("rearms an earlier persisted expiry after a wall-clock rollback", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      await f.post("before-clock-rollback");
      f.clock.setTime(f.scheduler.now() - 60_000);
      await f.post("after-clock-rollback");
      const sources = readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)!.sources;
      expect(sources).toHaveLength(2);
      const [original, earlier] = sources;
      expect(earlier!.expiresAt).toBe(original!.expiresAt - 60_000);

      await f.clock.advanceTo(earlier!.expiresAt);
      expect(
        readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)!.sources.map(
          (source) => source.message?.content.messageId,
        ),
      ).toEqual(["message-before-clock-rollback"]);

      await f.clock.advanceTo(original!.expiresAt);
      expect(readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)!.sources).toEqual([]);
    });
  });

  it.each(["normal", "transient failure", "dispose after failure"] as const)(
    "restarts expiry cleanup without a connected client or an Inbox read (%s)",
    async (scenario) => {
      await withInbox(async (f) => {
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
        await f.clock.advanceBy(6 * 24 * 60 * 60_000);
        const restarted = f.openInbox("restarted-gateway");
        await restarted.invalidateAsync();
        expect(storedSources()).toHaveLength(1);
        if (scenario !== "normal") {
          db.exec(`CREATE TRIGGER reject_mention_expiry BEFORE DELETE ON config_machine_state
            WHEN OLD.state_key GLOB 'notifications.mentions.source.*'
            BEGIN SELECT RAISE(ABORT, 'synthetic mention expiry failure'); END`);
        }
        try {
          await f.clock.advanceBy(24 * 60 * 60_000);
          expect(storedSources()).toHaveLength(scenario === "normal" ? 0 : 1);
        } finally {
          if (scenario !== "normal") {
            db.exec("DROP TRIGGER reject_mention_expiry");
          }
        }
        if (scenario !== "normal") {
          if (scenario === "dispose after failure") {
            await restarted.dispose();
          }
          await f.clock.advanceBy(60_000);
          expect(storedSources()).toHaveLength(scenario === "dispose after failure" ? 1 : 0);
          if (scenario === "dispose after failure") {
            await f.openInbox("next-gateway").invalidateAsync();
            expect(storedSources()).toEqual([]);
          }
        }
        expect(f.push).toHaveBeenCalledTimes(1);
      });
    },
  );

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
            expect(await dismiss(f.inbox, f.bobClient, [retained[0]!.id])).toMatchObject({
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
          expect((await dismiss(restarted, f.bobClient, [retained[0]!.id])).ok).toBe(true);
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
      const sql = (["all", "get", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
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
        await f.call("mentions.dismiss", { ids: [` ${first.id} `] });
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
        expect(
          sql
            .flatMap((spy) =>
              spy.mock.contexts.map((statement) => {
                if (!(statement instanceof StatementSync)) {
                  throw new Error("Expected a native SQLite statement receiver");
                }
                return statement.sourceSQL;
              }),
            )
            .filter((query) => /config_machine_state/i.test(query)),
        ).toEqual([]);
      } finally {
        for (const spy of sql) {
          spy.mockRestore();
        }
      }
    });
  });

  it("never exposes a recipient selector, a raw identity, or a fabricated successful empty Inbox", async () => {
    await withInbox(async (f) => {
      await f.post();
      expect(
        (await f.call("mentions.list", { profileId: f.bob.id }, f.aliceClient)).error?.code,
      ).toBe("INVALID_REQUEST");
      const raw = { ...soloClient(), connId: "raw", authenticatedUserId: f.bob.id };
      expect(await listInbox(f.inbox, raw)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await listInbox(f.inbox, { ...f.bobClient, invalidated: true })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(
        await listInbox(f.inbox, { ...raw, authenticatedGitHubIdentitySync: vi.fn() }),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      await f.inbox.dispose();
      expect(await listInbox(f.inbox, f.bobClient)).toMatchObject({
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
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
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
      await f.inbox.invalidateAsync();
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
        await dismiss(f.inbox, oldClient, [item.id]);
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

  it("keeps recipients independent when they share a committed message", async () => {
    await withInbox(async (f) => {
      await f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
      const bob = (await read(f.inbox, f.bobClient)).items[0]!;
      const carol = (await read(f.inbox, f.carolClient)).items[0]!;
      expect(bob.id).not.toBe(carol.id);
      bob.excerpt = "Changed by a caller";
      expect((await read(f.inbox, f.carolClient)).items).toEqual([carol]);
      const commitChanges = mentionWorker.commitMentionChanges;
      const committed = createDeferred();
      const release = createDeferred();
      const spy = vi
        .spyOn(mentionWorker, "commitMentionChanges")
        .mockImplementationOnce(async (...args) => {
          const result = await commitChanges(...args);
          committed.resolve();
          await release.promise;
          return result;
        });
      const dismissal = dismiss(f.inbox, f.bobClient, [bob.id]);
      try {
        await awaitGateBeforeSettlement(
          committed.promise,
          dismissal,
          "Dismissal did not reach its committed receipt",
        );
        expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
          true,
          true,
        ]);
        release.resolve();
        expect((await dismissal).ok).toBe(true);
      } finally {
        release.resolve();
        await dismissal;
        spy.mockRestore();
      }
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect((await read(f.inbox, f.carolClient)).items).toEqual([carol]);
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        false,
        true,
      ]);
      await f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
      expect(f.push).toHaveBeenCalledTimes(2);
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
      expect(await listInbox(f.inbox, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      setUserProfileRole(f.bob.id, "reader");
      invalidateOperatorRolePolicy(f.bob.id);
      await f.setSession({ sessionId: "replacement-session" });
      const file = statSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), { bigint: true });
      emitSessionIdentityMutation({
        agentId: "main",
        databaseIdentity: `${file.dev}:${file.ino}`,
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
        const stored = readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)!;
        expect(stored.sources).toHaveLength(1);
        const template = stored.sources[0]!;
        const message = template.message!;
        // Populate retained state directly; real deliveries still own overflow and replay.
        const sources = new Map<string, MentionStoreSource>();
        for (let index = 1; index < 1_000; index++) {
          const key = index.toString(16).padStart(64, "0");
          sources.set(key, {
            ...template,
            key,
            sequence: index,
            recipients: recipientsFor(index).map((id, offset) => [id, `seed-${index}-${offset}`]),
            message: { ...message, content: { ...message.content, messageId: `message-${index}` } },
          });
        }
        runOpenClawStateWriteTransaction(({ db }) =>
          writeMentionStoreChanges(db, { ...stored.head, nextSequence: 1_000 }, sources),
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
});
