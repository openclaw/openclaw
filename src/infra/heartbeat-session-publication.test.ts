import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { persistInternalSourceReply } from "../gateway/internal-source-reply-persistence.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { publishHeartbeatSessionReply } from "./heartbeat-session-publication.js";

type PublicationParams = Parameters<typeof publishHeartbeatSessionReply>[0];

// These cases exercise the new publication boundary, not its helper call shape:
// admission self-wait, false receipts, stale writes, and replay duplication are
// independent of the parent's dispatcher/event-consumption regression.
async function withTarget(
  run: (fixture: {
    params: PublicationParams;
    scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
    entry: {
      sessionId: string;
      lifecycleRevision: string | undefined;
      activeWriterRunId: string;
      updatedAt: number;
    };
    events: () => ReturnType<typeof loadTranscriptEvents>;
    workspaceDir: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "heartbeat-publication-" },
    async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:webchat:direct:publication",
        sessionId: "original-session",
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
      };
      const lifecycleRevision = "original-generation";
      const entry = {
        sessionId: scope.sessionId,
        lifecycleRevision,
        activeWriterRunId: "original-writer",
        updatedAt: 1,
      };
      await replaceSessionEntry(scope, entry);
      const params: PublicationParams = {
        ...scope,
        cfg: { session: { store: scope.storePath } },
        expectedGeneration: { sessionId: scope.sessionId, lifecycleRevision },
        occurrenceIds: ["occurrence-b", "occurrence-a"],
        payload: createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "Private diagnostic summary",
          notificationText: "The command finished.",
        }),
      };
      await run({
        params,
        scope,
        entry,
        events: () => loadTranscriptEvents(scope),
        workspaceDir: state.workspaceDir,
      });
    },
  );
}

