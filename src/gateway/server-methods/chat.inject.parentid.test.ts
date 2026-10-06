// Chat transcript parent-id tests protect gateway-injected assistant appends so
// compaction history remains connected and transcript listeners receive updates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

type SqliteTranscriptFixture = {
  agentId: string;
  dir: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
};

async function createSqliteTranscriptFixture(params: {
  prefix: string;
  sessionId: string;
}): Promise<SqliteTranscriptFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const sessionKey = "main";
  const agentId = "main";
  const storePath = path.join(dir, "sessions.json");
  await replaceSessionEntry(
    { agentId, sessionKey, storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  return { agentId, dir, sessionKey, sessionId: params.sessionId, storePath };
}

async function cleanupFixture(fixture: { dir: string }) {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

async function readTranscriptEvents(
  fixture: SqliteTranscriptFixture,
): Promise<Record<string, unknown>[]> {
  return (await loadTranscriptEvents({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
  })) as Record<string, unknown>[];
}

async function appendHelloAndRequireId(fixture: SqliteTranscriptFixture): Promise<string> {
  const appended = await appendInjectedAssistantMessageToTranscript({
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
    message: "hello",
  });
  expect(appended.ok).toBe(true);
  expect(appended.messageId).toBeTypeOf("string");
  const messageId = appended.messageId;
  if (!messageId) {
    throw new Error("expected appended message id");
  }
  expect(messageId.length).toBeGreaterThan(0);
  return messageId;
}

async function readLastTranscriptRecord(
  fixture: SqliteTranscriptFixture,
): Promise<Record<string, unknown>> {
  const events = await readTranscriptEvents(fixture);
  expect(events.length).toBeGreaterThanOrEqual(2);
  return events.at(-1) as Record<string, unknown>;
}

// Guardrail: Gateway-injected assistant transcript messages must attach to the
// current leaf with a `parentId` and must not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it.for([false, true])(
    "joins committed media before publication or callback failure (%s)",
    async (failCallback, test) => {
      const fixture = await createSqliteTranscriptFixture({
        prefix: "openclaw-chat-inject-media-completion-",
        sessionId: "media-completion",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const bytes = createSolidPngBuffer(1, 1, { r: 34, g: 51, b: 68 });
      const updates: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.target.sessionId === fixture.sessionId) {
          updates.push(update);
        }
      });
      let pending: ReturnType<typeof appendInjectedAssistantMessageToTranscript> | undefined;
      try {
        const blocks = await createManagedOutgoingMediaBlocks({
          sessionKey: fixture.sessionKey,
          agentId: fixture.agentId,
          stateDir: fixture.dir,
          items: [
            { url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false },
          ],
        });
        pending = appendInjectedAssistantMessageToTranscript({
          ...fixture,
          message: "Image ready",
          content: [{ type: "text", text: "Image ready" }, ...blocks],
          onMessageCommitted: (receipt, acceptCompletion) => {
            acceptCompletion(async () => {
              entered.resolve();
              await release.promise;
              expect(
                await attachManagedOutgoingMediaToMessage({
                  messageId: receipt.messageId,
                  blocks,
                  stateDir: fixture.dir,
                }),
              ).toBe(true);
            });
            if (failCallback) {
              throw new Error("Synthetic callback failure after custody acceptance");
            }
          },
        });
        await racePromiseWithAbortSignal(
          Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Injection never accepted media completion");
            }),
          ]),
          test.signal,
        );
        expect(updates).toEqual([]);
        release.resolve();
        expect(await pending).toMatchObject({ ok: !failCallback });
        expect(updates).toHaveLength(failCallback ? 0 : 1);
        const entries = await listManagedImageRecordEntries({ stateDir: fixture.dir });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record).toMatchObject({
          messageId: expect.any(String),
          retentionClass: "history",
        });
        expect((await readLastTranscriptRecord(fixture)).message).toMatchObject({
          content: [{ type: "text", text: "Image ready" }],
          openclawDisplayContent: [{ type: "text", text: "Image ready" }, ...blocks],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        unsubscribe();
        await cleanupFixture(fixture);
      }
    },
  );

  it.each(["aborted"] as const)(
    "retains %s on both display and model content",
    async (stopReason) => {
      const fixture = await createSqliteTranscriptFixture({
        prefix: "openclaw-chat-inject-display-content-",
        sessionId: "sess-display-content",
      });
      const modelContent = [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "Slides ready" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ];
      const attachment = {
        type: "attachment",
        attachment: { kind: "document", label: "slides.pptx" },
      };

      try {
        const appended = await appendInjectedAssistantMessageToTranscript({
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          sessionKey: fixture.sessionKey,
          storePath: fixture.storePath,
          message: "Slides ready",
          content: [...modelContent, attachment],
          stopReason,
        });
        const last = (await readLastTranscriptRecord(fixture)) as {
          message?: Record<string, unknown>;
        };

        expect(appended.message).toMatchObject({
          role: "assistant",
          content: [...modelContent, attachment],
          stopReason,
        });
        expect(last.message).toMatchObject({
          content: modelContent,
          openclawDisplayContent: [...modelContent, attachment],
          stopReason,
        });
      } finally {
        await cleanupFixture(fixture);
      }
    },
  );

  it("preserves parent links after an oversized transcript row", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-large-",
      sessionId: "sess-1",
    });

    try {
      const existing = appendTranscriptMessageSync(
        {
          agentId: fixture.agentId,
          sessionId: fixture.sessionId,
          sessionKey: fixture.sessionKey,
          storePath: fixture.storePath,
        },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          },
        },
      );

      const messageId = await appendHelloAndRequireId(fixture);
      const last = await readLastTranscriptRecord(fixture);

      expect(existing).toMatchObject({ ok: true });
      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", messageId);
      expect(last).toHaveProperty("message");
      expect(last).toHaveProperty("parentId", existing.ok ? existing.value?.messageId : undefined);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("emits a redacted injected message through its persisted transcript owner", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-redact-",
      sessionId: "sess-redact",
    });
    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const updates: Array<{ message?: unknown; sessionKey?: string; agentId?: string }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        agentId: fixture.agentId,
        sessionId: fixture.sessionId,
        sessionKey: "global",
        storePath: fixture.storePath,
        message: `Here is your key: ${fakeApiKey}`,
        config: {},
      });

      expect(appended.ok).toBe(true);
      expect(JSON.stringify(appended.message)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ sessionKey: "agent:main:main", agentId: "main" });

      const last = (await readLastTranscriptRecord(fixture)) as { message?: unknown };
      expect(JSON.stringify(last.message)).not.toContain(fakeApiKey);
      expect(updates[0]?.message).toEqual(last.message);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
      await cleanupFixture(fixture);
    }
  });
});
