import { expect, it, vi } from "vitest";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import * as historyWorkerRuntime from "./session-history-worker-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import type { useTempSessionsFixture } from "./test-helpers.js";
import { transcriptMessage } from "./transcript-message.test-support.js";
import { readRecentUserAssistantTextForSession } from "./transcript.js";

export function registerRecentTranscriptTextSnapshotTests(params: {
  fixture: Pick<ReturnType<typeof useTempSessionsFixture>, "storePath">;
  sessionId: string;
  sessionKey: string;
  createFixtureTranscriptScope: () => Parameters<typeof persistSessionTranscriptTurn>[0];
  writeTranscriptStore: () => Promise<void>;
}) {
  const { fixture, sessionId, sessionKey, createFixtureTranscriptScope, writeTranscriptStore } =
    params;
  it("reads recent context only from the active transcript branch", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      {
        updateMode: "none",
        messages: [
          transcriptMessage("root-user", null, {
            role: "user",
            content: "keep this branch",
            timestamp: 1_000,
          }),
          transcriptMessage("active-reply", "root-user", {
            role: "assistant",
            content: "active answer",
            timestamp: 2_000,
          }),
          transcriptMessage("abandoned-reply", "root-user", {
            role: "assistant",
            content: "abandoned answer",
            timestamp: 3_000,
          }),
        ],
      },
    );
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { type: "leaf", id: "active-leaf", parentId: "abandoned-reply", targetId: "active-reply" },
    );

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([]);
    const databasePath = resolveSqliteTargetFromSessionStorePath(fixture.storePath(), {
      agentId: "main",
    }).path;
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);

    const futureMessages = Array.from({ length: 260 }, (_, index) => ({
      eventId: `future-${index}`,
      parentId: index === 0 ? "active-reply" : `future-${index - 1}`,
      message: { role: "user" as const, content: `future ${index}`, timestamp: 10_000 + index },
    }));
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() },
      { updateMode: "none", messages: futureMessages },
    );
    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
        beforeTimestampMs: 2_500,
        limit: 2,
      }),
    ).resolves.toEqual([
      { id: "root-user", role: "user", text: "keep this branch", timestamp: 1_000 },
      { id: "active-reply", role: "assistant", text: "active answer", timestamp: 2_000 },
    ]);
  });

  it("keeps recent user context on one snapshot while a reply is appended", async () => {
    await writeTranscriptStore();
    const scope = createFixtureTranscriptScope();
    await persistSessionTranscriptTurn(scope, {
      updateMode: "none",
      messages: Array.from({ length: 300 }, (_, index) =>
        transcriptMessage(`snapshot-${index}`, index === 0 ? null : `snapshot-${index - 1}`, {
          role: index === 0 || index === 50 ? "user" : "assistant",
          content: `context ${index}`,
        }),
      ),
    });
    const readPage = historyWorkerRuntime.readSessionHistoryPageInWorker;
    let appended = false;
    const reader = vi.spyOn(historyWorkerRuntime, "readSessionHistoryPageInWorker");
    reader.mockImplementation(async (request, signal) => {
      const page = await readPage(request, signal);
      if (!appended) {
        appended = true;
        await persistSessionTranscriptTurn(scope, {
          updateMode: "none",
          messages: [
            transcriptMessage("appended-reply", "snapshot-299", {
              role: "assistant",
              content: "reply appended after the read snapshot",
            }),
          ],
        });
      }
      return page;
    });
    try {
      await expect(
        readRecentUserAssistantTextForSession({
          agentId: "main",
          sessionKey,
          storePath: fixture.storePath(),
          role: "user",
          limit: 2,
        }),
      ).resolves.toEqual([
        { id: "snapshot-0", role: "user", text: "context 0" },
        { id: "snapshot-50", role: "user", text: "context 50" },
      ]);
      expect(appended).toBe(true);
    } finally {
      reader.mockRestore();
    }
  });
}
