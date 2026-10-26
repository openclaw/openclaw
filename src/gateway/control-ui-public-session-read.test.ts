import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import * as transcriptMatch from "../config/sessions/session-transcript-match.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  collectPublicSessionAttachments,
  readPublicSessionAttachment,
} from "./control-ui-public-session-attachments.js";
import { publicReadBarrier } from "./control-ui-public-session-barrier.test-support.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";
import {
  isPublicSessionShareActive as readActive,
  readPublicSessionMessage,
  readPublicSessionWidget,
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
const rowQuery = { key: locator.sessionKey, agentId: locator.agentId };
const message = (role: string, content: unknown, fields: Record<string, unknown> = {}) => ({
  role,
  content,
  ...fields,
});
const widget = (details: unknown, fields: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolName: "show_widget",
  details,
  ...fields,
});

let projection: SessionRowProjection | undefined;
function currentProjection() {
  if (!projection) {
    throw new Error("Public reader fixture is not prepared");
  }
  return projection;
}
function readPage(
  options: { offset?: number; card?: boolean } = {},
  target = locator,
  config: OpenClawConfig = cfg,
) {
  return readShare(config, target, { ...options, projection: currentProjection() });
}
const isActive = () => readActive(cfg, locator, currentProjection());
async function withPublicTestState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
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
      expect(await readPage()).not.toBeNull();
      const sql = observeHostDataSql();
      try {
        for (let viewer = 0; viewer < 20; viewer++) {
          expect(isActive()).toBe(true);
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  });

  it("fills pages across hidden rows without splitting tool runs or repeating visible items", async () => {
    await withPublicTestState(async () => {
      await seed(
        Array.from({ length: 40 }, (_, index) => [
          message("user", `Question ${index}`),
          ...Array.from({ length: 3 }, (_unused, call) => [
            message("assistant", [{ type: "thinking", thinking: "Private" }]),
            message("assistant", [
              { type: "toolCall", id: `${index}-${call}`, name: "read", arguments: {} },
            ]),
            message("toolResult", "Private output", { toolCallId: `${index}-${call}` }),
          ]).flat(),
          message("assistant", `Answer ${index}`),
        ]).flat(),
      );
      const pages = [];
      let offset = 0;
      do {
        const page = await readPage({ offset });
        expect(page).toMatchObject({
          title: "Public example",
          totalMessages: 440,
          truncated: false,
        });
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

  it("authorizes nested and top-level widget receipts only in the published generation", async () => {
    await withPublicTestState(async () => {
      const details = (name: string) => {
        const id = `cv_${name}`;
        return {
          kind: "canvas",
          presentation: { target: "assistant_message" },
          view: { id, url: `/__openclaw__/canvas/documents/${id}/index.html` },
        };
      };
      await seed([
        widget(details("top-level-chart"), { toolCallId: "inline-chart" }),
        widget(details("hidden-chart"), { display: false }),
        widget(details("internal-chart"), { provenance: { kind: "internal" } }),
        createNestedToolActivity({
          runId: "chart-run",
          scopeId: "chart-scope",
          afterEntryId: null,
          startOrder: 0,
          parentToolCallId: "exec-chart",
          toolCallId: "nested-chart",
          toolName: "show_widget",
          input: {},
          result: { content: [], details: details("nested-chart") },
          isError: false,
          startedAt: 1,
          timestamp: 2,
        }),
      ]);
      const other = { ...locator, sessionKey: "agent:main:other", sessionId: "other-generation" };
      await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(other, [
        {
          type: "message",
          id: "private-widget",
          message: widget(details("other-chart")),
        },
      ]);
      const read = (docId: string, target = locator) =>
        readPublicSessionWidget(cfg, target, {
          docId: `cv_${docId}`,
          projection: currentProjection(),
        });
      expect(await read("top-level-chart")).toBe(true);
      expect(await read("nested-chart")).toBe(true);
      expect(await read("hidden-chart")).toBe(false);
      expect(await read("internal-chart")).toBe(false);
      expect(await read("other-chart")).toBe(false);
      expect(await read("top-level-chart", { ...locator, sessionId: "old-generation" })).toBe(
        false,
      );
      const find = transcriptMatch.findTranscriptEvent;
      vi.spyOn(transcriptMatch, "findTranscriptEvent").mockImplementationOnce(async (...args) => {
        const result = await find(...args);
        await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
        return result;
      });
      expect(await read("top-level-chart")).toBe(false);
      expect(await read("nested-chart")).toBe(false);
    });
  });

  it("enforces the byte bound and advances past oversized source rows without losing older messages", async () => {
    await withPublicTestState(async () => {
      await seed(["Oldest", "x".repeat(1024 * 1024 + 1), "Newest"]);
      const latest = await readPage();
      expect(latest).toMatchObject({ messages: [{ content: "Newest" }], olderOffset: 1 });
      const oversized = await readPage({ offset: 1 });
      expect(oversized).toMatchObject({ messages: [], truncated: true, olderOffset: 2 });
      const oldest = await readPage({ offset: 2 });
      expect(oldest?.messages).toMatchObject([{ content: "Oldest" }]);
      expect(oldest?.olderOffset).toBeUndefined();
      const preview = await readPage({ card: true });
      expect(preview).toMatchObject({ messages: [{ content: "Oldest" }], totalMessages: 3 });
    });
  });

  it("finds the first public user request after private and assistant prelude in a long history", async () => {
    await withPublicTestState(async () => {
      await seed([
        { role: "system", content: "Private system prelude" },
        { role: "user", content: "Private runtime input", provenance: { kind: "internal" } },
        { role: "assistant", content: "Ready to help" },
        "Opening public request",
        ...Array.from({ length: 205 }, (_, index) => `Later request ${index}`),
      ]);
      const preview = await readPage({ card: true });
      expect(preview).toMatchObject({
        messages: [{ content: "Opening public request" }],
        totalMessages: 209,
      });
    });
  });

  it("keeps opening discovery inside the first hundred source positions", async () => {
    await withPublicTestState(async () => {
      await seed([
        ...Array.from({ length: 100 }, () => ({ role: "assistant", content: "Prelude" })),
        "Later request outside the opening window",
      ]);
      const preview = await readPage({ card: true });
      expect(preview).toMatchObject({ messages: [], totalMessages: 101 });
    });
  });

  it.each(["image", "image_url", "input_image"])(
    "publishes large %s descriptors while preserving captions, tools and exact media",
    async (type) => {
      await withPublicTestState(async () => {
        const png = createNoisyPngBuffer(1024, 1024);
        const data = png.toString("base64");
        expect(data.length).toBeGreaterThan(1024 * 1024);
        const image =
          type === "image"
            ? { type, mimeType: "image/png", data }
            : {
                type,
                image_url:
                  type === "input_image"
                    ? `data:image/png;base64,${data}`
                    : { url: `data:image/png;base64,${data}` },
              };
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
            content: [{ type: "text", text: "Model caption" }, image, call],
            openclawDisplayContent: [{ type: "text", text: "Displayed caption" }, image],
          },
          "Newest",
        ]);
        const latest = await readPage();
        expect(latest).toMatchObject({ messages: [{ content: "Newest" }], olderOffset: 1 });
        const page = await readPage({ offset: latest?.olderOffset });
        expect(page).toMatchObject({ olderOffset: 2 });
        expect(page?.messages).toHaveLength(1);
        expect(page?.messages[0]).toMatchObject({
          content: [{ text: "Model caption" }, { type, omitted: true }, call],
          openclawDisplayContent: [{ text: "Displayed caption" }, { type, omitted: true }],
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
        expect((await readPage({ offset: page?.olderOffset }))?.messages).toMatchObject([
          { content: "Oldest" },
        ]);
      });
    },
  );

  it("rejects private, unknown-agent, mismatched-instance and mismatched-grant requests", async () => {
    await withPublicTestState(async () => {
      await seed(["Published"]);
      expect(isActive()).toBe(true);
      for (const target of [
        { ...locator, agentId: "other" },
        { ...locator, sessionKey: "agent:other:public-history" },
        { ...locator, sessionKey: "main" },
        { ...locator, sessionId: "old-generation" },
        { ...locator, shareId: "b".repeat(48) },
        { ...locator, sessionKey: "agent:main:incognito-private" },
      ]) {
        expect(await readPage({}, target)).toBeNull();
      }
      expect(await readPage({}, locator, { agents: { entries: {} } })).toBeNull();
      await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
      expect(isActive()).toBe(false);
      expect(await readPage()).toBeNull();
    });
  });

  it.for(["metadata", "revoke", "reset"] as const)(
    "rechecks %s after awaited history before releasing content",
    async (action, { signal }) => {
      await withPublicTestState(async () => {
        await seed(["Must not escape after closure"]);
        const membership = publicReadBarrier(signal);
        const revalidation = publicReadBarrier(signal);
        let holdMembership = false;
        let historyReturned = false;
        if (action === "metadata") {
          const createReaders = historyReaders.createSessionHistoryWorkerReaders;
          vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation(
            (...args) => {
              const readers = createReaders(...args);
              const readMembership = readers.readMembershipFacts;
              readers.readMembershipFacts = async (...input) => {
                const result = await readMembership.call(readers, ...input);
                if (holdMembership) {
                  await membership.hold();
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
              revalidation.enter();
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
              await withinTest(membership.entered, signal);
              expect(currentProjection().sharingTargetState(rowQuery).status).toBe("pending");
            }
            historyReturned = true;
            return result;
          },
        );
        const reading = readPage();
        try {
          if (action === "metadata") {
            await revalidation.wait(
              reading,
              "Public session read settled before rejoining invalidated membership",
            );
            membership.release();
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
          membership.release();
          await Promise.allSettled([reading]);
        }
      });
    },
  );

  it("reads the exact global node in its configured store without resolving aliases", async () => {
    await withPublicTestState(async () => {
      const global = { ...locator, sessionKey: "global" };
      await seed(["Global publication"], global);
      expect((await readPage({}, global))?.messages).toMatchObject([
        { content: "Global publication" },
      ]);
    });
  });
});
