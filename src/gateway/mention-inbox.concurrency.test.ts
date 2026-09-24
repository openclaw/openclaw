import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as profileReads from "../state/openclaw-state-db-readonly.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import * as mentionStore from "./mention-inbox-store.js";
import {
  withMentionInbox as withInbox,
  readMentionInbox as read,
  dismissMentionInbox,
  listMentionInbox,
} from "./mention-inbox.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";

afterEach(() => vi.useRealTimers());

describe("concurrent mention Inbox owners", () => {
  it("retries committed dismissal publication without another Inbox request", async () => {
    await withInbox(async (f) => {
      await f.post("dismissal-recovery");
      const item = (await read(f.inbox, f.bobClient)).items[0]!;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const published = createDeferred();
      const notified: string[] = [];
      let publicationFailed = false;
      let retryScheduled = false;
      f.broadcast.mockImplementation((_event, _payload, ids: Set<string>) => {
        notified.push(...ids);
        if (ids.has("bob-two")) {
          published.resolve();
        }
      });
      f.broadcast.mockImplementationOnce(() => {
        publicationFailed = true;
        throw new Error("dismissal publication failed");
      });
      const schedule = globalThis.setTimeout;
      using _ = vi.spyOn(globalThis, "setTimeout").mockImplementation(
        new Proxy(schedule, {
          apply(target, receiver, args) {
            retryScheduled ||= publicationFailed && args[1] > 0 && args[1] <= 60_000;
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      expect(await dismissMentionInbox(f.inbox, f.bobClient, [item.id])).toMatchObject({
        ok: false,
      });
      expect(retryScheduled).toBe(true);
      vi.advanceTimersByTime(60_000);
      await published.promise;
      expect(notified).toEqual(["bob-one", "bob-two"]);
      expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
    });
  });

  it("merges alternating owners' writes without resurrecting dismissals or losing new input", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      const transient = ensureProfileForEmail("transient-reader@mentions.example.test");
      const unconnected = identifiedClient(transient.id, "Transient reader");
      await f.post("first");
      const first = (await read(f.inbox, f.bobClient)).items[0]!;
      const peer = f.openInbox("peer-gateway");
      expect((await read(peer, f.bobClient)).items).toEqual([first]);
      expect((await dismissMentionInbox(f.inbox, f.bobClient, [first.id])).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await f.post("second", {}, peer);
      const second = (await read(peer, f.bobClient)).items[0]!;
      expect((await read(f.inbox, f.bobClient)).items).toEqual([second]);
      await vi.advanceTimersByTimeAsync(1);
      await f.post("third");
      const both = (await read(f.inbox, f.bobClient)).items;
      expect(both.map((item) => item.messageId)).toEqual(["message-third", "message-second"]);
      expect((await read(peer, f.bobClient)).items).toEqual(both);
      expect((await dismissMentionInbox(peer, f.bobClient, [second.id])).ok).toBe(true);
      f.broadcast.mockClear();
      {
        const readPolicy = profileReads.executeExistingOpenClawStateRead;
        using _ = vi
          .spyOn(profileReads, "executeExistingOpenClawStateRead")
          .mockImplementation((...args) => {
            if (
              args[1].type === "mentions.policy" &&
              args[1].input.profileIds.includes(transient.id)
            ) {
              return Promise.reject(new Error("late requester policy read failed"));
            }
            return readPolicy(...args);
          });
        expect(await listMentionInbox(f.inbox, unconnected)).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
      }
      f.broadcast.mockImplementationOnce(() => {
        throw new Error("view publication rejected");
      });
      expect(await listMentionInbox(f.inbox, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      f.broadcast.mockClear();
      expect((await read(f.inbox, f.bobClient)).items).toEqual([both[0]]);
      expect(
        f.broadcast.mock.calls.map(([, payload, ids]) => ({ payload, ids: [...ids] })),
      ).toEqual([
        {
          payload: expect.objectContaining({ gatewayInstanceId: "mention-gateway" }),
          ids: ["bob-one"],
        },
        {
          payload: expect.objectContaining({ gatewayInstanceId: "mention-gateway" }),
          ids: ["bob-two"],
        },
      ]);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(false);
      expect(f.push.mock.calls[1]?.[0].isCurrent()).toBe(false);
      await f.inbox.dispose();
      await peer.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("restarted-gateway");

      await f.post("first", {}, restarted);
      await f.post("second", {}, restarted);
      expect((await read(restarted, f.bobClient)).items).toEqual([both[0]]);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it("reconciles merged recipients discovered by a mutation after its host snapshot", async () => {
    await withInbox(async (f) => {
      const email = "concurrent-alias@mentions.example.test";
      const previous = ensureProfileForEmail(email);
      await f.post("known-source");
      const peer = f.openInbox("concurrent-merge-peer");
      await read(peer, f.aliceClient);
      const snapshot = mentionStore.readMentionStoreSnapshot;
      let interleave = true;
      using _ = vi
        .spyOn(mentionStore, "readMentionStoreSnapshot")
        .mockImplementation(async (...args) => {
          const result = await snapshot(...args);
          if (interleave) {
            interleave = false;
            await f.post("foreign-source", { recipientProfileIds: [previous.id] }, peer);
            await peer.dispose();
            linkEmail(email, f.bob.id);
          }
          return result;
        });
      expect((await read(f.inbox, f.bobClient)).items.map((item) => item.messageId)).toEqual([
        "message-foreign-source",
        "message-known-source",
      ]);
    });
  });
});
