import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  replaceSessionEntry,
  rewriteTranscriptMessageAtAnchor,
} from "../../config/sessions/session-accessor.js";
import * as sessionEntryReadFacts from "../../config/sessions/session-entry-read-facts.js";
import * as messageRewrite from "../../config/sessions/session-message-rewrite.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as mediaFetch from "../../media/fetch.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../../media/store-network.test-support.js";
import * as hookRunnerGlobal from "../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  attachSessionTranscriptRunId,
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { cleanupManagedOutgoingMediaRecords } from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import { projectTranscriptEntryMessage } from "../session-transcript-entry-message.js";
import { createReplyDispatch } from "./chat-send-reply-dispatch.test-support.js";
import * as chatTranscriptPersistence from "./chat-transcript-persistence.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const MEDIA_URL = "https://media.example.test/11111111-1111-4111-8111-111111111111";
const remoteFixtures = new Map<string, string>();
const fetchedUrls: string[] = [];
const textBlock = (text: string) => ({ type: "text" as const, text });
const outgoingImage = (extra: Record<string, unknown> = {}) =>
  expect.objectContaining({
    type: "image",
    url: expect.stringContaining("/api/chat/media/outgoing/"),
    ...extra,
  });
const displayBlocks = (messages: ReturnType<typeof projectChatDisplayMessages>) =>
  messages.flatMap((row) => (Array.isArray(row.content) ? row.content : [])).map(asOptionalRecord);
const signedText = (text: string, id: string, phase: string) => ({
  ...textBlock(text),
  textSignature: JSON.stringify({ v: 1, id, phase }),
});

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