describe("publishHeartbeatSessionReply", () => {
  it.each(["abort", "authority"] as const)(
    "accepts the committed occurrence before queued %s and publishes a later occurrence once",
    async (change) => {
      await withTarget(async ({ params, scope, events }) => {
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
        const controller = new AbortController();
        let ownerActive = true;
        let cancellationQueued = false;
        const updates: InternalSessionTranscriptUpdate[] = [];
        const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
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
                if (database.db.isTransaction && !cancellationQueued) {
                  cancellationQueued = true;
                  // Use the real commit guard; do not replace persistence or the emitter.
                  queueMicrotask(() => {
                    if (change === "abort") {
                      controller.abort();
                    } else {
                      ownerActive = false;
                    }
                  });
                }
              },
              withTranscriptWrite: async (run) => await run(),
            },
            () =>
              publishHeartbeatSessionReply({
                ...params,
                occurrenceIds: ["occurrence-a"],
                signal: controller.signal,
              }),
          );
          expect(cancellationQueued).toBe(true);
          expect(first).toMatchObject({ ok: true });
          const second = await publishHeartbeatSessionReply({
            ...params,
            occurrenceIds: ["occurrence-b"],
            payload: { text: "The later command finished." },
          });
          expect(second).toMatchObject({ ok: true });
          expect(second).not.toEqual(first);
          expect(
            await publishHeartbeatSessionReply({
              ...params,
              occurrenceIds: ["occurrence-a"],
            }),
          ).toEqual(first);
          expect(
            (await events())
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant"),
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
    await withTarget(async ({ params, scope, events }) => {
      const admission = await beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const updates: Array<{ messageId?: string }> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
      try {
        const first = await admission.run(() => publishHeartbeatSessionReply(params));
        expect(first.ok).toBe(true);
        expect(admission.isActive()).toBe(true);
        const retry = await publishHeartbeatSessionReply({
          ...params,
          occurrenceIds: params.occurrenceIds.toReversed(),
        });
        expect(retry).toEqual(first);
        const messages = (await events())
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content).toEqual([{ type: "text", text: "The command finished." }]);
        expect(isTranscriptOnlyOpenClawAssistantMessage(messages[0])).toBe(false);
        expect(updates.filter((update) => update.messageId)).toHaveLength(1);
        expect(
          await publishHeartbeatSessionReply({
            ...params,
            payload: { text: "Conflicting notification" },
          }),
        ).toMatchObject({ ok: false });
        expect(
          (await events())
            .map(readTranscriptEventMessage)
            .filter((message) => message?.role === "assistant"),
        ).toEqual(messages);
        const next = await publishHeartbeatSessionReply({
          ...params,
          occurrenceIds: ["new-occurrence"],
        });
        expect(next.ok).toBe(true);
        expect(next).not.toEqual(first);
      } finally {
        unsubscribe();
        admission.release();
      }
    });
  });

  it.each(["key", "index", "owned"] as const)(
    "reconciles an actual runtime %s receipt without duplicating its row",
    async (identity) => {
      await withTarget(async ({ params, scope, events }) => {
        const original = await persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          expectedLifecycleRevision: params.expectedGeneration.lifecycleRevision,
          messages: [
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: params.payload.text }],
                idempotencyKey: "runtime-final",
                __openclaw: { runId: "original-writer" },
              },
            },
          ],
          updateMode: "none",
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
        expect(await publishHeartbeatSessionReply({ ...params, payload })).toEqual({
          ok: true,
          messageId: original.messages[0]?.messageId,
        });
        expect(await events()).toEqual(before);
      });
    },
  );

  it.each([
    { name: "captioned image", caption: "Attached image", source: "/tmp/reply-image.png" },
    { name: "media-only image", caption: "", source: "/tmp/reply-image.png" },
    { name: "silent voice", caption: "NO_REPLY", source: "/tmp/voice.opus" },
  ])(
    "reconciles a producer-derived $name receipt without rewriting it",
    async ({ caption, source }) => {
      await withTarget(async ({ params, scope, events }) => {
        const assistant = {
          role: "assistant" as const,
          api: "openai-responses" as const,
          provider: "openai",
          model: "receipt-fixture",
          stopReason: "stop" as const,
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [
            {
              type: "text" as const,
              text: `${caption}\nMEDIA:${source}`,
              textSignature: JSON.stringify({ v: 1, id: "media-final", phase: "final_answer" }),
            },
          ],
          idempotencyKey: "runtime-media-final",
          __openclaw: { runId: "original-writer" },
        };
        const original = await persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          expectedLifecycleRevision: params.expectedGeneration.lifecycleRevision,
          messages: [{ message: assistant }],
          updateMode: "none",
        });
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
        expect(payload.text).toBe(caption && caption !== "NO_REPLY" ? caption : undefined);
        expect(payload.mediaUrls).toEqual([source]);
        const before = await events();
        const updates: Array<{ messageId?: string }> = [];
        const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          for (let replay = 0; replay < 2; replay++) {
            expect(await publishHeartbeatSessionReply({ ...params, payload })).toEqual({
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
            expect(
              await publishHeartbeatSessionReply({ ...params, payload: conflicting }),
            ).toMatchObject({ ok: false });
            expect(await events()).toEqual(before);
          }
          expect(updates).toHaveLength(2);
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it("rejects ownership metadata without a current committed final", async () => {
    await withTarget(async ({ params, scope, events }) => {
      await persistSessionTranscriptTurn(scope, {
        expectedSessionId: scope.sessionId,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: params.payload.text }],
              idempotencyKey: "earlier-final",
              __openclaw: { runId: "earlier-writer" },
            },
          },
        ],
        updateMode: "none",
      });
      const before = await events();
      for (const metadata of [
        { assistantTranscriptOwned: true },
        { assistantMessageIndex: 1 },
        { assistantTranscriptOwned: true, assistantTranscriptIdempotencyKey: "missing-final" },
        { assistantTranscriptOwned: true, assistantTranscriptIdempotencyKey: "earlier-final" },
      ]) {
        const payload = setReplyPayloadMetadata({ text: params.payload.text }, metadata);
        expect(await publishHeartbeatSessionReply({ ...params, payload })).toMatchObject({
          ok: false,
        });
      }
      expect(await events()).toEqual(before);
    });
  });

  it.each(["abort", "authority"] as const)(
    "preserves accepted publication when %s occurs during owned-write teardown",
    async (change) => {
      await withTarget(async ({ params, scope, events }) => {
        const controller = new AbortController();
        let ownerActive = true;
        const updates: unknown[] = [];
        const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          const result = await withOwnedSessionTranscriptWrites(
            {
              sessionFile: scope.sessionKey,
              sessionKey: scope.sessionKey,
              sessionTarget: scope,
              assertCommitAllowed: () => {
                if (!ownerActive) {
                  throw new Error("owner released during drain");
                }
              },
              withTranscriptWrite: async (run) => {
                const committedResult = await run();
                expect(updates).toHaveLength(1);
                expect(updates[0]).toHaveProperty("messageId");
                await Promise.resolve();
                if (change === "abort") {
                  controller.abort();
                } else {
                  ownerActive = false;
                }
                return committedResult;
              },
            },
            () => publishHeartbeatSessionReply({ ...params, signal: controller.signal }),
          );
          expect(result).toMatchObject({ ok: true });
          const committed = await events();
          expect(
            committed
              .map(readTranscriptEventMessage)
              .filter((message) => message?.role === "assistant"),
          ).toHaveLength(1);
          expect(updates).toHaveLength(1);
          expect(await publishHeartbeatSessionReply(params)).toMatchObject({ ok: true });
          expect(await events()).toEqual(committed);
          expect(updates).toHaveLength(2);
          expect(updates[1]).not.toHaveProperty("messageId");
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.each(["Managed source caption", ""])(
    "reconciles an actual source-mirror media receipt with caption %j",
    async (caption) => {
      await withTarget(async ({ params, scope, events, workspaceDir }) => {
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
        const payload = payloads[0];
        if (!payload) {
          throw new Error("source producer omitted its payload");
        }
        const updates: Array<{ messageId?: string }> = [];
        const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
        try {
          const metadata = getReplyPayloadMetadata(payload);
          const mirror = metadata?.sourceReplyTranscriptMirror;
          if (!mirror) {
            throw new Error("source producer omitted mirror identity");
          }
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
            expect(await publishHeartbeatSessionReply({ ...params, payload: wrong })).toMatchObject(
              { ok: false },
            );
            expect(await events()).toEqual(before);
          }
          expect(updates).toEqual([]);
          for (let replay = 0; replay < 2; replay++) {
            expect(await publishHeartbeatSessionReply({ ...params, payload })).toMatchObject({
              ok: true,
            });
            expect(await events()).toEqual(before);
          }
          expect(updates).toHaveLength(2);
          expect(updates.every((update) => update.messageId === undefined)).toBe(true);
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it.each(["abort", "authority", "session", "revision", "writer", "archive"] as const)(
    "rejects %s after asynchronous preparation without a transcript write",
    async (change) => {
      await withTarget(async ({ params, scope, entry, events }) => {
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
          () => publishHeartbeatSessionReply({ ...params, signal: controller.signal }),
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
          expect((await events()).map(readTranscriptEventMessage).filter(Boolean)).toEqual([]);
        } finally {
          release.resolve();
          await publication;
        }
      });
    },
  );

  it("fences a revision-less generation when a revision is materialized", async () => {
    await withTarget(async ({ params, scope, entry, events }) => {
      // Pin the absent revision before another owner materializes it.
      await replaceSessionEntry(scope, { ...entry, lifecycleRevision: undefined });
      params.expectedGeneration.lifecycleRevision = undefined;
      await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "materialized" });
      expect(await publishHeartbeatSessionReply(params)).toMatchObject({ ok: false });
      expect((await events()).map(readTranscriptEventMessage).filter(Boolean)).toEqual([]);
    });
  });

  it("does not revive an abandoned completion on replay", async () => {
    await withTarget(async ({ params, scope, events }) => {
      expect(await publishHeartbeatSessionReply(params)).toMatchObject({ ok: true });
      await appendTranscriptMessage(scope, {
        eventId: "replacement-root",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "Replacement branch" }] },
      });
      const before = await events();
      expect(await publishHeartbeatSessionReply(params)).toMatchObject({ ok: false });
      expect(await events()).toEqual(before);
    });
  });

  it("retains accepted publication through owned-drain failure without another assistant row", async () => {
    await withTarget(async ({ params, scope, events }) => {
      const updates: Array<{ messageId?: string }> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
      try {
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
          () => publishHeartbeatSessionReply(params),
        );
        expect(failed).toMatchObject({ ok: true });
        const before = await events();
        expect(
          before.map(readTranscriptEventMessage).filter((message) => message?.role === "assistant"),
        ).toHaveLength(1);
        expect(updates).toHaveLength(1);
        expect(await publishHeartbeatSessionReply(params)).toMatchObject({ ok: true });
        expect(await events()).toEqual(before);
        expect(updates).toHaveLength(2);
        expect(updates[1]?.messageId).toBeUndefined();
      } finally {
        unsubscribe();
      }
    });
  });
});
