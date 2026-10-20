import fs from "node:fs/promises";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { persistInternalSourceReply } from "../gateway/internal-source-reply-persistence.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { publishHeartbeatSessionReply } from "./heartbeat-session-publication.js";

type PublicationParams = Parameters<typeof publishHeartbeatSessionReply>[0];
type StoredMessage = Parameters<
  typeof persistSessionTranscriptTurn
>[1]["messages"][number]["message"];

async function createTarget(state: OpenClawTestState) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:webchat:direct:publication",
    sessionId: "original-session",
    storePath: path.join(state.sessionsDir("main"), "sessions.json"),
  };
  const cfg = { session: { store: scope.storePath } };
  setRuntimeConfigSnapshot(cfg);
  const entry = {
    sessionId: scope.sessionId,
    lifecycleRevision: "original-generation",
    activeWriterRunId: "original-writer",
    updatedAt: 1,
  };
  await replaceSessionEntry(scope, entry);
  const params: PublicationParams = {
    ...scope,
    cfg,
    expectedGeneration: { sessionId: scope.sessionId, lifecycleRevision: entry.lifecycleRevision },
    occurrenceIds: ["occurrence-b", "occurrence-a"],
    payload: createHeartbeatToolResponsePayload({
      outcome: "done",
      notify: true,
      summary: "Private diagnostic summary",
      notificationText: "The command finished.",
    }),
  };
  const subscriptions: Array<() => void> = [];
  return {
    params,
    scope,
    entry,
    workspaceDir: state.workspaceDir,
    events: () => loadTranscriptEvents(scope),
    persist: (message: StoredMessage, fenced = true) =>
      persistSessionTranscriptTurn(scope, {
        expectedSessionId: scope.sessionId,
        ...(fenced
          ? { expectedLifecycleRevision: params.expectedGeneration.lifecycleRevision }
          : {}),
        messages: [{ message }],
        updateMode: "none",
      }),
    readMessages: async () => (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage),
    publish: (overrides: Partial<PublicationParams> = {}) =>
      publishHeartbeatSessionReply({ ...params, ...overrides }),
    watch: () => {
      const updates: Array<{ messageId?: string }> = [];
      subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));
      return updates;
    },
    cleanup: () => subscriptions.forEach((unsubscribe) => unsubscribe()),
  };
}

async function withTarget(
  run: (target: Awaited<ReturnType<typeof createTarget>>) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "heartbeat-publication-" },
    async (state) => {
      const target = await createTarget(state);
      try {
        await run(target);
      } finally {
        target.cleanup();
      }
    },
  );
}

