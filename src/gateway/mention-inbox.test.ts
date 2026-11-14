import { afterEach, expect, it, vi } from "vitest";
import { validateMentionsListResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import * as mentionStore from "./mention-inbox-store.js";
import type { MentionStoreSource } from "./mention-inbox-store.js";
import {
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
} from "./mention-inbox-store.worker.js";
import * as mentionWorker from "./mention-inbox-worker.js";
import {
  SESSION_KEY,
  expectMentionError,
  withMentionInbox as withInbox,
  readMentionInbox as read,
  listMentionInbox as listInbox,
  dismissMentionInbox as dismiss,
  mentionRoles,
} from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { identifiedClient, soloClient } from "./server-methods/sessions-sharing.test-support.js";

afterEach(() => vi.restoreAllMocks());

const storedSnapshot = () => readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db);

function pauseOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  afterRelease?: (result: Result, args: Args) => void,
) {
  const ready = createDeferred();
  const release = createDeferred();
  return {
    ready: ready.promise,
    release: release.resolve,
    async run(this: void, ...args: Args) {
      const result = await operation(...args);
      ready.resolve();
      await release.promise;
      afterRelease?.(result, args);
      return result;
    },
  };
}

function holdMentionRead() {
  const held = pauseOperation(mentionWorker.readMentionSnapshot);
  const spy = vi.spyOn(mentionWorker, "readMentionSnapshot").mockImplementationOnce(held.run);
  return { ...held, restore: () => spy.mockRestore() };
}

it("recovers the same authenticated reader after the profile catalog becomes ready", () =>
  withInbox(
    async (f) => {
      expectMentionError(await f.call("mentions.list", {}), "UNAVAILABLE");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      expect(await f.call("mentions.list", {})).toMatchObject({
        ok: true,
        payload: { items: [] },
      });
      await f.post();
      expect(await f.items()).toHaveLength(1);
    },
    {},
    { retainProfileCatalog: false },
  ));

it("dismisses an absent mention while an unrelated session is published", () =>
  withInbox(async (f) => {
    await f.post("retained");
    const before = await f.items();
    const commit = mentionWorker.commitMentionChanges;
    vi.spyOn(mentionWorker, "commitMentionChanges").mockImplementationOnce(async (...args) => {
      await f.setSession({ displayName: "Unrelated conversation" }, "agent:main:unrelated");
      return commit(...args);
    });

    expect(await f.call("mentions.dismiss", { ids: ["synthetic-absent-mention"] })).toMatchObject({
      ok: true,
      payload: { items: before },
    });
    expect((await read(f.openInbox("after-no-op"), f.bobClient)).items).toEqual(before);
  }));

