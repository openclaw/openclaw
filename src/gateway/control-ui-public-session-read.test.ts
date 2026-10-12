import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
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
  collectPublicSessionAttachments,
  readPublicSessionAttachment,
} from "./control-ui-public-session-attachments.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";
import {
  isPublicSessionShareActive as readActive,
  readPublicSessionMessage,
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
  options: { offset?: number } = {},
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

async function seed(messages: unknown[], target = locator) {
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
      message: typeof content === "string" ? { role: "user", content } : content,
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

  it("pages fifty visible items and retains source positions for the older link", async () => {
    await withPublicTestState(async () => {
      await seed(Array.from({ length: 205 }, (_, index) => `Message ${index}`));
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest).toMatchObject({
        title: "Public example",
        totalMessages: 205,
        olderOffset: 50,
        truncated: false,
      });
      expect(latest?.messages).toHaveLength(50);
      expect(latest?.messages[0]).toMatchObject({ content: "Message 155" });
      const older = await readPublicSessionShare(cfg, locator, { offset: latest?.olderOffset });
      expect(older?.olderOffset).toBe(100);
      expect(older?.messages[0]).toMatchObject({ content: "Message 105" });
      const first = await readPublicSessionShare(cfg, locator, { offset: 200 });
      expect(first?.messages).toHaveLength(5);
      expect(first?.olderOffset).toBeUndefined();
    });
  });

  it("fills pages across hidden rows without splitting tool runs or repeating visible items", async () => {
    await withPublicTestState(async () => {
      await seed(
        Array.from({ length: 40 }, (_, index) => [
          { role: "user", content: `Question ${index}` },
          ...Array.from({ length: 3 }, (_unused, call) => [
            { role: "assistant", content: [{ type: "thinking", thinking: "Private" }] },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: `${index}-${call}`, name: "read", arguments: {} }],
            },
            { role: "toolResult", toolCallId: `${index}-${call}`, content: "Private output" },
          ]).flat(),
          { role: "assistant", content: `Answer ${index}` },
        ]).flat(),
      );
      const pages = [];
      let offset = 0;
      do {
        const page = await readPublicSessionShare(cfg, locator, { offset });
        expect(page).not.toBeNull();
        pages.unshift(projectPublicSessionItems(page!.messages));
        offset = page!.olderOffset ?? 0;
      } while (offset);
      expect(pages.map((page) => page.length)).toEqual([20, 50, 50]);
      const items = pages.flat();
      expect(items.filter((item) => item.kind === "message").map((item) => item.text)).toEqual(
        Array.from({ length: 40 }, (_, index) => [`Question ${index}`, `Answer ${index}`]).flat(),
      );
      const runs = items.filter((item) => item.kind === "tools");
      expect(runs).toHaveLength(40);
      expect(runs.every((run) => run.calls.length === 3)).toBe(true);
    });
  });

  it("reads only the exact current published entry and rechecks revocation before releasing it", async () => {
    await withPublicTestState(async () => {
      await seed(["First", "Second"]);
      const read = (entryId: string, target = locator) =>
        readPublicSessionMessage(cfg, target, { entryId, projection: currentProjection() });
      expect(await read("message-0")).toMatchObject({ content: "First" });
      expect(await read("missing")).toBeNull();
      expect(await read("message-0", { ...locator, shareId: "b".repeat(48) })).toBeNull();
      const original = transcriptReaders.readSessionMessageByIdAsync;
      vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync").mockImplementationOnce(
        async (...args) => {
          const result = await original(...args);
          await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
          return result;
        },
      );
      expect(await read("message-1")).toBeNull();
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

  it("publishes large inline-image descriptors while preserving captions, tools and exact media", async () => {
    await withPublicTestState(async () => {
      const png = createNoisyPngBuffer(1024, 1024);
      const data = png.toString("base64");
      expect(data.length).toBeGreaterThan(1024 * 1024);
      const call = {
        type: "toolCall",
        id: "read-call",
        name: "read",
        arguments: { path: "notes.md" },
      };
      await seed([
        "Oldest",
        {
          role: "assistant",
          content: [
            { type: "text", text: "Model caption" },
            { type: "image", mimeType: "image/png", data },
            call,
          ],
          openclawDisplayContent: [
            { type: "text", text: "Displayed caption" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
        "Newest",
      ]);
      const latest = await readPublicSessionShare(cfg, locator);
      expect(latest?.messages).toMatchObject([{ content: "Newest" }]);
      expect(latest?.olderOffset).toBe(1);
      const page = await readPublicSessionShare(cfg, locator, { offset: latest?.olderOffset });
      expect(page).toMatchObject({ olderOffset: 2 });
      expect(page?.messages).toHaveLength(1);
      expect(page?.messages[0]).toMatchObject({
        content: [{ text: "Model caption" }, { type: "image", omitted: true }, call],
        openclawDisplayContent: [{ text: "Displayed caption" }, { type: "image", omitted: true }],
      });
      expect(JSON.stringify(page?.messages).length).toBeLessThan(1024 * 1024);
      expect(collectPublicSessionAttachments(page?.messages[0])).toEqual([
        { id: "content-1", name: "Image", image: true },
      ]);
      const exact = await readPublicSessionMessage(cfg, locator, {
        entryId: "message-1",
        projection: currentProjection(),
      });
      const loaded = await readPublicSessionAttachment(exact, "content-1", locator);
      expect(loaded?.equals(png)).toBe(true);
      expect(
        (await readPublicSessionShare(cfg, locator, { offset: page?.olderOffset }))?.messages,
      ).toMatchObject([{ content: "Oldest" }]);
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