describe("publishHeartbeatSessionReply", () => {
  it("publishes through worker reads and observes a later committed reset", async () => {
    await withTarget(async ({ scope, entry, publish }) => {
      const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
      const reads: string[] = [];
      const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
        const original = prototype[method];
        return vi.spyOn(prototype, method).mockImplementation(
          new Proxy(original, {
            apply(read, receiver: StatementSync, args) {
              if (/\b(?:session_nodes|session_windows)\b/iu.test(receiver.sourceSQL)) {
                reads.push(receiver.sourceSQL);
              }
              return Reflect.apply(read, receiver, args);
            },
          }),
        );
      });
      try {
        expect(await publish()).toMatchObject({ ok: true });
        expect(reads).toEqual([]);
        await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "reset-generation" });
        reads.length = 0;
        expect(await publish({ occurrenceIds: ["after-reset"] })).toMatchObject({ ok: false });
        expect(reads).toEqual([]);
      } finally {
        observers.forEach((observer) => observer.mockRestore());
      }
    });
  });

  it.each(["abort", "authority"] as const)(
    "accepts the committed occurrence before queued %s and publishes a later occurrence once",
    async (change) => {
      await withTarget(async ({ params, scope, publish, readMessages }) => {
        const controller = new AbortController();
        let ownerActive = true;
        let cancellationQueued = false;
        const updates: InternalSessionTranscriptUpdate[] = [];
        const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
          updates.push(update);
          if (update.messageId && !cancellationQueued) {
            cancellationQueued = true;
            // Queue cancellation from the real committed publication, after worker settlement.
            queueMicrotask(() => {
              if (change === "abort") {
                controller.abort();
              } else {
                ownerActive = false;
              }
            });
          }
        });
        try {
          const first = await withOwnedSessionTranscriptWrites(
            {
              sessionFile: scope.sessionKey,
              sessionKey: scope.sessionKey,
              sessionTarget: scope,
              assertCommitAllowed: () => {
                if (!ownerActive) {
                  throw new Error("commit owner released");
                }
              },
              withTranscriptWrite: async (run) => await run(),
            },
            () =>
              publish({
                occurrenceIds: ["occurrence-a"],
                signal: controller.signal,
              }),
          );
          expect(cancellationQueued).toBe(true);
          expect(first).toMatchObject({ ok: true });
          const second = await publish({
            occurrenceIds: ["occurrence-b"],
            payload: { text: "The later command finished." },
          });
          expect(second).toMatchObject({ ok: true });
          expect(second).not.toEqual(first);
          expect(await publish({ occurrenceIds: ["occurrence-a"] })).toEqual(first);
          expect(
            (await readMessages()).filter((message) => message?.role === "assistant"),
          ).toHaveLength(2);
          expect(updates.filter((update) => update.messageId)).toHaveLength(2);
          expect(
            updates.filter((update) => update.messageId).map((update) => update.lifecycleRevision),
          ).toEqual([
            params.expectedGeneration.lifecycleRevision,
            params.expectedGeneration.lifecycleRevision,
          ]);
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it("commits model-visible notification under its still-active admission and replays once", async () => {
    await withTarget(async ({ params, scope, publish, readMessages, watch }) => {
      const admission = await beginSessionEffect({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const updates = watch();
      try {
        const first = await admission.run(() => publish());
        expect(first.ok).toBe(true);
        expect(admission.isActive()).toBe(true);
        const retry = await publish({
          occurrenceIds: params.occurrenceIds.toReversed(),
        });
        expect(retry).toEqual(first);
        const messages = (await readMessages()).filter((message) => message?.role === "assistant");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content).toEqual([{ type: "text", text: "The command finished." }]);
        expect(isTranscriptOnlyOpenClawAssistantMessage(messages[0])).toBe(false);
        expect(updates.filter((update) => update.messageId)).toHaveLength(1);
        expect(await publish({ payload: { text: "Conflicting notification" } })).toMatchObject({
          ok: false,
        });
        expect((await readMessages()).filter((message) => message?.role === "assistant")).toEqual(
          messages,
        );
        const next = await publish({
          occurrenceIds: ["new-occurrence"],
        });
        expect(next.ok).toBe(true);
        expect(next).not.toEqual(first);
      } finally {
        admission.release();
      }
    });
  });

  it.each(["key", "index"] as const)(
    "reconciles an actual runtime %s receipt without duplicating its row",
    async (identity) => {
      await withTarget(async ({ params, events, publish, persist }) => {
        const original = await persist({
          role: "assistant",
          content: [{ type: "text", text: params.payload.text }],
          idempotencyKey: "runtime-final",
          __openclaw: { runId: "original-writer" },
        });
        const before = await events();
        const payload = setReplyPayloadMetadata(
          { text: params.payload.text },
          {
            assistantTranscriptOwned: true,
            ...(identity === "key" ? { assistantTranscriptIdempotencyKey: "runtime-final" } : {}),
            // Stream block transitions advance this coordinate without appending a row.
            ...(identity === "index" ? { assistantMessageIndex: 7 } : {}),
          },
        );
        expect(await publish({ payload })).toEqual({
          ok: true,
          messageId: original.messages[0]?.messageId,
        });
        expect(await events()).toEqual(before);
      });
    },
  );

  it.each([
    ["captioned image", "Attached image", "Attached image", "/tmp/reply-image.png"],
    ["media-only image", "", undefined, "/tmp/reply-image.png"],
    ["silent voice", "NO_REPLY", undefined, "/tmp/voice.opus"],
    ["literal suffix voice", "NO_REPLY\nNO_REPLY", "NO_REPLY", "/tmp/voice.opus"],
    ["punctuated caption voice", "NO_REPLY.", "NO_REPLY.", "/tmp/voice.opus"],
  ] as const)(
    "reconciles a producer-derived %s receipt without rewriting it",
    async (_name, caption, expectedCaption, source) => {
      await withTarget(async ({ scope, events, publish, watch, persist }) => {
        const assistant = {
          ...makeAgentAssistantMessage({
            model: "receipt-fixture",
            timestamp: 1,
            content: [
              {
                type: "text" as const,
                text: `${caption}\nMEDIA:${source}`,
                textSignature: JSON.stringify({ v: 1, id: "media-final", phase: "final_answer" }),
              },
            ],
          }),
          idempotencyKey: "runtime-media-final",
          __openclaw: { runId: "original-writer" },
        };
        const original = await persist(assistant);
        const payloads = buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: assistant,
          currentAssistant: assistant,
          sessionKey: scope.sessionKey,
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: "runtime-media-final",
        });
        expect(payloads).toHaveLength(1);
        const payload = payloads[0]!;
        expect(payload.text).toBe(expectedCaption);
        expect(payload.mediaUrls).toEqual([source]);
        const before = await events();
        const updates = watch();
        for (let replay = 0; replay < 2; replay++) {
          expect(await publish({ payload })).toEqual({
            ok: true,
            messageId: original.messages[0]?.messageId,
          });
          expect(await events()).toEqual(before);
        }
        expect(updates).toHaveLength(2);
        expect(updates.every((update) => update.messageId === undefined)).toBe(true);
        for (const mismatch of [
          { text: "A different caption", sources: [source], media: [source] },
          {
            text: payload.text,
            sources: [source + "?different=1"],
            media: [source + "?different=1"],
          },
          {
            text: payload.text,
            sources: ["/elsewhere/" + path.basename(source)],
            media: ["/elsewhere/" + path.basename(source)],
          },
          { text: payload.text, sources: [source], media: [source, "/tmp/tool-only-image.png"] },
        ]) {
          const conflicting = setReplyPayloadMetadata(
            { text: mismatch.text, mediaUrls: mismatch.media },
            {
              assistantTranscriptOwned: true,
              assistantTranscriptIdempotencyKey: "runtime-media-final",
              assistantTranscriptMediaUrls: mismatch.sources,
            },
          );
          expect(await publish({ payload: conflicting })).toMatchObject({ ok: false });
          expect(await events()).toEqual(before);
        }
        expect(updates).toHaveLength(2);
      });
    },
  );

  it("rejects ownership metadata without a current committed final", async () => {
    await withTarget(async ({ params, events, publish, persist }) => {
      await persist(
        {
          role: "assistant",
          content: [{ type: "text", text: params.payload.text }],
          idempotencyKey: "earlier-final",
          __openclaw: { runId: "earlier-writer" },
        },
        false,
      );
      const before = await events();
      for (const metadata of [
        { assistantTranscriptOwned: true },
        { assistantMessageIndex: 1 },
        { assistantTranscriptOwned: true, assistantTranscriptIdempotencyKey: "missing-final" },
        { assistantTranscriptOwned: true, assistantTranscriptIdempotencyKey: "earlier-final" },
      ]) {
        const payload = setReplyPayloadMetadata({ text: params.payload.text }, metadata);
        expect(await publish({ payload })).toMatchObject({
          ok: false,
        });
      }
      expect(await events()).toEqual(before);
    });
  });

  it.each(["Managed source caption", ""])(
    "reconciles an actual source-mirror media receipt with caption %j",
    async (caption) => {
      await withTarget(async ({ params, scope, events, workspaceDir, publish, watch }) => {
        await fs.mkdir(workspaceDir, { recursive: true });
        const source = path.join(workspaceDir, "source-mirror.png");
        await fs.writeFile(
          source,
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        params.cfg = { ...params.cfg, agents: { defaults: { workspace: workspaceDir } } };
        const sourcePayload = {
          text: caption,
          mediaUrls: [source],
          idempotencyKey: "source-media-final",
          transcriptOwner: true as const,
        };
        await persistInternalSourceReply({
          cfg: params.cfg,
          sessionKey: scope.sessionKey,
          expectedSessionId: scope.sessionId,
          agentId: scope.agentId,
          payload: sourcePayload,
          idempotencyKey: sourcePayload.idempotencyKey,
          runId: "original-writer",
          sourceReplyFinal: true,
        });
        const before = await events();
        expect(
          before.map(readTranscriptEventMessage).find((message) => message?.role === "assistant"),
        ).toMatchObject({ openclawDelivery: { mediaUrls: [source] } });
        const payloads = buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: undefined,
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          sourceReplyDeliveryMode: "message_tool_only",
          messagingToolSourceReplyPayloads: [sourcePayload],
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: "unrelated-ordinary-final",
        });
        expect(payloads).toHaveLength(1);
        const payload = expectDefined(payloads[0], "source producer payload");
        const updates = watch();
        const metadata = getReplyPayloadMetadata(payload);
        const mirror = expectDefined(
          metadata?.sourceReplyTranscriptMirror,
          "source mirror identity",
        );
        for (const change of [
          { sessionKey: "agent:main:foreign-target" },
          { expectedSessionId: "replacement-session" },
          { agentId: "foreign-agent" },
          { mediaUrls: [path.join(workspaceDir, "different-source.png")] },
          { text: `${caption} changed` },
        ]) {
          const wrong = setReplyPayloadMetadata(
            { ...payload },
            {
              ...metadata,
              sourceReplyTranscriptMirror: { ...mirror, ...change },
            },
          );
          expect(await publish({ payload: wrong })).toMatchObject({ ok: false });
          expect(await events()).toEqual(before);
        }
        expect(updates).toEqual([]);
        for (let replay = 0; replay < 2; replay++) {
          expect(await publish({ payload })).toMatchObject({
            ok: true,
          });
          expect(await events()).toEqual(before);
        }
        expect(updates).toHaveLength(2);
        expect(updates.every((update) => update.messageId === undefined)).toBe(true);
      });
    },
  );

  it.each(["abort", "authority", "session", "revision", "writer", "archive"] as const)(
    "rejects %s after asynchronous preparation without a transcript write",
    async (change) => {
      await withTarget(async ({ scope, entry, publish, readMessages }) => {
        const entered = createDeferred();
        const release = createDeferred();
        const controller = new AbortController();
        let ownerActive = true;
        const publication = withOwnedSessionTranscriptWrites(
          {
            sessionFile: scope.sessionKey,
            sessionKey: scope.sessionKey,
            sessionTarget: scope,
            assertCommitAllowed: () => {
              if (!ownerActive) {
                throw new Error("publication owner released");
              }
            },
            withTranscriptWrite: async (run) => {
              entered.resolve();
              await release.promise;
              return await run();
            },
          },
          () => publish({ signal: controller.signal }),
        );
        try {
          await Promise.race([
            entered.promise,
            publication.then(() => {
              throw new Error("publication never entered its owned write");
            }),
          ]);
          if (change === "abort") {
            controller.abort(new Error("cancelled publication"));
          } else if (change === "authority") {
            ownerActive = false;
          } else {
            await replaceSessionEntry(scope, {
              ...entry,
              ...(change === "session" ? { sessionId: "replacement-session" } : {}),
              ...(change === "revision" ? { lifecycleRevision: "replacement-generation" } : {}),
              ...(change === "writer" ? { activeWriterRunId: "replacement-writer" } : {}),
              ...(change === "archive" ? { archivedAt: 123 } : {}),
            });
          }
          release.resolve();
          expect(await publication).toMatchObject({ ok: false });
          expect((await readMessages()).filter(Boolean)).toEqual([]);
        } finally {
          release.resolve();
          await publication;
        }
      });
    },
  );

  it("fences a revision-less generation when a revision is materialized", async () => {
    await withTarget(async ({ params, scope, entry, publish, readMessages }) => {
      // Pin the absent revision before another owner materializes it.
      await replaceSessionEntry(scope, { ...entry, lifecycleRevision: undefined });
      params.expectedGeneration.lifecycleRevision = undefined;
      await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "materialized" });
      expect(await publish()).toMatchObject({ ok: false });
      expect((await readMessages()).filter(Boolean)).toEqual([]);
    });
  });

  it("does not revive an abandoned completion on replay", async () => {
    await withTarget(async ({ scope, events, publish }) => {
      expect(await publish()).toMatchObject({ ok: true });
      await appendTranscriptMessage(scope, {
        eventId: "replacement-root",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "Replacement branch" }] },
      });
      const before = await events();
      expect(await publish()).toMatchObject({ ok: false });
      expect(await events()).toEqual(before);
    });
  });

  it("retains accepted publication through owned-drain failure without another assistant row", async () => {
    await withTarget(async ({ scope, events, publish, watch }) => {
      const updates = watch();
      const failed = await withOwnedSessionTranscriptWrites(
        {
          sessionFile: scope.sessionKey,
          sessionKey: scope.sessionKey,
          sessionTarget: scope,
          withTranscriptWrite: async (run) => {
            await run();
            throw new Error("owned drain failed after commit");
          },
        },
        () => publish(),
      );
      expect(failed).toMatchObject({ ok: true });
      const before = await events();
      expect(
        before.map(readTranscriptEventMessage).filter((message) => message?.role === "assistant"),
      ).toHaveLength(1);
      expect(updates).toHaveLength(1);
      expect(await publish()).toMatchObject({ ok: true });
      expect(await events()).toEqual(before);
      expect(updates).toHaveLength(2);
      expect(updates[1]?.messageId).toBeUndefined();
    });
  });
});