it("merges a foreign dismissal between snapshot and mutation while keeping queued input FIFO", () =>
  withInbox(async (f) => {
    await f.post("original");
    const original = (await f.items())[0]!;
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
      expect((await f.items()).map((item) => item.messageId)).toEqual([
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
  }));

it.each(["mentions.list", "mentions.dismiss"])(
  "rechecks the current requester after %s preparation",
  async (method) => {
    await withInbox(async (f) => {
      await f.post();
      const original = (await f.items())[0]!;
      const held = holdMentionRead();
      const pending = f.call(method, method === "mentions.dismiss" ? { ids: [original.id] } : {});
      try {
        await awaitGateBeforeSettlement(held.ready, pending, "RPC did not prepare its snapshot");
        Object.assign(f.bobClient, { invalidated: true });
        held.release();
        expectMentionError(await pending, "FORBIDDEN");
        expect(await f.items(f.bobSecond)).toEqual([original]);
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
      const readHead = mentionStore.getMentionStoreHeadAdmission;
      let staleHead: mentionStore.MentionStoreHead | undefined;
      const head = vi
        .spyOn(mentionStore, "getMentionStoreHeadAdmission")
        .mockImplementation((databasePath) => staleHead ?? readHead(databasePath));
      const held = pauseOperation(mentionWorker.commitMentionChanges, (_result, [, mutation]) => {
        if (lost) {
          // Native commit can outlive its worker's last head publication.
          staleHead = { ...mutation.expectedHead };
          throw new SqliteWorkerError("synthetic lost Mention Inbox reply", "outcome-unknown");
        }
      });
      const spy = vi.spyOn(mentionWorker, "commitMentionChanges").mockImplementationOnce(held.run);
      const pending = f.post("awaiting-receipt");
      try {
        await awaitGateBeforeSettlement(held.ready, pending, "Mutation did not commit");
        expect(f.push).not.toHaveBeenCalled();
        expect(f.broadcast).not.toHaveBeenCalled();
        held.release();
        await pending;
        expect(f.push).toHaveBeenCalledTimes(lost ? 0 : 1);
        const snapshots = vi.spyOn(mentionWorker, "readMentionSnapshot");
        expect((await f.items()).map((item) => item.messageId)).toEqual([
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
        held.release();
        await pending;
        spy.mockRestore();
        head.mockRestore();
      }
    });
  },
);

it("refuses a pending mention write after the recipient loses access", () =>
  withInbox(
    async (f) => {
      await f.items();
      const prepared = createDeferred();
      const release = createDeferred();
      const commit = mentionWorker.commitMentionChanges;
      vi.spyOn(mentionWorker, "commitMentionChanges").mockImplementationOnce(async (...args) => {
        prepared.resolve();
        await release.promise;
        return commit(...args);
      });
      const pending = f.post("revoked-before-commit");
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          pending,
          "Mention did not prepare its write",
        );
        setUserProfileRole(f.bob.id, "denied");
        invalidateOperatorRolePolicy(f.bob.id);
        release.resolve();
        await pending;
        expect(storedSnapshot()?.sources ?? []).toEqual([]);
        expect(f.push).not.toHaveBeenCalled();
        expectMentionError(await listInbox(f.inbox, f.bobClient), "FORBIDDEN");
      } finally {
        release.resolve();
        await pending;
      }
    },
    mentionRoles({ denied: { agents: [], scopes: [], sessions: { others: "none" } } }),
  ));

it("drains accepted committed input during disposal while refusing new input", () =>
  withInbox(async (f) => {
    const accepted = f.post("accepted-before-dispose");
    const disposal = f.inbox.dispose();
    await f.post("refused-after-dispose");
    await Promise.all([accepted, disposal]);
    const restarted = f.openInbox("after-disposal");
    expect((await f.items(f.bobClient, restarted)).map((item) => item.messageId)).toEqual([
      "message-accepted-before-dispose",
    ]);
    expect(f.push).toHaveBeenCalledOnce();
  }));

it("fences committed input when the Gateway scheduler closes", () =>
  withInbox(async (f) => {
    await f.post("before-close");
    const before = storedSnapshot();
    f.scheduler.beginClose();
    await f.post("after-close");
    expect(storedSnapshot()).toEqual(before);
    expect(f.push).toHaveBeenCalledTimes(1);
    expectMentionError(await listInbox(f.inbox, f.bobClient), "UNAVAILABLE");
  }));

it("settles an accepted dismissal after the Gateway scheduler closes", () =>
  withInbox(async (f) => {
    await f.post("dismiss-at-close");
    const item = (await f.items())[0]!;
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
      expect(storedSnapshot()?.sources).toEqual([
        expect.objectContaining({ recipients: [[f.bob.id, null]] }),
      ]);
    } finally {
      held.release();
      await Promise.allSettled([pending, disposal]);
      held.restore();
    }
  }));

it("joins expiry descendants after callback disposal without stopping sibling work", () =>
  withInbox(async (f) => {
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
  }));

it("backs off background failures without delaying foreground reads or recovery", async () => {
  const logs = createWarnLogCapture("mention-refresh");
  try {
    await withInbox(async (f) => {
      await f.post("distant-expiry");
      const snapshot = storedSnapshot()!;
      const reads = vi.spyOn(mentionWorker, "readMentionSnapshot");
      const fail = () =>
        reads.mockRejectedValueOnce(
          new SqliteWorkerError(
            "synthetic snapshot unavailable at /synthetic/state.sqlite",
            "unavailable",
          ),
        );
      fail();
      await f.inbox.invalidateAsync();
      const warning = await logs.findText("Unable to refresh the mention Inbox");
      expect(warning).toMatch(
        /phase=maintenance error=SqliteWorkerError code=unavailable elapsedMs=\d+ retryAfterMs=60000/,
      );
      expect(warning).toContain("synthetic snapshot unavailable at /synthetic/state.sqlite");
      // Publication storms must not bypass the owner's pending retry.
      const attempts = reads.mock.calls.length;
      await Promise.all(Array.from({ length: 10 }, () => f.inbox.invalidateAsync()));
      expect(reads.mock.calls).toHaveLength(attempts);
      expect(await f.items()).toHaveLength(1);
      fail();
      await f.clock.advanceBy(60_000);
      const retryAttempts = reads.mock.calls.length;
      await f.clock.advanceBy(60_000);
      await f.inbox.invalidateAsync();
      expect(reads.mock.calls).toHaveLength(retryAttempts);
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
      expect(await f.items()).toEqual([]);
      // Success resets the next failure to the initial one-minute delay.
      fail();
      await f.inbox.invalidateAsync();
      expect(f.clock.armedAtMs).toBe(f.clock.clock.now() + 60_000);
    });
  } finally {
    logs.cleanup();
  }
});

it("retains original ids, order, and expiry across Gateway restart without replaying push", () =>
  withInbox(async (f) => {
    await f.post("first");
    await f.clock.advanceBy(1_000);
    await f.post("second");
    const retained = await f.items();
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
    expect(await f.items(f.bobClient, restarted)).toEqual([retained[0]]);
    await f.clock.advanceBy(1_000);
    expect(await f.items(f.bobClient, restarted)).toEqual([]);
  }));

it("rearms an earlier persisted expiry after a wall-clock rollback", () =>
  withInbox(async (f) => {
    f.clients.length = 0;
    await f.post("before-clock-rollback");
    f.clock.setTime(f.scheduler.now() - 60_000);
    await f.post("after-clock-rollback");
    const sources = storedSnapshot()!.sources;
    expect(sources).toHaveLength(2);
    const [original, earlier] = sources;
    expect(earlier!.expiresAt).toBe(original!.expiresAt - 60_000);

    await f.clock.advanceTo(earlier!.expiresAt);
    expect(storedSnapshot()!.sources.map((source) => source.message?.content.messageId)).toEqual([
      "message-before-clock-rollback",
    ]);

    await f.clock.advanceTo(original!.expiresAt);
    expect(storedSnapshot()!.sources).toEqual([]);
  }));

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
      const retained = await f.items();
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
          expectMentionError(await dismiss(f.inbox, f.bobClient, [retained[0]!.id]), "UNAVAILABLE");
        } else {
          await expect(f.post("retryable-source")).resolves.toBeUndefined();
        }
        expect(await f.items()).toEqual(retained);
        expect(f.push).not.toHaveBeenCalled();
        expect(f.broadcast).not.toHaveBeenCalled();
      } finally {
        for (const action of ["INSERT", "UPDATE", "DELETE"]) {
          db.exec(`DROP TRIGGER reject_mention_${action}`);
        }
      }
      await f.inbox.dispose();
      const restarted = f.openInbox("restarted-gateway");
      expect(await f.items(f.bobClient, restarted)).toEqual(retained);
      if (operation === "dismissal") {
        expect((await dismiss(restarted, f.bobClient, [retained[0]!.id])).ok).toBe(true);
        expect(await f.items(f.bobClient, restarted)).toEqual([]);
      } else {
        await f.post("retryable-source", {}, restarted);
        expect(await f.items(f.bobClient, restarted)).toHaveLength(2);
        expect(f.push).toHaveBeenCalledTimes(1);
      }
    });
  },
);

