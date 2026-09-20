import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
} from "../../config/sessions/session-accessor.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import * as mediaFetch from "../../media/fetch.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../../media/store-network.test-support.js";
import * as hookRunnerGlobal from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  attachSessionTranscriptRunId,
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { cleanupManagedOutgoingMediaRecords } from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { projectTranscriptEntryMessage } from "../session-transcript-entry-message.js";
import { loadSessionEntry } from "../session-utils.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import * as chatTranscriptPersistence from "./chat-transcript-persistence.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const MEDIA_URL = "https://media.example.test/11111111-1111-4111-8111-111111111111";
const remoteFixtures = new Map<string, string>();
const fetchedUrls: string[] = [];

let restoreRemoteMedia: (() => void) | undefined;
beforeAll(() => {
  const saveRemoteMedia = mediaFetch.saveRemoteMedia;
  const wrapped = wrapStoreSaveRemoteMedia(saveRemoteMedia);
  const spy = vi.spyOn(mediaFetch, "saveRemoteMedia").mockImplementation((options) => {
    fetchedUrls.push(options.url);
    const fixtureUrl = remoteFixtures.get(options.url);
    if (!fixtureUrl) {
      throw new Error("Unexpected remote attachment in commentary fixture");
    }
    return wrapped({
      ...options,
      url: fixtureUrl,
    });
  });
  restoreRemoteMedia = () => spy.mockRestore();
});
afterAll(() => {
  disposeStoreRemoteFixtures();
  restoreRemoteMedia?.();
});

