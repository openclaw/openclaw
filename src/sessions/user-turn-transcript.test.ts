// User turn transcript tests cover transcript extraction for user turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
} from "./user-turn-transcript.js";
import { persistUserTurnTranscript } from "./user-turn-transcript.test-support.js";

describe("user turn transcript persistence", () => {
  const tempDirs: string[] = [];
  const unusedRecorderTarget = {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "unused-session",
    sessionKey: "agent:main:unused",
    storePath: "/tmp/openclaw-unused-sessions.json",
  };

  afterEach(() => {
    resetGlobalHookRunner();
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows EPERM on SQLite-locked temp dirs during cleanup is benign.
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createSqliteTranscriptTarget(params: {
    dir: string;
    sessionId?: string;
    sessionKey?: string;
  }) {
    const sessionId = params.sessionId ?? "session-1";
    const sessionKey = params.sessionKey ?? "agent:main:main";
    const storePath = path.join(params.dir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const sqliteMarker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    return {
      agentId: "main",
      cwd: params.dir,
      sessionEntry: undefined,
      sessionId,
      sessionKey,
      storePath,
      sqliteMarker,
    };
  }

  async function readTranscriptMessages(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<Array<Record<string, unknown>>> {
    return (
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      })
    )
      .map((entry) => (entry as { message?: unknown }).message)
      .filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null,
      );
  }

  describe("buildPersistedUserTurnMediaInputsFromFields", () => {
    it("builds media inputs from structured context media fields", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "/tmp/a.png",
          MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.jpg", contentType: "image/jpeg" },
      ]);
    });

    it("uses url-backed media fields when no local path is present", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaUrl: "media://inbound/a.png",
          MediaType: "image/png",
        }),
      ).toEqual([{ url: "media://inbound/a.png", contentType: "image/png" }]);
    });

    it("infers transcript media type from media path when explicit type is absent", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "https://example.test/report.pdf", contentType: "application/pdf" },
      ]);
    });

    it("does not reuse singular media type for later media paths", () => {
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "/tmp/a.png",
          MediaPaths: ["/tmp/a.png", "/tmp/report.pdf"],
          MediaType: "image/png",
        }),
      ).toEqual([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/report.pdf", contentType: "application/pdf" },
      ]);
    });

    it("resolves staged relative media paths against the media workspace", () => {
      const workspaceDir = createTempDir("openclaw-user-turn-media-");

      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPath: "media/inbound/a.png",
          MediaPaths: ["media/inbound/a.png", "media/inbound/b.jpg"],
          MediaType: "image/png",
          MediaTypes: ["image/png", "image/jpeg"],
          MediaWorkspaceDir: workspaceDir,
        }),
      ).toEqual([
        { path: path.join(workspaceDir, "media/inbound/a.png"), contentType: "image/png" },
        { path: path.join(workspaceDir, "media/inbound/b.jpg"), contentType: "image/jpeg" },
      ]);
    });

    it("does not rewrite absolute or URL-like media paths", () => {
      const workspaceDir = createTempDir("openclaw-user-turn-media-");
      const absolutePath = path.join(workspaceDir, "media/inbound/a.png");

      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: [absolutePath, "media://inbound/b.jpg", "https://example.test/c.png"],
          MediaTypes: ["image/png", "image/jpeg", "image/png"],
          MediaWorkspaceDir: workspaceDir,
        }),
      ).toEqual([
        { path: absolutePath, contentType: "image/png" },
        { path: "media://inbound/b.jpg", contentType: "image/jpeg" },
        { path: "https://example.test/c.png", contentType: "image/png" },
      ]);
    });

    it("does not infer media from absent structured fields", () => {
      expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
      expect(buildPersistedUserTurnMediaInputsFromFields({})).toEqual([]);
    });

    it("preserves index alignment when an earlier attachment lacks a content type", () => {
      // Writer pads missing types with "" to keep MediaPaths/MediaTypes index-aligned.
      // The reader must NOT compact those "" holes away before indexing or a later
      // attachment's type lands on the wrong attachment.
      const result = buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/media/a.bin", "/media/b.png"],
        MediaTypes: ["", "image/png"],
      });
      expect(result).toHaveLength(2);
      const [first, second] = result;
      // a.bin has no explicit type in the "" hole. Its contentType must NOT be
      // "image/png" — that belongs to b.png at index 1.
      expect(first).toMatchObject({ path: "/media/a.bin" });
      expect(first?.contentType).not.toBe("image/png");
      // b.png at index 1 must keep its own type correctly aligned.
      expect(second).toEqual({ path: "/media/b.png", contentType: "image/png" });
    });

    it("preserves index alignment when an earlier attachment lacks a url", () => {
      // Same misalignment risk for MediaUrls: a "" hole for a path-only attachment
      // must not shift a later attachment's URL to the wrong index.
      expect(
        buildPersistedUserTurnMediaInputsFromFields({
          MediaPaths: ["/media/local.bin", ""],
          MediaUrls: ["", "https://example.test/remote.png"],
          MediaTypes: ["application/octet-stream", "image/png"],
        }),
      ).toEqual([
        // local.bin has a path but no url (the "" was a placeholder, not a real url).
        { path: "/media/local.bin", contentType: "application/octet-stream" },
        // remote.png has no path (the "" was a placeholder) but does have a url.
        { url: "https://example.test/remote.png", contentType: "image/png" },
      ]);
    });
  });

  describe("mergePreparedUserTurnMessageForRuntime", () => {
    it("adds prepared transcript metadata to runtime user messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "display prompt",
          bareBody: "trusted bare prompt",
          inboundDecorated: true,
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
        },
        target: unusedRecorderTarget,
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: "runtime prompt",
            provenance: { sourceChannel: "telegram" },
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: "display prompt",
        provenance: { sourceChannel: "telegram" },
        timestamp: 123,
        inboundDecorated: true,
        bareBody: "trusted bare prompt",
        MediaPath: "/tmp/image.png",
        MediaType: "image/png",
      });
    });

    it("preserves runtime metadata when adding prepared sender attribution", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "group prompt",
          sender: { id: "user-42", name: "Ada" },
        },
        target: unusedRecorderTarget,
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: "runtime prompt",
            __openclaw: { mirrorIdentity: "run-1:prompt" },
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        __openclaw: {
          mirrorIdentity: "run-1:prompt",
          senderId: "user-42",
          senderName: "Ada",
        },
      });
    });

    it("does not replace blocked before_agent_run user markers", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "raw prompt" },
        target: unusedRecorderTarget,
      });
      const blocked = castAgentMessage({
        role: "user",
        content: "[blocked]",
        __openclaw: { beforeAgentRunBlocked: true },
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: blocked,
          preparedMessage: recorder.message,
        }),
      ).toBe(blocked);
    });

    it("preserves runtime multimodal content while merging prepared metadata", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "canonical image caption", timestamp: 123 },
        target: unusedRecorderTarget,
      });
      const runtimeContent = [
        { type: "text", text: "canonical image caption" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ];

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: runtimeContent,
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: runtimeContent,
        timestamp: 123,
      });
    });

    it("does not apply prepared user metadata to assistant messages", () => {
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "display prompt" },
        target: unusedRecorderTarget,
      });
      const assistant = castAgentMessage({ role: "assistant", content: "hello" });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: assistant,
          preparedMessage: recorder.message,
        }),
      ).toBe(assistant);
    });
  });

  describe("resolvePersistedUserTurnText", () => {
    it("normalizes the selected clean user-turn transcript text", () => {
      expect(resolvePersistedUserTurnText("  What is in this image?  ", { hasMedia: true })).toBe(
        "What is in this image?",
      );
    });

    it("ignores exact channel media placeholders only when structured media is present", () => {
      expect(resolvePersistedUserTurnText("<media:image> (2 images)", { hasMedia: true })).toBe(
        undefined,
      );
      expect(resolvePersistedUserTurnText("<media:image> (2 images)", { hasMedia: false })).toBe(
        "<media:image> (2 images)",
      );
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("appends a structured user turn through the shared transcript writer", async () => {
      const dir = createTempDir("openclaw-user-turn-append-");
      const target = createSqliteTranscriptTarget({ dir });
      const provenance = {
        kind: "inter_session" as const,
        sourceSessionKey: "source-main",
        sourceTool: "sessions_send",
      };

      const appended = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "What is in this image?",
          media: [{ path: "/tmp/image.png", contentType: "image/png" }],
          timestamp: 123,
          senderIsOwner: true,
          provenance,
        },
        updateMode: "none",
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "What is in this image?",
        MediaPath: "/tmp/image.png",
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "What is in this image?",
          MediaPath: "/tmp/image.png",
          __openclaw: { senderIsOwner: true },
          provenance,
          MediaType: "image/png",
        }),
      ]);
    });

    it("persists sender metadata as __openclaw envelope", async () => {
      const dir = createTempDir("openclaw-user-turn-append-sender-");
      const target = createSqliteTranscriptTarget({ dir });

      const appended = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello from group",
          sender: {
            id: "8489979671",
            name: "Ram Shenoy",
            username: "ram_s",
          },
        },
        updateMode: "none",
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "hello from group",
        __openclaw: {
          senderId: "8489979671",
          senderName: "Ram Shenoy",
          senderUsername: "ram_s",
        },
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from group",
          __openclaw: {
            senderId: "8489979671",
            senderName: "Ram Shenoy",
            senderUsername: "ram_s",
          },
        }),
      ]);
    });

    it("omits __openclaw when no sender metadata is provided", async () => {
      const dir = createTempDir("openclaw-user-turn-append-nosender-");
      const target = createSqliteTranscriptTarget({ dir });

      const appended = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello without sender",
          sender: { id: "", name: null },
        },
        updateMode: "none",
      });

      expect(appended?.message).not.toHaveProperty("__openclaw");
    });

    it("uses inline update mode by default", async () => {
      const dir = createTempDir("openclaw-user-turn-append-inline-");
      const target = createSqliteTranscriptTarget({ dir });

      const appended = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello from runtime",
        },
      });

      expect(appended?.message).toMatchObject({
        role: "user",
        content: "hello from runtime",
        timestamp: expect.any(Number),
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from runtime",
          timestamp: expect.any(Number),
        }),
      ]);
    });

    it("returns the existing user turn when the idempotency key was already persisted", async () => {
      const dir = createTempDir("openclaw-user-turn-append-idempotent-");
      const target = createSqliteTranscriptTarget({ dir });

      const first = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        },
        updateMode: "none",
      });
      const second = await persistUserTurnTranscript({
        ...target,
        input: {
          text: "hello once replayed",
          timestamp: 456,
          idempotencyKey: "chat-run-1:user",
        },
        updateMode: "none",
      });

      expect(second?.messageId).toBe(first?.messageId);
      expect(second?.message).toMatchObject({
        role: "user",
        content: "hello once",
        timestamp: 123,
        idempotencyKey: "chat-run-1:user",
      });
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello once",
          timestamp: 123,
          idempotencyKey: "chat-run-1:user",
        }),
      ]);
    });

    it("preserves transcript metadata when before_message_write replaces a user turn", async () => {
      let hookCalls = 0;
      const provenance = {
        kind: "inter_session" as const,
        sourceSessionKey: "source-main",
        sourceTool: "sessions_send",
      };
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              hookCalls += 1;
              const message = (event as { message: Record<string, unknown> }).message;
              const meta = message["__openclaw"] as {
                transport?: { conversationRef?: string; messageId?: string };
              };
              if (meta.transport) {
                meta.transport.conversationRef = "conv_tampered";
                meta.transport.messageId = "tampered-message";
              }
              return {
                message: castAgentMessage({
                  role: "user",
                  content: "[redacted by hook]",
                  __openclaw: { hookOwned: true },
                }),
              };
            },
          },
        ]),
      );
      const dir = createTempDir("openclaw-user-turn-redacted-idempotent-");
      const target = createSqliteTranscriptTarget({ dir });

      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          bareBody: "secret prompt",
          inboundDecorated: true,
          idempotencyKey: "chat-run-1:user",
          senderIsOwner: true,
          provenance,
          sender: { id: "user-42", name: "Ada" },
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });
      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          bareBody: "secret prompt",
          inboundDecorated: true,
          idempotencyKey: "chat-run-1:user",
          senderIsOwner: true,
          provenance,
          sender: { id: "user-42", name: "Ada" },
          transport: {
            channel: "reef",
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            messageId: "inbound-1",
            replyToId: "outbound-1",
          },
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });

      const persistedMessages = await readTranscriptMessages(target);
      expect(persistedMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: "[redacted by hook]",
          idempotencyKey: "chat-run-1:user",
          provenance,
          __openclaw: {
            hookOwned: true,
            senderIsOwner: true,
            transport: {
              channel: "reef",
              conversationRef: "conv_0123456789abcdef0123456789abcdef",
              messageId: "inbound-1",
              replyToId: "outbound-1",
            },
          },
        }),
      ]);
      // PR intent (#95279): a redaction hook must not leak the trusted
      // inbound bare body fields through to persisted storage.
      expect(persistedMessages[0]).not.toHaveProperty("bareBody");
      expect(persistedMessages[0]).not.toHaveProperty("inboundDecorated");
      expect(hookCalls).toBe(1);
    });

    it("drops trusted bare body when before_message_write spreads and rewrites content", async () => {
      // A redaction hook that returns `{ ...message, content }` would otherwise
      // carry the original trusted `bareBody`/`inboundDecorated` through the
      // spread, so downstream UI/replay/memory consumers would trust text the
      // hook meant to redact. The persisted turn must clear those trusted
      // inbound fields whenever the hook rewrites the content.
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const current = (event as { message: Record<string, unknown> }).message;
              return {
                message: castAgentMessage({
                  ...current,
                  role: "user",
                  content: "[redacted by hook]",
                }),
              };
            },
          },
        ]),
      );
      const dir = createTempDir("openclaw-user-turn-redacted-spread-");
      const target = createSqliteTranscriptTarget({ dir });

      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          bareBody: "secret prompt",
          inboundDecorated: true,
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });

      const persistedMessages = await readTranscriptMessages(target);
      expect(persistedMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: "[redacted by hook]",
        }),
      ]);
      // PR intent (#95279): a spread-style redaction hook must not leak the
      // trusted inbound bare body fields into persisted storage.
      expect(persistedMessages[0]).not.toHaveProperty("bareBody");
      expect(persistedMessages[0]).not.toHaveProperty("inboundDecorated");
    });

    it("drops trusted bare body when before_message_write mutates content in place", async () => {
      // Some hooks mutate the event message and return the same object instead
      // of returning a spread copy. Capture the original content before running
      // the hook so this redaction style also clears stale trusted fields.
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (event) => {
              const current = (event as { message: Record<string, unknown> }).message;
              current.content = "[redacted in place by hook]";
              return {
                message: castAgentMessage(current),
              };
            },
          },
        ]),
      );
      const dir = createTempDir("openclaw-user-turn-redacted-in-place-");
      const target = createSqliteTranscriptTarget({ dir });

      await persistUserTurnTranscript({
        ...target,
        input: {
          text: "secret prompt",
          bareBody: "secret prompt",
          inboundDecorated: true,
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      });

      const persistedMessages = await readTranscriptMessages(target);
      expect(persistedMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: "[redacted in place by hook]",
        }),
      ]);
      // PR intent (#95279): an in-place redaction hook must not leak the
      // trusted inbound bare body fields into persisted storage.
      expect(persistedMessages[0]).not.toHaveProperty("bareBody");
      expect(persistedMessages[0]).not.toHaveProperty("inboundDecorated");
    });
  });

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = createTempDir("openclaw-user-turn-persist-");
      const target = createSqliteTranscriptTarget({ dir });
      const sessionStore = {
        [target.sessionKey]: {
          sessionId: target.sessionId,
          sessionFile: target.sqliteMarker,
          updatedAt: 1,
        },
      };

      const persisted = await persistUserTurnTranscript({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionEntry: sessionStore[target.sessionKey],
        sessionStore,
        storePath: target.storePath,
        agentId: target.agentId,
        cwd: dir,
        input: {
          text: "hello",
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(persisted?.sessionFile).toBe(target.sqliteMarker);
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      ]);
    });
  });
});