it("targets only the named person, synchronizes dismissal, and does not replay consumed input", () =>
  withInbox(async (f) => {
    for (const client of f.clients) {
      await read(f.inbox, client);
    }
    await f.post();
    const sql = observeHostDataSql();
    try {
      const result = await f.call("mentions.list", {});
      expect(result.ok && validateMentionsListResult(result.payload)).toBe(true);
      const first = (await f.items())[0];
      expect(first).toMatchObject({
        senderProfileId: f.alice.id,
        senderLabel: "Alice",
        sessionTitle: "Design review",
        excerpt: "@Bob review this change",
      });
      expect(await f.items(f.aliceClient)).toEqual([]);
      expect(await f.items(f.carolClient)).toEqual([]);
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
      expect(await f.items()).toHaveLength(1);
      await f.call("mentions.dismiss", { ids: [` ${first.id} `] });
      expect(await f.items()).toHaveLength(1);
      await f.call("mentions.dismiss", { ids: [first.id] });
      expect(await f.items(f.bobSecond)).toEqual([]);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(false);
      await f.post();
      expect(await f.items()).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
      await f.post("source-two");
      expect(await f.items()).toHaveLength(1);
      expect(f.push).toHaveBeenCalledTimes(2);
      expect(
        sql.queries.filter((query) =>
          /config_machine_state|\bselect\b[\s\S]*\bsession_nodes\b/i.test(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
  }));

it("never exposes a recipient selector, a raw identity, or a fabricated successful empty Inbox", () =>
  withInbox(async (f) => {
    await f.post();
    expect(
      (await f.call("mentions.list", { profileId: f.bob.id }, f.aliceClient)).error?.code,
    ).toBe("INVALID_REQUEST");
    const raw = { ...soloClient(), connId: "raw", authenticatedUserId: f.bob.id };
    expectMentionError(await listInbox(f.inbox, raw), "FORBIDDEN");
    expectMentionError(
      await listInbox(f.inbox, { ...f.bobClient, invalidated: true }),
      "FORBIDDEN",
    );
    expectMentionError(
      await listInbox(f.inbox, { ...raw, authenticatedGitHubIdentitySync: vi.fn() }),
      "UNAVAILABLE",
      { retryable: true },
    );
    await f.inbox.dispose();
    expectMentionError(await listInbox(f.inbox, f.bobClient), "UNAVAILABLE");
    expectMentionError(
      await f.call("users.mentionable", { sessionKey: SESSION_KEY }, f.aliceClient),
      "UNAVAILABLE",
    );
    expectMentionError(
      f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
      "UNAVAILABLE",
    );
  }));

it("keeps view revisions private and retracts a now-hidden session", () =>
  withInbox(async (f) => {
    const initial = await read(f.inbox, f.bobClient);
    await f.post("carol-source", { recipientProfileIds: [f.carol.id] });
    expect((await read(f.inbox, f.bobClient)).revision).toBe(initial.revision);
    expect(f.broadcast.mock.calls.some((call) => call[2].has("bob-one"))).toBe(false);
    await f.post();
    const visible = await read(f.inbox, f.bobClient);
    const response = await read(f.inbox, f.bobClient);
    response.items[0]!.senderLabel = "Caller-owned label";
    response.items.length = 0;
    response.revision++;
    expect(await read(f.inbox, f.bobClient)).toEqual(visible);
    f.broadcast.mockClear();
    setDisplayName(f.carol.id, "Carol Updated");
    await Promise.resolve();
    expect(await read(f.inbox, f.bobClient)).toEqual(visible);
    expect(f.broadcast).not.toHaveBeenCalled();
    await f.setSession({ displayName: "Updated design review" });
    expect((await f.items())[0]?.sessionTitle).toBe("Updated design review");
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
  }));

it.each([true, false])(
  "retains acknowledgement across profile merges and projects current sender labels (dismissed first: %s)",
  async (dismissedFirst) => {
    await withInbox(async (f) => {
      const old = ensureProfileForEmail("bob-old@mentions.example.test");
      const oldClient = { ...identifiedClient(old.id, "Bob"), connId: "old-bob" };
      const recipientProfileIds = dismissedFirst ? [old.id, f.bob.id] : [f.bob.id, old.id];
      f.clients.push(oldClient);
      await f.post("two-profiles", { recipientProfileIds });
      const item = (await f.items(oldClient))[0];
      if (!item) {
        throw new Error("Old profile did not receive the mention");
      }
      await dismiss(f.inbox, oldClient, [item.id]);
      linkEmail("bob-old@mentions.example.test", f.bob.id);
      await Promise.resolve();
      expect(await f.items()).toEqual([]);
      expect(await f.items(oldClient)).toEqual([]);
      await f.post("two-profiles", { recipientProfileIds });
      expect(f.push).toHaveBeenCalledTimes(2);
      await f.post("after-merge", { recipientProfileIds });
      expect(await f.items(oldClient)).toHaveLength(1);
      setDisplayName(f.alice.id, "Alice Updated");
      await Promise.resolve();
      const retained = await f.items();
      expect(retained[0]?.senderLabel).toBe("Alice Updated");
      await f.inbox.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("restarted-gateway");

      expect(await f.items(f.bobClient, restarted)).toEqual(retained);
      expect((await read(restarted, oldClient)).items).toEqual(retained);
      await f.post("two-profiles", { recipientProfileIds }, restarted);
      await f.post("after-merge", { recipientProfileIds }, restarted);
      expect(await f.items(f.bobClient, restarted)).toEqual(retained);
      expect(f.push).not.toHaveBeenCalled();
    });
  },
);

it("keeps recipients independent when they share a committed message", () =>
  withInbox(async (f) => {
    await f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
    const bob = (await f.items())[0]!;
    const carol = (await f.items(f.carolClient))[0]!;
    expect(bob.id).not.toBe(carol.id);
    bob.excerpt = "Changed by a caller";
    expect(await f.items(f.carolClient)).toEqual([carol]);
    const held = pauseOperation(mentionWorker.commitMentionChanges);
    const spy = vi.spyOn(mentionWorker, "commitMentionChanges").mockImplementationOnce(held.run);
    const dismissal = dismiss(f.inbox, f.bobClient, [bob.id]);
    try {
      await awaitGateBeforeSettlement(
        held.ready,
        dismissal,
        "Dismissal did not reach its committed receipt",
      );
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        true,
        true,
      ]);
      held.release();
      expect((await dismissal).ok).toBe(true);
    } finally {
      held.release();
      await dismissal;
      spy.mockRestore();
    }
    expect(await f.items()).toEqual([]);
    expect(await f.items(f.carolClient)).toEqual([carol]);
    expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
      false,
      true,
    ]);
    await f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
    expect(f.push).toHaveBeenCalledTimes(2);
  }));

