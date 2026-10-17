import { statSync } from "node:fs";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../config/sessions/session-entry-read-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as mentionWorker from "./mention-inbox-worker.js";
import {
  SESSION_ID,
  SESSION_KEY,
  expectMentionError,
  dismissMentionInbox,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";
import {
  emitSessionsChanged,
  emitSessionTitleChanged,
} from "./server-methods/session-change-event.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
  sessionHasAutomation,
} from "./session-automation-index.js";
import * as sessionSharing from "./session-sharing.js";

afterEach(() => vi.restoreAllMocks());

type Fixture = Parameters<Parameters<typeof withMentionInbox>[0]>[0];

function sessionContext(f: Fixture, cfg: OpenClawConfig = {}) {
  return {
    mentionInbox: f.inbox,
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    broadcastToConnIds: f.broadcast,
    chatAbortControllers: new Map(),
  };
}

function emitSettlement(f: Fixture, cfg: OpenClawConfig = {}) {
  emitSessionsChanged(
    sessionContext(f, cfg),
    { sessionKey: SESSION_KEY, agentId: "main", reason: "agent.input.settled" },
    { accessChanged: false, rowScope: "runtime" },
  );
}

it.each(["runtime settlement", "agent runs", "automation"] as const)(
  "serves the prepared mention Inbox without storage reads after %s",
  async (publication) => {
    await withMentionInbox(async (f) => {
      await f.post();
      const before = await f.call("mentions.list", {});
      expect(before).toMatchObject({ ok: true, payload: { items: [expect.any(Object)] } });
      const reads = vi.spyOn(sessionEntryReads, "readSessionEntriesFromStoreInWorker");
      if (publication === "runtime settlement") {
        emitSettlement(f);
      } else if (publication === "agent runs") {
        sessionChanges.emit({ all: true, scope: "agent-runs" });
      } else {
        sessionChanges.emit({ sessionKey: SESSION_KEY, agentId: "main", scope: "automation" });
      }
      expect(await f.call("mentions.list", {})).toEqual(before);
      expect(reads).not.toHaveBeenCalled();
    });
  },
);

it("recovers background views when a session is replaced during cold target preparation", async () => {
  await withMentionInbox(async (f) => {
    await f.post();
    await readMentionInbox(f.inbox, f.bobClient);
    const resolve = sessionSharing.resolveSessionSharingTargetAsync;
    vi.spyOn(sessionSharing, "resolveSessionSharingTargetAsync").mockImplementationOnce(
      async (...args) => {
        const display = await resolve(...args);
        await f.setSession({ sessionId: "replacement-session" });
        const file = statSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
        emitSessionIdentityMutation({
          agentId: "main",
          databaseIdentity: `${file.dev}:${file.ino}`,
          kind: "replace",
          previous: { sessionId: SESSION_ID, sessionKeys: [SESSION_KEY] },
          current: { sessionId: "replacement-session", sessionKeys: [SESSION_KEY] },
        });
        return display;
      },
    );
    await f.inbox.invalidateAsync();
    expect(await f.items()).toEqual([]);
    await f.setSession({ sessionId: SESSION_ID });
    expect(await f.items()).toHaveLength(1);
  });
});

it.each(["activity summary", "runtime settlement", "automation", "sharing revocation"] as const)(
  "keeps mention dismissal authority aligned with %s publication",
  async (publication) => {
    const cfg = {};
    await withMentionInbox(async (f) => {
      await f.post("presentation-publication");
      const original = (await f.items())[0]!;
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
      const dismissal = dismissMentionInbox(f.inbox, f.bobClient, [original.id]);
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
          emitSettlement(f, cfg);
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
          await f.setSession({ visibility: "draft" });
        }
        release.resolve();
        const result = await dismissal;
        if (changesAccess) {
          expectMentionError(result, "UNAVAILABLE");
          expect(guardErrors).toContainEqual(new Error("Mention authority changed before commit"));
          await f.setSession({ visibility: "shared" });
        } else {
          expect(guardErrors).toEqual([]);
          expect(result).toMatchObject({ ok: true, value: { items: [] } });
        }
        const reopened = f.openInbox("after-presentation-publication");
        expect(await f.items(f.bobClient, reopened)).toEqual(
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

it("refreshes 50 connected mention views after session and viewer changes", async () => {
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
        expect(await f.items(client)).toHaveLength(1);
      }
      expect((await f.items())[0]?.sessionTitle).toBe("Design review");
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
      const context = sessionContext(f, cfg);
      const invalidation = vi.spyOn(f.inbox, "invalidateAsync");
      const emit = async (sessionKey = "agent:main:unrelated") => {
        emitSessionsChanged(context, { sessionKey, agentId: "main", reason: "patch" });
        await invalidation.mock.results.at(-1)?.value;
      };
      const expectPublication = async (count: number, publish = emit) => {
        exactRowReads = 0;
        await publish();
        expect({ reads: exactRowReads, broadcasts: f.broadcast.mock.calls.length }).toEqual({
          reads: 0,
          broadcasts: count,
        });
      };
      await expectPublication(0);

      await f.setSession({ visibility: "draft" });
      await expectPublication(50);
      expect(await f.items()).toEqual([]);

      await f.setSession({ displayName: "Renamed conversation" });
      f.broadcast.mockClear();
      await expectPublication(50, async () => {
        emitSessionTitleChanged(context, { sessionKey: SESSION_KEY, agentId: "main" });
        await invalidation.mock.results.at(-1)?.value;
      });
      expect((await f.items())[0]?.sessionTitle).toBe("Renamed conversation");

      f.clients[0]!.authenticatedUserProfile = f.carolClient.authenticatedUserProfile;
      f.broadcast.mockClear();
      await expectPublication(1);
      expect([...f.broadcast.mock.calls[0]![2]]).toEqual(["viewer-0"]);

      cfg.session = { store: alternateStorePath };
      setRuntimeConfigSnapshot(cfg);
      f.broadcast.mockClear();
      await expectPublication(49, () => f.inbox.invalidateAsync());
      expect((await f.items())[0]?.sessionTitle).toBe("Alternate conversation");
    },
    cfg,
    { notifications: false },
  );
});