it.for([
  "image",
  "cache-miss",
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
  "gc-with-unknown-commit",
] as const)("materializes authored progress media with %s semantics", async (scenario, test) => {
  const fixture = createFixtureLifetime();
  test.onTestFinished(() => fixture.cleanup());
  const body = withOpenClawTestState({ label: "commentary-media" }, async (state) => {
    test.signal.throwIfAborted();
    fetchedUrls.length = 0;
    let requestCount = 0;
    const requestsStarted = createDeferred();
    const abortedResponseClosed = createDeferred<boolean>();
    const abortController = new AbortController();
    const imageResponse = createDeferred();
    const gcDuringPreparation = scenario.startsWith("gc-");
    const revoked = scenario === "revoked";
    const aborted = scenario === "aborted";
    const targetRewrite = scenario === "target-rewrite";
    const wait = <T>(promise: Promise<T>) => racePromiseWithAbortSignal(promise, test.signal);
    const upstream = http.createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === mediaUrls.length) {
        requestsStarted.resolve();
      }
      const send = () => {
        response.writeHead(200, {
          "content-type": scenario === "document" ? "application/pdf" : "image/png",
        });
        response.end(scenario === "document" ? Buffer.from("%PDF-1.7\nfixture\n%%EOF") : PNG_BYTES);
      };
      if ((revoked || aborted || gcDuringPreparation) && requestCount === 1) {
        send();
      } else if (aborted) {
        response.writeHead(200, { "content-type": "image/png" });
        response.write(PNG_BYTES.subarray(0, 16));
        response.on("close", () => {
          abortedResponseClosed.resolve(!response.writableFinished);
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
      : revoked || aborted || gcDuringPreparation
        ? [mediaUrl, `${mediaUrl}/second`]
        : [mediaUrl];
    const mixed = scenario === "mixed-text" || scenario === "mixed-media";
    const finalMediaUrl = scenario === "mixed-media" ? `${mediaUrl}/final` : undefined;
    const authoredUrls = [...mediaUrls, ...(finalMediaUrl ? [finalMediaUrl] : [])];
    const finalText = "Final result";
    for (const url of authoredUrls) {
      remoteFixtures.set(url, fixtureUrl);
    }
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
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
    };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionId: "commentary-session",
      sessionKey: "agent:main:commentary",
      storePath: (await loadSessionEntryAsync("agent:main:commentary", { agentId: "main" }))
        .storePath,
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "initial",
      updatedAt: 1,
      ...(localMedia
        ? { spawnedCwd: worktree, spawnedBy: "agent:main:main", sessionRoot: worktree }
        : {}),
    });
    const readManaged = () => listManagedImageRecordEntries({ sessionKey: scope.sessionKey });
    // Prepare the shared media store before the download-sequencing checks.
    expect(await readManaged()).toEqual([]);
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
    const cleanupStarted = createDeferred();
    let cleanupSettled = false;
    const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
      runId,
      sessionId: scope.sessionId,
    });
    const transcriptContext = {
      sessionTarget: scope,
      assertCommitAllowed: () => {
        if (!admittedActive) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      },
      withTranscriptWrite: transcriptLifecycle.withTranscriptWrite.bind(transcriptLifecycle),
    };
    const dispatch = createReplyDispatch(runId, {
      requesterContext: { SenderId: "cli" },
      isRunCurrent: () => current,
      abortSignal: AbortSignal.any([abortController.signal, test.signal]),
      logGateway: { warn } as never,
      session: {
        ...scope,
        backingSessionId: scope.sessionId,
        cfg,
        clientRunId: runId,
        sessionLoadOptions: { agentId: "main" },
      },
    });
    const progressText = `Before\n${mediaUrls.map((url) => `MEDIA:${url}`).join("\n")}\nAfter`;
    const content = [
      scenario === "top-level"
        ? textBlock(progressText)
        : signedText(progressText, "progress-image", "commentary"),
      {
        type: "toolCall" as const,
        id: "inspect-next",
        name: "read",
        arguments: { path: "next.ts" },
      },
      ...(mixed
        ? [
            signedText(
              finalMediaUrl ? `${finalText}\nMEDIA:${finalMediaUrl}` : finalText,
              "final-result",
              "final_answer",
            ),
          ]
        : []),
    ];
    const hookSpy =
      scenario === "hook"
        ? vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(
            createHookRunnerWithRegistry([
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
            ]).runner,
          )
        : undefined;
    const readMessages = () =>
      loadTranscriptEventsSync(scope)
        .map(asOptionalRecord)
        .filter((entry) => entry?.type === "message");
    const readEvent = (messageId = "progress-row") => {
      return expectDefined(
        readMessages().find((entry) => entry?.id === messageId),
        "persisted commentary row",
      );
    };
    const readMessage = () =>
      expectDefined(asOptionalRecord(readEvent().message), "assistant message");
    const readDisplayed = () => {
      const anchor = expectDefined(
        readActiveTranscriptEntryAnchor({ ...scope, entryId: "progress-row" }),
        "committed transcript anchor",
      );
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
    const expectMaterialized = () => {
      expect(readMessage()).toHaveProperty("openclawDisplayContent");
      expect(readMessage()).toMatchObject({ content: expectedContent, stopReason: "toolUse" });
    };
    const rewrite = messageRewrite.rewritePreparedTranscriptMessageAtAnchor;
    const rewriteSpy =
      scenario === "gc-with-revocation-after-commit" || scenario === "gc-with-unknown-commit"
        ? vi
            .spyOn(messageRewrite, "rewritePreparedTranscriptMessageAtAnchor")
            .mockImplementation(async (...args) => {
              const result = await rewrite(...args);
              if (scenario === "gc-with-unknown-commit") {
                throw new SqliteWorkerError(
                  "Synthetic uncertain commentary rewrite",
                  "outcome-unknown",
                );
              }
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
    const retainedFactsSpy =
      scenario === "cache-miss"
        ? vi
            .spyOn(sessionEntryReadFacts, "readRetainedSessionEntryFacts")
            .mockReturnValue(undefined)
        : undefined;
    const publishCommentary = async () => {
      try {
        dispatch.captureAgentTranscriptStart();
        const message = runAgentHarnessBeforeMessageWriteHook({
          message: attachSessionTranscriptRunId(
            {
              ...buildAssistantMessage({
                model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
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
        const appended = appendTranscriptMessageSync(scope, { eventId: "progress-row", message });
        expect(appended).toMatchObject({ ok: true });
        await publishTranscriptUpdate(scope, { message, messageId: "progress-row", runId });
        if (scenario === "cache-miss") {
          return;
        }
        if (!localMedia) {
          await wait(Promise.race([requestsStarted.promise, commentarySettled.promise]));
        }
        expect(warn).not.toHaveBeenCalled();
        expect(requestCount).toBe(localMedia ? 0 : mediaUrls.length);
        if (scenario === "completion") {
          return;
        }
        if (gcDuringPreparation) {
          // The second download holds the rewrite while the first original is on disk.
          expect(readMessage()).not.toHaveProperty("openclawDisplayContent");
          const preparedEntries = await readManaged();
          expect(preparedEntries).toHaveLength(1);
          await cleanupManagedOutgoingMediaRecords();
          expect(await readManaged()).toEqual(preparedEntries);
          for (const { record } of preparedEntries) {
            const { mediaRoot, mediaSubdir, mediaId } = record.original;
            expect(await fs.readFile(path.join(mediaRoot, mediaSubdir, mediaId))).toEqual(
              PNG_BYTES,
            );
          }
        }
        if (aborted) {
          current = false;
          abortController.abort();
          return;
        }
        if (revoked) {
          current = false;
        }
        if (scenario === "unrelated-rewrite" || targetRewrite) {
          const messageId = scenario === "unrelated-rewrite" ? "unrelated-row" : "progress-row";
          const anchor = expectDefined(
            readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId }),
            "rewrite target",
          );
          const rewritten = await rewriteTranscriptMessageAtAnchor(anchor, (value) => {
            const targetMessage = expectDefined(asOptionalRecord(value), "rewrite message");
            return {
              ...targetMessage,
              content: [textBlock("Rewritten while loading")],
            };
          });
          expect(rewritten).not.toBeNull();
          expect(rewritten?.generation).not.toBe(anchor.generation);
        }
        imageResponse.resolve();
        if (revoked || targetRewrite || rewriteSpy) {
          return;
        }
        await wait(commentarySettled.promise);
        expectMaterialized();
        if (!publicationSpy) {
          expect(rewriteUpdate).toMatchObject({
            messageId: "progress-row",
            target: expect.objectContaining({ sessionId: scope.sessionId }),
          });
          expect(rewriteUpdate).not.toHaveProperty("message");
        }
        const displayed = readDisplayed();
        const blocks = displayBlocks(displayed);
        const displayedMedia = blocks.filter(
          (block) => block?.type === "image" || block?.type === "attachment",
        );
        expect(displayedMedia).toHaveLength(
          scenario === "sender-denied" ? 0 : scenario === "worktree" || gcDuringPreparation ? 2 : 1,
        );
        if (scenario === "sender-denied") {
          const failures = blocks.filter((block) => block?.type === "attachment_error");
          expect(failures).toHaveLength(3);
          expect(await readManaged()).toEqual([]);
        }
        if (scenario === "worktree") {
          expect(blocks).toContainEqual({
            type: "attachment_error",
            attachment: {
              code: "delivery-failed",
              kind: "image",
              label: "private.png",
              mimeType: "image/png",
            },
          });
          expect(displayedMedia).toEqual([outgoingImage(), outgoingImage()]);
          expect(await fs.readFile(absoluteImage)).toEqual(PNG_BYTES);
        }
        if (scenario === "top-level") {
          expect(displayed).toContainEqual(
            expect.objectContaining({
              openclawStreamFallback: expect.objectContaining({ itemId: "progress-row" }),
            }),
          );
          const text = blocks.filter((block) => block?.type === "text").map((block) => block?.text);
          expect(text).toEqual(["Before", "After"]);
          expect(readMessage().phase).toBe("commentary");
        }
        if (scenario === "image") {
          expect(displayed).toContainEqual(
            expect.objectContaining({
              openclawStreamFallback: expect.objectContaining({ itemId: "progress-image" }),
              content: [
                textBlock("Before"),
                outgoingImage({ mimeType: "image/png" }),
                textBlock("After"),
              ],
            }),
          );
        }
        if (scenario === "document") {
          expect(displayedMedia).toContainEqual(
            expect.objectContaining({
              type: "attachment",
              attachment: expect.objectContaining({
                kind: "document",
                mimeType: "application/pdf",
              }),
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
        expect(readMessages()).toHaveLength(scenario === "unrelated-rewrite" ? 2 : 1);
      } finally {
        if (scenario !== "completion") {
          imageResponse.resolve();
        }
        cleanupStarted.resolve();
        await transcriptLifecycle.beginCleanup();
        admittedActive = false;
        await transcriptLifecycle.dispose();
        cleanupSettled = true;
      }
    };
    try {
      run = withStoreRemoteFixture({ url: fixtureUrl }, () =>
        dispatch.runAgentMediaTranscript({ run: async (operation) => operation() }, () =>
          withOwnedSessionTranscriptWrites(transcriptContext, publishCommentary),
        ),
      );
      void run.catch(() => {});
      if (scenario === "completion") {
        await wait(Promise.race([cleanupStarted.promise, run]));
        await nextTurn();
        expect(cleanupSettled).toBe(false);
        imageResponse.resolve();
      }
      await run;
      if (gcDuringPreparation) {
        // Committed originals must outlive transient retention even after the run ends.
        await cleanupManagedOutgoingMediaRecords({
          nowMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        const entries = await readManaged();
        expect(entries).toHaveLength(2);
        for (const { record } of entries) {
          expect(record).toMatchObject({ messageId: "progress-row", retentionClass: "history" });
          const { mediaRoot, mediaSubdir, mediaId } = record.original;
          expect(await fs.readFile(path.join(mediaRoot, mediaSubdir, mediaId))).toEqual(PNG_BYTES);
        }
      }
      if (aborted) {
        expect(await wait(abortedResponseClosed.promise)).toBe(true);
        expect(cleanupSettled).toBe(true);
      }
      if (mixed) {
        expect(readMessage()).toMatchObject({ content: expectedContent });
        expect(readMessages()).toHaveLength(1);
        const finalContent = displayBlocks(readDisplayed());
        expect(finalContent.filter((block) => block?.type === "image")).toHaveLength(
          finalMediaUrl ? 2 : 1,
        );
        expect(
          finalContent.filter((block) => block?.type === "text").map((block) => block?.text),
        ).toEqual(["Before", "After", finalText]);
        expect(fetchedUrls).toEqual(authoredUrls);
      }
      if (scenario === "completion" || scenario === "cache-miss") {
        expect(cleanupSettled).toBe(true);
        expectMaterialized();
        expect(requestCount).toBe(1);
        expect(readDisplayed().flatMap((row) => row.content ?? [])).toContainEqual(
          expect.objectContaining({ type: "image" }),
        );
      }
      if (scenario === "unrelated-rewrite") {
        expect(readEvent("unrelated-row").message).toMatchObject({
          content: [textBlock("Rewritten while loading")],
        });
      }
      if (revoked || aborted || targetRewrite) {
        expect(readMessage()).not.toHaveProperty("openclawDisplayContent");
        expect(await fs.readdir(state.statePath("media", "outgoing", "originals"))).toEqual([]);
        expect(await readManaged()).toEqual([]);
        if (targetRewrite) {
          expect(readMessage().content).toEqual([textBlock("Rewritten while loading")]);
        }
      }
      if (scenario === "gc-with-unknown-commit") {
        expect(rewriteUpdate).toBeUndefined();
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Synthetic uncertain commentary rewrite"),
        );
      } else if (publicationSpy) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Synthetic commentary publication failure"),
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    } finally {
      imageResponse.resolve();
      if (aborted || test.signal.aborted) {
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
      retainedFactsSpy?.mockRestore();
      await drainGlobalSingletonLifecycleState();
    }
  });
  await fixture.track(body);
});
