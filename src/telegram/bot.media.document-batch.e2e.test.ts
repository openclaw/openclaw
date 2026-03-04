import { describe, expect, it } from "vitest";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandler,
  mockTelegramPngDownload,
} from "./bot.media.test-utils.js";

// Use real timers with short test timing values (25ms batch window).
// The async promise chain inside processDocumentBatch (resolveMedia → processMessage)
// doesn't resolve cleanly under fake timers, so we let real timers flush naturally.
const DOC_BATCH_SETTLE_MS = TELEGRAM_TEST_TIMINGS.documentBatchFlushMs + 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("telegram document batch", () => {
  const DOC_BATCH_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "batches multiple document messages from the same sender into a single processMessage call",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      // Send 3 documents in quick succession (no await gap between dispatches)
      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          caption: "Read all these files",
          date: 1736380800,
          document: { file_id: "doc1", file_unique_id: "u1", file_name: "session01.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session01.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          date: 1736380801,
          document: { file_id: "doc2", file_unique_id: "u2", file_name: "session02.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session02.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 3,
          date: 1736380802,
          document: { file_id: "doc3", file_unique_id: "u3", file_name: "session03.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/session03.md" }),
      });

      // Wait for the batch window to flush
      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      // Caption from first message with caption should be present
      expect(payload.Body).toContain("Read all these files");
      // All 3 documents resolved as media
      expect(payload.MediaPaths).toHaveLength(3);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "a single document flushes after the batch window",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 10,
          caption: "Just one file",
          date: 1736380800,
          document: { file_id: "docA", file_unique_id: "uA", file_name: "report.pdf" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/report.pdf" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0][0].MediaPaths).toHaveLength(1);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "does not batch documents from different senders",
    async () => {
      const { handler, replySpy, runtimeError } = await createBotHandler();
      const fetchSpy = mockTelegramPngDownload();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 20,
          date: 1736380800,
          from: { id: 111, is_bot: false, first_name: "Alice" },
          document: { file_id: "docX", file_unique_id: "uX", file_name: "alice.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/alice.md" }),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 21,
          date: 1736380801,
          from: { id: 222, is_bot: false, first_name: "Bob" },
          document: { file_id: "docY", file_unique_id: "uY", file_name: "bob.md" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "documents/bob.md" }),
      });

      await sleep(DOC_BATCH_SETTLE_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      // Each sender's documents should flush separately
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[0][0].MediaPaths).toHaveLength(1);
      expect(replySpy.mock.calls[1][0].MediaPaths).toHaveLength(1);

      fetchSpy.mockRestore();
    },
    DOC_BATCH_TEST_TIMEOUT_MS,
  );
});
