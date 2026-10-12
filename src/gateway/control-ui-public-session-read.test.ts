import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  isPublicSessionShareActive as readActive,
  readPublicSessionShare as readShare,
} from "./control-ui-public-session-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import * as transcriptReaders from "./session-transcript-readers.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const locator = {
  agentId: "main",
  sessionKey: "agent:main:public-history",
  sessionId: "public-history-generation",
  shareId: "a".repeat(48),
};

let projection: SessionRowProjection | undefined;
function currentProjection() {
  if (!projection) {
    throw new Error("Public reader fixture is not prepared");
  }
  return projection;
}
function readPublicSessionShare(
  config: OpenClawConfig,
  target: typeof locator,
  options: { offset?: number; card?: boolean } = {},
) {
  return readShare(config, target, { ...options, projection: currentProjection() });
}
function isPublicSessionShareActive(config: OpenClawConfig, target: typeof locator) {
  return readActive(config, target, currentProjection());
}
async function withPublicTestState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    try {
      await run();
    } finally {
      projection?.dispose();
      projection = undefined;
    }
  });
}

async function seed(messages: string[], target = locator) {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    label: "Public example",
    publicShare: { id: target.shareId, sessionId: target.sessionId, createdAt: 1 },
  });
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: target.sessionId },
    ...messages.map((content, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index ? `message-${index - 1}` : null,
      message: { role: "user", content },
    })),
  ]);
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
}

