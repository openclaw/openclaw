import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import * as mentionWorker from "./mention-inbox-worker.js";
import {
  SESSION_ID,
  SESSION_KEY,
  dismissMentionInbox,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
  sessionHasAutomation,
} from "./session-automation-index.js";

afterEach(() => vi.restoreAllMocks());

it.each(["activity summary", "runtime settlement", "automation", "sharing revocation"] as const)(
  "keeps mention dismissal authority aligned with %s publication",
  async (publication) => {
    const cfg = {};
    await withMentionInbox(async (fixture) => {
      await fixture.post("presentation-publication");
      const original = (await readMentionInbox(fixture.inbox, fixture.bobClient)).items[0]!;
      const jobs: CronJob[] = [];
      if (publication === "automation") {
        registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
        expect(sessionHasAutomation(SESSION_KEY, cfg, "main")).toBe(false);
      }
      const prepared = createDeferred();
      const release = createDeferred();
      const commit = mentionWorker.commitMentionChanges;
      const guardErrors: unknown[] = [];
      const held = vi
        .spyOn(mentionWorker, "commitMentionChanges")
        .mockImplementationOnce(async (context, input, assertCurrent) => {
          prepared.resolve();
          await release.promise;
          return commit(context, input, () => {
            try {
              assertCurrent();
            } catch (error) {
              guardErrors.push(error);
              throw error;
            }
          });
        });
      const changesAccess = publication === "sharing revocation";
      const dismissal = dismissMentionInbox(fixture.inbox, fixture.bobClient, [original.id]);
      const owner = Symbol("mention-presentation");
      const target = { key: SESSION_KEY, agentId: "main" };
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          dismissal,
          "Dismissal did not prepare its commit authority",
        );
        if (publication === "activity summary") {
          setSessionActivitySummaryState(target, owner, {
            sessionId: SESSION_ID,
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            state: "updating",
          });
        } else if (publication === "runtime settlement") {
          const context = requestContext(cfg);
          context.mentionInbox = fixture.inbox;
          emitSessionsChanged(
            context,
            { sessionKey: SESSION_KEY, agentId: "main", reason: "agent.input.settled" },
            { accessChanged: false, rowScope: "runtime" },
          );
        } else if (publication === "automation") {
          jobs.push({
            id: "mention-automation",
            name: "Mention automation",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            sessionTarget: `session:${SESSION_KEY}`,
            wakeMode: "now",
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "systemEvent", text: "Synthetic automation" },
            state: {},
          });
          invalidateSessionAutomationIndex();
          expect(sessionHasAutomation(SESSION_KEY, cfg, "main")).toBe(true);
        } else {
          await fixture.setSession({ visibility: "draft" });
        }
        release.resolve();
        const result = await dismissal;
        if (changesAccess) {
          expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
          expect(guardErrors).toContainEqual(new Error("Mention authority changed before commit"));
          await fixture.setSession({ visibility: "shared" });
        } else {
          expect(guardErrors).toEqual([]);
          expect(result).toMatchObject({ ok: true, value: { items: [] } });
        }
        const reopened = fixture.openInbox("after-presentation-publication");
        expect((await readMentionInbox(reopened, fixture.bobClient)).items).toEqual(
          changesAccess
            ? [expect.objectContaining({ id: original.id, messageId: original.messageId })]
            : [],
        );
      } finally {
        release.resolve();
        await dismissal;
        held.mockRestore();
        setSessionActivitySummaryState(target, owner);
        if (publication === "automation") {
          registerSessionAutomationSource(null);
        }
      }
    }, cfg);
  },
);

it("refreshes 50 connected mention views without rereading unchanged session targets", async () => {
  const cfg: OpenClawConfig = {};
  await withMentionInbox(
    async (f) => {
      const alternateStorePath = path.join(resolveStateDir(), "mention-alternate.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SESSION_KEY, storePath: alternateStorePath },
        {
          sessionId: SESSION_ID,
          updatedAt: Date.now(),
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: f.alice.id },
          displayName: "Alternate conversation",
        },
      );
      f.clients.splice(
        0,
        f.clients.length,
        ...Array.from({ length: 50 }, (_, index) => ({
          ...f.bobClient,
          connId: `viewer-${index}`,
        })),
      );
      await f.post();
      for (const client of f.clients) {
        expect((await readMentionInbox(f.inbox, client)).items).toHaveLength(1);
      }
      expect((await readMentionInbox(f.inbox, f.bobClient)).items[0]?.sessionTitle).toBe(
        "Design review",
      );
      f.broadcast.mockClear();
      let exactRowReads = 0;
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the intercepted statement receiver.
      const originalGet = StatementSync.prototype.get;
      vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
        this: StatementSync,
        ...values
      ) {
        if (/from "session_nodes"/i.test(this.sourceSQL)) {
          exactRowReads++;
        }
        return originalGet.apply(this, values);
      });
      const context: Parameters<typeof emitSessionsChanged>[0] = {
        mentionInbox: f.inbox,
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: f.broadcast,
        chatAbortControllers: new Map(),
      };
      const invalidation = vi.spyOn(f.inbox, "invalidateAsync");
      const emit = async (sessionKey = "agent:main:unrelated") => {
        emitSessionsChanged(context, { sessionKey, agentId: "main", reason: "patch" });
        await invalidation.mock.results.at(-1)?.value;
      };
      const start = performance.now();
      await emit();
      const elapsed = performance.now() - start;
      const reads = exactRowReads;
      console.log(
        JSON.stringify({ viewers: f.clients.length, exactRowReads: reads, elapsedMs: elapsed }),
      );
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(reads).toBe(0);

      // The owner publication must invalidate even if the next fan-out names another session.
      await f.setSession({ visibility: "draft" });
      exactRowReads = 0;
      await emit();
      expect(exactRowReads).toBe(1);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect((await readMentionInbox(f.inbox, f.bobClient)).items).toEqual([]);

      await f.setSession({ displayName: "Renamed conversation" });
      exactRowReads = 0;
      f.broadcast.mockClear();
      await emit(SESSION_KEY);
      expect(exactRowReads).toBe(1);
      expect(f.broadcast).toHaveBeenCalledTimes(50);
      expect((await readMentionInbox(f.inbox, f.bobClient)).items[0]?.sessionTitle).toBe(
        "Renamed conversation",
      );

      // Target reuse never retains the viewer's identity or authorization decision.
      f.clients[0]!.authenticatedUserProfile = f.carolClient.authenticatedUserProfile;
      exactRowReads = 0;
      f.broadcast.mockClear();
      await emit();
      expect(exactRowReads).toBe(0);
      expect(f.broadcast).toHaveBeenCalledTimes(1);
      expect([...f.broadcast.mock.calls[0]![2]]).toEqual(["viewer-0"]);

      // Keyless invalidation also covers in-place runtime configuration updates.
      cfg.session = { store: alternateStorePath };
      exactRowReads = 0;
      f.broadcast.mockClear();
      await f.inbox.invalidateAsync();
      expect(exactRowReads).toBe(1);
      expect(f.broadcast).toHaveBeenCalledTimes(49);
      expect((await readMentionInbox(f.inbox, f.bobClient)).items[0]?.sessionTitle).toBe(
        "Alternate conversation",
      );
    },
    cfg,
    { notifications: false },
  );
});
