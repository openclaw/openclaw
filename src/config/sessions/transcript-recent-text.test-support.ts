import { expect, it, onTestFinished, vi } from "vitest";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import * as historyWorkerRuntime from "./session-history-worker-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";
import {
  appendAssistantMessageToSessionTranscript,
  readRecentUserAssistantTextForSession as readRecent,
} from "./transcript.js";

export function registerRecentTranscriptTextSnapshotTests(params: {
  fixture: { storePath(): string };
  sessionId: string;
  sessionKey: string;
  createFixtureTranscriptScope: () => Record<
    "agentId" | "sessionId" | "sessionKey" | "storePath",
    string
  >;
  writeTranscriptStore: () => Promise<void>;
}) {
  const { fixture, createFixtureTranscriptScope: scope, writeTranscriptStore } = params;
  const read = (
    options: Omit<Parameters<typeof readRecent>[0], "agentId" | "sessionKey" | "storePath"> = {},
  ) => readRecent({ ...scope(), ...options });
  const persist = (messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"]) =>
    persistSessionTranscriptTurn(scope(), { updateMode: "none", messages });
  it("restores only confirmed final message-tool replies when requested", async () => {
    await writeTranscriptStore();
    const mirrors = [
      { kind: "message-tool-source-reply", final: false, sourceTurnId: "source-turn" },
      { kind: "message-tool-source-reply", final: true, sourceTurnId: "source-turn" },
      { kind: "message-tool-source-reply", final: true },
      { kind: "channel-final" },
    ] as const;
    for (const [index, deliveryMirror] of mirrors.entries()) {
      expect(
        await appendAssistantMessageToSessionTranscript({
          ...scope(),
          text: `reply ${index}`,
          idempotencyKey: `delivery-${index}`,
          deliveryMirror,
        }),
      ).toMatchObject({ ok: true });
    }
    await expect(read()).resolves.toEqual([]);
    await expect(read({ includeMessageToolSourceReplies: true })).resolves.toEqual([
      expect.objectContaining({ role: "assistant", text: "reply 1" }),
    ]);
  });

  it("reads recent context only from the active transcript branch", async () => {
    await writeTranscriptStore();
    const expected = [
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ];
    await persist([
      ...expected.map(({ id, role, text: content, timestamp }, index) =>
        transcriptMessage(id, index ? "root-user" : null, { role, content, timestamp }),
      ),
      transcriptMessage("abandoned-reply", "root-user", {
        role: "assistant",
        content: "abandoned answer",
        timestamp: 3_000,
      }),
    ]);
    await appendTranscriptEvent(scope(), {
      type: "leaf",
      id: "active-leaf",
      parentId: "abandoned-reply",
      targetId: "active-reply",
    });

    const databasePath = resolveSqliteTargetFromSessionStorePath(fixture.storePath(), {
      agentId: "main",
    }).path;
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });

    await expect(read()).resolves.toEqual(expected);

    await persist(
      Array.from({ length: 260 }, (_, index) => ({
        eventId: `future-${index}`,
        parentId: index === 0 ? "active-reply" : `future-${index - 1}`,
        message: { role: "user" as const, content: `future ${index}`, timestamp: 10_000 + index },
      })),
    );
    await expect(read({ beforeTimestampMs: 2_500, limit: 2 })).resolves.toEqual(expected);
  });

  it("keeps recent user context on one snapshot while a reply is appended", async () => {
    await writeTranscriptStore();
    await persist(
      Array.from({ length: 300 }, (_, index) =>
        transcriptMessage(`snapshot-${index}`, index === 0 ? null : `snapshot-${index - 1}`, {
          role: index === 0 || index === 50 ? "user" : "assistant",
          content: `context ${index}`,
        }),
      ),
    );
    const readPage = historyWorkerRuntime.readSessionHistoryPageInWorker;
    let appended = false;
    const reader = vi.spyOn(historyWorkerRuntime, "readSessionHistoryPageInWorker");
    onTestFinished(() => reader.mockRestore());
    reader.mockImplementation(async (request, signal) => {
      const page = await readPage(request, signal);
      if (!appended) {
        appended = true;
        await persist([
          transcriptMessage("reply", "snapshot-299", { role: "assistant", content: "new" }),
        ]);
      }
      return page;
    });
    await expect(read({ role: "user", limit: 2 })).resolves.toEqual([
      { id: "snapshot-0", role: "user", text: "context 0" },
      { id: "snapshot-50", role: "user", text: "context 50" },
    ]);
    expect(appended).toBe(true);
  });
}