describe("anonymous published session reader", () => {
  it("checks twenty warm publication readers without Gateway-thread SQLite", async () => {
    await withPublicTestState(async () => {
      await seed(["Public text"]);
      expect(await readPublicSessionShare(cfg, locator)).not.toBeNull();
      const sql = observeHostDataSql();
      try {
        for (let viewer = 0; viewer < 20; viewer++) {
          expect(isPublicSessionShareActive(cfg, locator)).toBe(true);
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  });

  it("pages exact published history using source positions rather than rendered counts", async () => {
    await withPublicTestState(async () => {
      await seed(Array.from({ length: 205 }, (_, index) => `Message ${index}`));
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest).toMatchObject({
        title: "Public example",
        totalMessages: 205,
        olderOffset: 100,
        truncated: false,
      });
      expect(latest?.messages).toHaveLength(100);
      expect(latest?.messages[0]).toMatchObject({ content: "Message 105" });
      const older = await readPublicSessionShare(cfg, locator, { offset: latest?.olderOffset });
      expect(older?.olderOffset).toBe(200);
      expect(older?.messages[0]).toMatchObject({ content: "Message 5" });
      const first = await readPublicSessionShare(cfg, locator, { offset: older?.olderOffset });
      expect(first?.messages).toHaveLength(5);
      const preview = await readPublicSessionShare(cfg, locator, { card: true });
      expect(preview?.messages[0]).toMatchObject({ content: "Message 0" });
      expect(preview?.totalMessages).toBe(205);
      expect(first?.olderOffset).toBeUndefined();
    });
  });

  it("enforces the byte bound and advances past oversized source rows without losing older messages", async () => {
    await withPublicTestState(async () => {
      await seed(["Oldest", "x".repeat(1024 * 1024 + 1), "Newest"]);
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest?.messages).toMatchObject([{ content: "Newest" }]);
      expect(latest?.olderOffset).toBe(1);
      const oversized = await readPublicSessionShare(cfg, locator, { offset: 1 });
      expect(oversized).toMatchObject({ messages: [], truncated: true, olderOffset: 2 });
      const oldest = await readPublicSessionShare(cfg, locator, { offset: 2 });
      expect(oldest?.messages).toMatchObject([{ content: "Oldest" }]);
      expect(oldest?.olderOffset).toBeUndefined();
    });
  });

  it("rejects private, unknown-agent, mismatched-instance and mismatched-grant requests", async () => {
    await withPublicTestState(async () => {
      await seed(["Published"]);
      expect(isPublicSessionShareActive(cfg, locator)).toBe(true);
      for (const target of [
        { ...locator, agentId: "other" },
        { ...locator, sessionKey: "agent:other:public-history" },
        { ...locator, sessionKey: "main" },
        { ...locator, sessionId: "old-generation" },
        { ...locator, shareId: "b".repeat(48) },
        { ...locator, sessionKey: "agent:main:incognito-private" },
      ]) {
        expect(await readPublicSessionShare(cfg, target)).toBeNull();
      }
      expect(await readPublicSessionShare({ agents: { entries: {} } }, locator)).toBeNull();
      await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
      expect(isPublicSessionShareActive(cfg, locator)).toBe(false);
      expect(await readPublicSessionShare(cfg, locator)).toBeNull();
    });
  });

  it("reconciles sharing facts invalidated during the history read", async () => {
    await withPublicTestState(async () => {
      await seed(["Still published"]);
      const read = transcriptReaders.readSessionMessagesPageWithStatsAsync;
      vi.spyOn(transcriptReaders, "readSessionMessagesPageWithStatsAsync").mockImplementationOnce(
        async (...args) => {
          const result = await read(...args);
          sessionChanges.emit({
            agentId: locator.agentId,
            sessionKey: locator.sessionKey,
            factsInvalidated: "category",
          });
          expect(
            currentProjection().sharingTargetState({
              key: locator.sessionKey,
              agentId: locator.agentId,
            }).status,
          ).toBe("pending");
          return result;
        },
      );
      expect((await readPublicSessionShare(cfg, locator))?.messages).toMatchObject([
        { content: "Still published" },
      ]);
    });
  });

  it.for(["metadata", "revoke", "reset"] as const)(
    "rechecks %s after awaited history before releasing content",
    async (action, { signal }) => {
      await withPublicTestState(async () => {
        await seed(["Must not escape after closure"]);
        const membershipRead = Promise.withResolvers<void>();
        const releaseMembership = Promise.withResolvers<void>();
        const revalidation = Promise.withResolvers<void>();
        let holdMembership = false;
        let historyReturned = false;
        if (action === "metadata") {
          const createReaders = historyReaders.createSessionHistoryWorkerReaders;
          vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation(
            (...args) => {
              const readers = createReaders(...args);
              const readMembership = readers.readMembershipFacts;
              readers.readMembershipFacts = async (...input) => {
                const result = await readMembership(...input);
                if (holdMembership) {
                  membershipRead.resolve();
                  await withinTest(releaseMembership.promise, signal);
                }
                return result;
              };
              return readers;
            },
          );
          const owner = currentProjection();
          const prepare = owner.withPreparedExactRows.bind(owner);
          vi.spyOn(owner, "withPreparedExactRows").mockImplementation((...args) => {
            if (historyReturned) {
              revalidation.resolve();
            }
            return prepare(...args);
          });
        }
        const read = transcriptReaders.readSessionMessagesPageWithStatsAsync;
        vi.spyOn(transcriptReaders, "readSessionMessagesPageWithStatsAsync").mockImplementationOnce(
          async (...args) => {
            const result = await read(...args);
            holdMembership = action === "metadata";
            await patchSessionEntryCore(
              locator,
              () => {
                if (action === "metadata") {
                  return { label: "Updated public example" };
                }
                return action === "reset"
                  ? { sessionId: "replacement" }
                  : { publicShare: undefined };
              },
              { workerGuard: {} },
            );
            if (holdMembership) {
              // Complete metadata receipts stay ready; explicit invalidation requires reconciliation.
              sessionChanges.emit({
                agentId: locator.agentId,
                sessionKey: locator.sessionKey,
                factsInvalidated: "category",
              });
              // Hold the real worker result before the projection accepts it.
              await withinTest(membershipRead.promise, signal);
              expect(
                currentProjection().sharingTargetState({
                  key: locator.sessionKey,
                  agentId: locator.agentId,
                }).status,
              ).toBe("pending");
            }
            historyReturned = true;
            return result;
          },
        );
        const reading = readPublicSessionShare(cfg, locator);
        try {
          if (action === "metadata") {
            await withinTest(
              awaitGateBeforeSettlement(
                revalidation.promise,
                reading,
                "Public session read settled before rejoining invalidated membership",
              ),
              signal,
            );
            releaseMembership.resolve();
          }
          const result = await reading;
          if (action === "metadata") {
            expect(result).toMatchObject({
              title: "Updated public example",
              messages: [{ role: "user", content: "Must not escape after closure" }],
            });
            expect(resolveSessionPublicShare(loadSessionEntry(locator))?.id).toBe(locator.shareId);
          } else {
            expect(result).toBeNull();
            expect(loadSessionEntry(locator)?.publicShare).toBeUndefined();
          }
        } finally {
          releaseMembership.resolve();
          await Promise.allSettled([reading]);
        }
      });
    },
  );

  it("reads the exact global node in its configured store without resolving aliases", async () => {
    await withPublicTestState(async () => {
      const global = { ...locator, sessionKey: "global" };
      await seed(["Global publication"], global);
      expect((await readPublicSessionShare(cfg, global))?.messages).toMatchObject([
        { content: "Global publication" },
      ]);
    });
  });
});