it.each([
  { rolesEnabled: false, admin: false, visible: true },
  { rolesEnabled: true, admin: false, visible: false },
  { rolesEnabled: true, admin: true, visible: true },
])("preserves shared-owner reads: %j", async ({ rolesEnabled, admin, visible }) => {
  const cfg = rolesEnabled ? mentionRoles() : {};
  await withInbox(async (f) => {
    const owner = ensureGatewayOwnerProfile("Owner");
    const client = identifiedClient(owner.id, "Owner");
    client.connect.scopes = [admin ? "operator.admin" : "operator.read"];
    await f.post("owner", { recipientProfileIds: [owner.id] });
    expect(await f.items(client)).toHaveLength(visible ? 1 : 0);
    expect((await f.call("users.mentionable", { sessionKey: SESSION_KEY }, client)).ok).toBe(
      visible,
    );
  }, cfg);
});

it("fences delayed push preparation on role revocation, session replacement, and disposal", async () => {
  const cfg = mentionRoles({ denied: { agents: [], scopes: [], sessions: { others: "none" } } });
  await withInbox(async (f) => {
    await f.post();
    const delayed = f.push.mock.calls[0]?.[0];
    expect(delayed?.isCurrent()).toBe(true);
    setUserProfileRole(f.bob.id, "denied");
    invalidateOperatorRolePolicy(f.bob.id);
    await Promise.resolve();
    expect(delayed?.isCurrent()).toBe(false);
    expectMentionError(await listInbox(f.inbox, f.bobClient), "FORBIDDEN");
    setUserProfileRole(f.bob.id, "reader");
    invalidateOperatorRolePolicy(f.bob.id);
    await f.replaceSessionIdentity();
    expect(await f.items()).toEqual([]);
    expect(delayed?.isCurrent()).toBe(false);
    await f.inbox.dispose();
    expect(delayed?.isCurrent()).toBe(false);
  }, cfg);
});

it("enforces the global bound and keeps evicted sources consumed", () =>
  withInbox(
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
      const stored = storedSnapshot()!;
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
      expect((await f.items(firstRecipient)).some((item) => item.messageId === "message-0")).toBe(
        true,
      );
      await post(1_000);
      const retained = await Promise.all(profiles.map((id) => read(f.inbox, identifiedClient(id))));
      expect(retained.reduce((sum, snapshot) => sum + snapshot.items.length, 0)).toBe(10_000);
      expect(
        retained
          .flatMap((snapshot) => snapshot.items)
          .some((item) => item.messageId === "message-1000"),
      ).toBe(true);
      expect((await f.items(firstRecipient)).some((item) => item.messageId === "message-0")).toBe(
        false,
      );
      await post(0);
      expect((await f.items(firstRecipient)).some((item) => item.messageId === "message-0")).toBe(
        false,
      );
    },
    {},
    { notifications: false },
  ));