describe("webchat commentary media", () => {
  it.each([
    "image",
    "worktree",
    "sender-denied",
    "document",
    "hook",
    "revoked",
    "aborted",
    "completion",
    "top-level",
    "mixed-text",
    "mixed-media",
    "unrelated-rewrite",
    "target-rewrite",
    "gc-during-preparation",
    "gc-with-publication-failure",
    "gc-with-revocation-after-commit",
  ] as const)("materializes authored progress media with %s semantics", async (scenario) => {
    await withOpenClawTestState({ label: "commentary-media" }, async (state) => {
      fetchedUrls.length = 0;
      let requestCount = 0;
      let abortedResponseClosed = false;
      const abortController = new AbortController();
      const imageResponse = createDeferred();
      const gcDuringPreparation =
        scenario === "gc-during-preparation" ||
        scenario === "gc-with-publication-failure" ||
        scenario === "gc-with-revocation-after-commit";
      const upstream = http.createServer((_request, response) => {
        requestCount += 1;
        const send = () => {
          response.writeHead(200, {
            "content-type": scenario === "document" ? "application/pdf" : "image/png",
          });
          response.end(
            scenario === "document" ? Buffer.from("%PDF-1.7\nfixture\n%%EOF") : PNG_BYTES,
          );
        };
        if (
          (scenario === "revoked" || scenario === "aborted" || gcDuringPreparation) &&
          requestCount === 1
        ) {
          send();
        } else if (scenario === "aborted") {
          response.writeHead(200, { "content-type": "image/png" });
          response.write(PNG_BYTES.subarray(0, 16));
          response.on("close", () => {
            abortedResponseClosed = !response.writableFinished;
          });
        } else {
          void imageResponse.promise.then(send);
        }
      });
      await new Promise<void>((resolve) => {
        upstream.listen(0, "127.0.0.1", resolve);
      });
      const address = upstream.address() as AddressInfo;
      const fixtureUrl = `http://127.0.0.1:${address.port}/11111111-1111-4111-8111-111111111111`;
      const mediaUrl = MEDIA_URL;
      const worktree = state.statePath("worktrees", "project");
      const relativeImage = "./proof/relative.png";
      const absoluteImage = path.join(worktree, "proof", "absolute.png");
      const siblingImage = state.statePath("worktrees", "other", "private.png");
      const localMedia = scenario === "worktree" || scenario === "sender-denied";
      if (localMedia) {
        for (const file of [absoluteImage, path.join(worktree, relativeImage), siblingImage]) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, PNG_BYTES);
        }
      }
      const mediaUrls = localMedia
        ? [absoluteImage, relativeImage, siblingImage]
        : scenario === "revoked" || scenario === "aborted" || gcDuringPreparation
          ? [mediaUrl, `${mediaUrl}/second`]
          : [mediaUrl];
      const mixed = scenario === "mixed-text" || scenario === "mixed-media";
      const finalMediaUrl = scenario === "mixed-media" ? `${mediaUrl}/final` : undefined;
      const authoredUrls = [...mediaUrls, ...(finalMediaUrl ? [finalMediaUrl] : [])];
      const finalText = "Final result";
      for (const url of authoredUrls) {
        remoteFixtures.set(url, fixtureUrl);
      }
      const scope = {
        agentId: "main",
        sessionId: "commentary-session",
        sessionKey: "agent:main:commentary",
        storePath: loadSessionEntry("agent:main:commentary", { agentId: "main" }).storePath,
      };
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "initial",
        updatedAt: 1,
        ...(localMedia
          ? { spawnedCwd: worktree, spawnedBy: "agent:main:main", sessionRoot: worktree }
          : {}),
      });
      // Prepare the shared media store before the download-sequencing checks.
      expect(await listManagedImageRecordEntries({ sessionKey: scope.sessionKey })).toEqual([]);
      if (scenario === "unrelated-rewrite") {
        expect(
          appendTranscriptMessageSync(scope, {
            eventId: "unrelated-row",
            message: { role: "user", content: [{ type: "text", text: "Unrelated before" }] },
          }),
        ).toMatchObject({ ok: true });
      }
      const runId = "commentary-run";
      const commentarySettled = createDeferred();
      const warn = vi.fn(() => commentarySettled.resolve());
      let current = true;
      let admittedActive = true;
      let cleanupStarted = false;
      let cleanupSettled = false;
      const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
        runId,
        sessionId: scope.sessionId,
      });
      const transcriptContext = {
        sessionTarget: {
          ...scope,
          storePath: loadSessionEntry(scope.sessionKey, { agentId: scope.agentId }).storePath,
        },
        assertCommitAllowed: () => {
          if (!admittedActive) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
        },
        withTranscriptWrite: <T>(operation: () => Promise<T> | T) =>
          transcriptLifecycle.withTranscriptWrite(operation),
      };
      const dispatch = createChatSendReplyDispatch({
        accountId: undefined,
        requesterContext: { SenderId: "cli" },
        isAgentRunStarted: () => true,
        isRunCurrent: () => current,
        abortSignal: abortController.signal,
        logGateway: { warn } as never,
        session: {
          ...scope,
          backingSessionId: scope.sessionId,
          cfg: {
            agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
            ...(localMedia
              ? {
                  tools: {
                    fs: { workspaceOnly: true },
                    ...(scenario === "sender-denied"
                      ? { toolsBySender: { "id:cli": { deny: ["read"] } } }
                      : {}),
                  },
                }
              : {}),
          },
          clientRunId: runId,
          sessionLoadOptions: { agentId: "main" },
        },
        userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
      });
      const content = [
        {
          type: "text" as const,
          text: `Before\n${mediaUrls.map((url) => `MEDIA:${url}`).join("\n")}\nAfter`,
          ...(scenario === "top-level"
            ? {}
            : {
                textSignature: JSON.stringify({
                  v: 1,
                  id: "progress-image",
                  phase: "commentary",
                }),
              }),
        },
        {
          type: "toolCall" as const,
          id: "inspect-next",
          name: "read",
          arguments: { path: "next.ts" },
        },
        ...(mixed
          ? [
              {
                type: "text" as const,
                text: finalMediaUrl ? `${finalText}\nMEDIA:${finalMediaUrl}` : finalText,
                textSignature: JSON.stringify({ v: 1, id: "final-result", phase: "final_answer" }),
              },
            ]
          : []),
      ];
      const hookSpy =
        scenario === "hook"
          ? vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
              createHookRunner(
                createMockPluginRegistry([
                  {
                    hookName: "before_message_write",
                    handler: (event: unknown) => {
                      const message = asOptionalRecord(asOptionalRecord(event)?.message);
                      if (message?.role === "assistant" && Array.isArray(message.content)) {
                        const first = asOptionalRecord(message.content[0]);
                        if (first?.type === "text" && typeof first.text === "string") {
                          first.text += "\nMEDIA:https://media.example.test/hook-added";
                        }
                      }
                    },
                  },
                ]),
              ),
            )
          : undefined;
      const readEvent = (messageId = "progress-row") => {
        const events = loadTranscriptEventsSync(scope);
        const event = events
          .map(asOptionalRecord)
          .find((entry) => entry?.type === "message" && entry.id === messageId);
        if (!event || event.type !== "message") {
          throw new Error("Expected persisted commentary row");
        }
        return event;
      };
      const readMessage = () => {
        const message = asOptionalRecord(readEvent().message);
        if (!message) {
          throw new Error("Expected assistant message");
        }
        return message;
      };
      const readDisplayed = () => {
        const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "progress-row" });
        if (!anchor) {
          throw new Error("Expected committed transcript anchor");
        }
        return projectChatDisplayMessages(
          [projectTranscriptEntryMessage(readEvent(), anchor.rawSeq)],
          { includeCommentaryFallbacks: true },
        );
      };
      let rewriteUpdate: InternalSessionTranscriptUpdate | undefined;
      const stopUpdates = onInternalSessionTranscriptUpdate((update) => {
        if (
          update.target?.sessionId === scope.sessionId &&
          update.messageId === "progress-row" &&
          update.message === undefined
        ) {
          rewriteUpdate = update;
          commentarySettled.resolve();
        }
      });
      let run: Promise<void> | undefined;
      let expectedContent: unknown;
      const rewrite = sessionAccessor.rewriteTranscriptMessageAtAnchor;
      const rewriteSpy =
        scenario === "gc-with-revocation-after-commit"
          ? vi
              .spyOn(sessionAccessor, "rewriteTranscriptMessageAtAnchor")
              .mockImplementation(async (...args) => {
                const result = await rewrite(...args);
                current = false;
                return result;
              })
          : undefined;
      const publicationSpy =
        scenario === "gc-with-publication-failure"
          ? vi
              .spyOn(chatTranscriptPersistence, "publishAssistantTranscriptRewrite")
              .mockRejectedValueOnce(new Error("Synthetic commentary publication failure"))
          : undefined;
      try {
        run = withStoreRemoteFixture({ url: fixtureUrl }, () =>
          dispatch.runAgentMediaTranscript({ run: async (operation) => operation() }, async () =>
            withOwnedSessionTranscriptWrites(transcriptContext, async () => {
              try {
                dispatch.captureAgentTranscriptStart();
                const message = runAgentHarnessBeforeMessageWriteHook({
                  message: attachSessionTranscriptRunId(
                    {
                      ...buildAssistantMessage({
                        model: {
                          api: "openai-responses",
                          provider: "openai",
                          id: "gpt-5.6-luna",
                        },
                        content,
                        stopReason: "toolUse",
                        usage: buildUsageWithNoCost({}),
                      }),
                      ...(scenario === "top-level" ? { phase: "commentary" as const } : {}),
                    },
                    runId,
                  ),
                  prepareAssistantTranscriptMessage: dispatch.prepareAssistantTranscriptMessage,
                });
                expect(message).toMatchObject({ openclawDelivery: { mediaUrls: authoredUrls } });
                if (message?.role !== "assistant") {
                  throw new Error("Expected prepared assistant");
                }
                expectedContent = structuredClone(message.content);
                const appended = appendTranscriptMessageSync(scope, {
                  eventId: "progress-row",
                  message,
                });
                expect(appended).toMatchObject({ ok: true });
                await publishTranscriptUpdate(scope, {
                  message,
                  messageId: "progress-row",
                  runId,
                });
                await vi.waitFor(() => {
                  expect(warn).not.toHaveBeenCalled();
                  expect(requestCount).toBe(localMedia ? 0 : mediaUrls.length);
                });
                if (scenario === "completion") {
                  return;
                }
                if (gcDuringPreparation) {
                  // The second download holds the rewrite while the first original is on disk.
                  expect(readMessage()).not.toHaveProperty("openclawDisplayContent");
                  expect(
                    await listManagedImageRecordEntries({ sessionKey: scope.sessionKey }),
                  ).toHaveLength(1);
                  expect(await cleanupManagedOutgoingMediaRecords()).toEqual({
                    deletedRecordCount: 0,
                    deletedFileCount: 0,
                    retainedCount: 1,
                  });
                }
                if (scenario === "aborted") {
                  current = false;
                  abortController.abort();
                  return;
                }
                if (scenario === "revoked") {
                  current = false;
                }
                if (scenario === "unrelated-rewrite" || scenario === "target-rewrite") {
                  const messageId =
                    scenario === "unrelated-rewrite" ? "unrelated-row" : "progress-row";
                  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId });
                  if (!anchor) {
                    throw new Error("Expected rewrite target");
                  }
                  const rewritten = await rewriteTranscriptMessageAtAnchor(anchor, (value) => {
                    const targetMessage = asOptionalRecord(value);
                    if (!targetMessage) {
                      throw new Error("Expected rewrite message");
                    }
                    return {
                      ...targetMessage,
                      content: [{ type: "text", text: "Rewritten while loading" }],
                    };
                  });
                  expect(rewritten).not.toBeNull();
                  expect(rewritten?.generation).not.toBe(anchor.generation);
                }
                imageResponse.resolve();
                if (scenario === "revoked" || scenario === "target-rewrite" || rewriteSpy) {
                  return;
                }
                await commentarySettled.promise;
                expect(readMessage()).toHaveProperty("openclawDisplayContent");
                const persisted = readMessage();
                expect(persisted).toMatchObject({
                  content: expectedContent,
                  stopReason: "toolUse",
                });
                if (!publicationSpy) {
                  expect(rewriteUpdate).toMatchObject({
                    messageId: "progress-row",
                    target: expect.objectContaining({ sessionId: scope.sessionId }),
                  });
                  expect(rewriteUpdate).not.toHaveProperty("message");
                }
                const displayed = readDisplayed();
                const displayedMedia = displayed
                  .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
                  .map(asOptionalRecord)
                  .filter((block) => block?.type === "image" || block?.type === "attachment");
                expect(displayedMedia).toHaveLength(
                  scenario === "sender-denied"
                    ? 0
                    : scenario === "worktree" || gcDuringPreparation
                      ? 2
                      : 1,
                );
                if (scenario === "sender-denied") {
                  const failures = displayed
                    .flatMap((row) => row.content ?? [])
                    .map(asOptionalRecord)
                    .filter((block) => block?.type === "attachment_error");
                  expect(failures).toHaveLength(3);
                  expect(
                    await listManagedImageRecordEntries({ sessionKey: scope.sessionKey }),
                  ).toEqual([]);
                }
                if (scenario === "worktree") {
                  const blocks = displayed.flatMap((row) => row.content ?? []);
                  expect(blocks).toContainEqual({
                    type: "attachment_error",
                    attachment: {
                      code: "delivery-failed",
                      kind: "image",
                      label: "private.png",
                      mimeType: "image/png",
                    },
                  });
                  expect(displayedMedia).toEqual([
                    expect.objectContaining({
                      type: "image",
                      url: expect.stringContaining("/api/chat/media/outgoing/"),
                    }),
                    expect.objectContaining({
                      type: "image",
                      url: expect.stringContaining("/api/chat/media/outgoing/"),
                    }),
                  ]);
                  expect(await fs.readFile(absoluteImage)).toEqual(PNG_BYTES);
                }
                if (scenario === "top-level") {
                  expect(displayed).toContainEqual(
                    expect.objectContaining({
                      openclawStreamFallback: expect.objectContaining({ itemId: "progress-row" }),
                    }),
                  );
                  const text = displayed
                    .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
                    .map(asOptionalRecord)
                    .filter((block) => block?.type === "text")
                    .map((block) => block?.text);
                  expect(text).toEqual(["Before", "After"]);
                  expect(persisted.phase).toBe("commentary");
                }
                if (scenario === "image") {
                  expect(displayed).toContainEqual(
                    expect.objectContaining({
                      openclawStreamFallback: expect.objectContaining({
                        itemId: "progress-image",
                      }),
                      content: [
                        { type: "text", text: "Before" },
                        expect.objectContaining({
                          type: "image",
                          mimeType: "image/png",
                          url: expect.stringContaining("/api/chat/media/outgoing/"),
                        }),
                        { type: "text", text: "After" },
                      ],
                    }),
                  );
                }
                if (scenario === "document") {
                  expect(displayed).toContainEqual(
                    expect.objectContaining({
                      content: expect.arrayContaining([
                        expect.objectContaining({
                          type: "attachment",
                          attachment: expect.objectContaining({
                            kind: "document",
                            mimeType: "application/pdf",
                          }),
                        }),
                      ]),
                    }),
                  );
                }
                if (scenario === "hook") {
                  expect(JSON.stringify(displayed)).toContain('"type":"image"');
                  expect(fetchedUrls).toEqual([mediaUrl]);
                }
                if (mixed) {
                  const replies = createReplyDispatcher(dispatch.dispatcherOptions);
                  replies.sendFinalReply(
                    setReplyPayloadMetadata(
                      { text: finalText, ...(finalMediaUrl ? { mediaUrls: [finalMediaUrl] } : {}) },
                      {
                        assistantMessageIndex: 1,
                        ...(finalMediaUrl ? { assistantTranscriptMediaUrls: [finalMediaUrl] } : {}),
                      },
                    ),
                  );
                  replies.markComplete();
                  await replies.waitForIdle();
                  expect(dispatch.deliveredReplies).toHaveLength(1);
                } else {
                  expect(dispatch.deliveredReplies).toEqual([]);
                }
                expect(
                  loadTranscriptEventsSync(scope).filter(
                    (event) => asOptionalRecord(event)?.type === "message",
                  ),
                ).toHaveLength(scenario === "unrelated-rewrite" ? 2 : 1);
              } finally {
                if (scenario !== "completion") {
                  imageResponse.resolve();
                }
                cleanupStarted = true;
                await transcriptLifecycle.beginCleanup();
                admittedActive = false;
                await transcriptLifecycle.dispose();
                cleanupSettled = true;
              }
            }),
          ),
        );
        void run.catch(() => {});
        if (scenario === "completion") {
          await vi.waitFor(() => expect(cleanupStarted).toBe(true));
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(cleanupSettled).toBe(false);
          imageResponse.resolve();
        }
        if (scenario === "aborted") {
          await vi.waitFor(() => {
            expect(abortedResponseClosed).toBe(true);
          });
        }
        await run;
        if (gcDuringPreparation) {
          // Committed originals must outlive transient retention even after the run ends.
          expect(
            await cleanupManagedOutgoingMediaRecords({
              nowMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
            }),
          ).toEqual({
            deletedRecordCount: 0,
            deletedFileCount: 0,
            retainedCount: 2,
          });
          const entries = await listManagedImageRecordEntries({ sessionKey: scope.sessionKey });
          expect(entries).toHaveLength(2);
          for (const { record } of entries) {
            expect(record).toMatchObject({ messageId: "progress-row", retentionClass: "history" });
            expect(
              await fs.readFile(
                path.join(
                  record.original.mediaRoot,
                  record.original.mediaSubdir,
                  record.original.mediaId,
                ),
              ),
            ).toEqual(PNG_BYTES);
          }
        }
        if (scenario === "aborted") {
          expect(cleanupSettled).toBe(true);
        }
        if (mixed) {
          expect(readMessage()).toMatchObject({ content: expectedContent });
          expect(
            loadTranscriptEventsSync(scope).filter(
              (event) => asOptionalRecord(event)?.type === "message",
            ),
          ).toHaveLength(1);
          const finalContent = readDisplayed()
            .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
            .map(asOptionalRecord);
          expect(finalContent.filter((block) => block?.type === "image")).toHaveLength(
            finalMediaUrl ? 2 : 1,
          );
          expect(
            finalContent.filter((block) => block?.type === "text").map((block) => block?.text),
          ).toEqual(["Before", "After", finalText]);
          expect(fetchedUrls).toEqual(authoredUrls);
        }
        if (scenario === "completion") {
          expect(cleanupSettled).toBe(true);
          expect(readMessage()).toHaveProperty("openclawDisplayContent");
          expect(readMessage()).toMatchObject({
            content: expectedContent,
            stopReason: "toolUse",
          });
        }
        if (scenario === "unrelated-rewrite") {
          expect(readEvent("unrelated-row").message).toMatchObject({
            content: [{ type: "text", text: "Rewritten while loading" }],
          });
        }
        if (scenario === "revoked" || scenario === "aborted" || scenario === "target-rewrite") {
          expect(readMessage()).not.toHaveProperty("openclawDisplayContent");
          expect(await fs.readdir(state.statePath("media", "outgoing", "originals"))).toEqual([]);
          expect(await listManagedImageRecordEntries({ sessionKey: scope.sessionKey })).toEqual([]);
          if (scenario === "target-rewrite") {
            expect(readMessage().content).toEqual([
              { type: "text", text: "Rewritten while loading" },
            ]);
          }
        }
        if (publicationSpy) {
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("Synthetic commentary publication failure"),
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        imageResponse.resolve();
        if (scenario === "aborted") {
          upstream.closeAllConnections();
        }
        await run?.catch(() => {});
        stopUpdates();
        await new Promise<void>((resolve) => {
          upstream.close(() => resolve());
        });
        remoteFixtures.clear();
        hookSpy?.mockRestore();
        publicationSpy?.mockRestore();
        rewriteSpy?.mockRestore();
      }
    });
  });
});
