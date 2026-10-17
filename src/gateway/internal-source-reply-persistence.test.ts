import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createEmbeddedAttemptTranscriptLifecycle } from "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { persistInternalSourceReply } from "./internal-source-reply-persistence.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  removeManagedOutgoingMediaBlocks,
  resolveManagedOutgoingMediaArtifactDownload,
} from "./managed-image-attachments.js";
import {
  claimManagedImageRecordCleanupIfCurrent,
  listManagedImageRecordEntries,
} from "./managed-image-record-store.js";
import { managedImageRecordReadOperations } from "./managed-image-record-store.kernel.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

async function createSourceReplyFixture(state: OpenClawTestState) {
  setRuntimeConfigSnapshot({});
  const sessionKey = "agent:main:webchat:dm:partial-promotion";
  const sessionId = "partial-promotion-session";
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const entry = {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "initial-lifecycle",
    activeWriterRunId: "original-run",
  };
  const imagePaths = ["first.png", "second.png"].map((name) => path.join(state.workspaceDir, name));
  await fs.mkdir(state.workspaceDir, { recursive: true });
  await Promise.all(
    imagePaths.map((file) => fs.writeFile(file, Buffer.from(TINY_PNG_BASE64, "base64"))),
  );
  await replaceSessionEntry(scope, entry);
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
  });
  const records = () => listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
  const updates: SessionTranscriptUpdate[] = [];
  const downloads: Array<ReturnType<typeof resolveManagedOutgoingMediaArtifactDownload>> = [];
  const readDownloads = async () =>
    (await Promise.allSettled(downloads)).map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    });
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (update.target.sessionId !== sessionId) {
      return;
    }
    updates.push(update);
    // Observe records at publication, before a wrongly late write could make the test pass.
    const { entries } = managedImageRecordReadOperations["managedImages.entries"](
      { sessionKey },
      database.db,
    );
    for (const { record } of entries) {
      const pending = resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        agentId: "main",
        stateDir: state.stateDir,
        artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${record.attachmentId}`,
      });
      void pending.catch(() => {});
      downloads.push(pending);
    }
  });
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({ sessionId });
  let failDrain = false;
  let onQueued: (() => void) | undefined;
  const persist = (options: { sessionKey?: string; runId?: string; textOnly?: boolean } = {}) =>
    withOwnedSessionTranscriptWrites(
      {
        sessionKey,
        sessionTarget: {
          ...scope,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: entry.activeWriterRunId,
        },
        withTranscriptWrite: (run) => {
          onQueued?.();
          onQueued = undefined;
          return lifecycle.withTranscriptWrite(async () => {
            const result = await run();
            if (failDrain) {
              failDrain = false;
              void lifecycle
                .withTranscriptWrite(() => {
                  throw new Error("nested drain failed");
                })
                .catch(() => {});
            }
            return result;
          });
        },
      },
      () =>
        persistInternalSourceReply({
          cfg: { agents: { entries: { main: { workspace: state.workspaceDir } } } },
          sessionKey: options.sessionKey ?? sessionKey,
          expectedSessionId: sessionId,
          agentId: "main",
          idempotencyKey: "partial-promotion-reply",
          sourceReplyFinal: true,
          runId: options.runId ?? "original-run",
          payload: {
            text: "Source reply",
            ...(options.textOnly
              ? {}
              : {
                  mediaUrls: imagePaths,
                  attachments: [{ name: "first.png" }, { name: "second.png" }],
                  trustedLocalMedia: true,
                }),
          },
        }),
    );
  return {
    scope,
    entry,
    records,
    updates,
    downloads: readDownloads,
    persist,
    events: () => loadTranscriptEvents(scope),
    failNextDrain: () => {
      failDrain = true;
    },
    holdWrites: async () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const done = lifecycle.withTranscriptWrite(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = createDeferredCore();
      onQueued = queued.resolve;
      return { queued: queued.promise, release: release.resolve, done };
    },
    dispose: async () => {
      unsubscribe();
      try {
        await readDownloads();
      } finally {
        await lifecycle.dispose();
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createSourceReplyFixture>>;
type Records = Awaited<ReturnType<Fixture["records"]>>;

async function expectOriginalBytes(records: Records) {
  for (const {
    record: { original },
  } of records) {
    await expect(
      fs.readFile(path.join(original.mediaRoot, original.mediaSubdir, original.mediaId)),
    ).resolves.toEqual(Buffer.from(TINY_PNG_BASE64, "base64"));
  }
}

async function createPartialPromotion(fixture: Fixture) {
  let promotions = 0;
  // Refuse the second native commit, retaining the real update and rollback.
  const fault = probe.admission(operationAdmission, (request, grant, admit) => {
    if (
      request.stage === "commit" &&
      isRecord(request.facts) &&
      request.facts.type === "managedImages.attach" &&
      ++promotions === 2
    ) {
      throw new Error("second media promotion failed");
    }
    admit(request, grant);
  });
  try {
    await expect(fixture.persist()).rejects.toThrow("second media promotion failed");
    const events = await fixture.events();
    const assistants = events.filter(
      (event) => readTranscriptEventMessage(event)?.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    const messageId = readTranscriptEventId(assistants[0]);
    expect(messageId).toBeTruthy();
    const records = await fixture.records();
    expect(records).toHaveLength(2);
    const first = records.find(({ record }) => record.original.filename === "first.png")?.record;
    const second = records.find(({ record }) => record.original.filename === "second.png")?.record;
    expect({ first, second }).toMatchObject({
      first: { messageId, retentionClass: "history" },
      second: { messageId: null, retentionClass: "transient" },
    });
    expect(fixture.updates).toEqual([]);
    await expectOriginalBytes(records);
    return { events, messageId };
  } finally {
    fault.mockRestore();
  }
}

describe("internal source reply persistence", () => {
  it.each(["partial-promotion", "owned-drain", "canonical-key", "text-only"] as const)(
    "completes exact replay and refreshes history after %s",
    async (mode) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "source-reply-replay-" },
        async (state) => {
          const fixture = await createSourceReplyFixture(state);
          try {
            if (mode === "partial-promotion") {
              await createPartialPromotion(fixture);
            } else if (mode === "owned-drain") {
              fixture.failNextDrain();
              await expect(fixture.persist()).rejects.toThrow("nested drain failed");
              expect(fixture.updates).toEqual([]);
              expect(
                (await fixture.records()).every(
                  ({ record }) => record.retentionClass === "history",
                ),
              ).toBe(true);
            } else {
              await fixture.persist({ textOnly: mode === "text-only" });
              expect(fixture.updates).toHaveLength(1);
            }
            const events = await fixture.events();
            const assistants = events.filter(
              (event) => readTranscriptEventMessage(event)?.role === "assistant",
            );
            expect(assistants).toHaveLength(1);
            expect(readTranscriptEventMessage(assistants[0])).toMatchObject({
              __openclaw: { runId: "original-run" },
            });
            const messageId = readTranscriptEventId(assistants[0]);
            const originalIds = (await fixture.records())
              .map(({ record }) => record.attachmentId)
              .toSorted();
            const beforeUpdates = fixture.updates.length;
            await expect(
              fixture.persist({
                runId: "retry-run",
                textOnly: mode === "text-only",
                ...(mode === "canonical-key"
                  ? { sessionKey: "AGENT:MAIN:webchat:dm:partial-promotion" }
                  : {}),
              }),
            ).resolves.toBeUndefined();
            expect(await fixture.events()).toEqual(events);
            const records = await fixture.records();
            expect(records.map(({ record }) => record.attachmentId).toSorted()).toEqual(
              originalIds,
            );
            expect(fixture.updates).toHaveLength(beforeUpdates + 1);
            expect(fixture.updates.at(-1)?.message).toBeUndefined();
            expect(fixture.updates.filter((update) => update.message !== undefined)).toHaveLength(
              beforeUpdates,
            );
            expect(records).toHaveLength(mode === "text-only" ? 0 : 2);
            for (const { record, cleanupPending } of records) {
              expect(cleanupPending).toBe(false);
              expect(record).toMatchObject({ messageId, retentionClass: "history" });
            }
            await expectOriginalBytes(records);
            const downloads = await fixture.downloads();
            expect(downloads).toHaveLength(fixture.updates.length * (mode === "text-only" ? 0 : 2));
            for (const download of downloads) {
              expect(download).toMatchObject({ type: "image" });
            }
          } finally {
            await fixture.dispose();
          }
        },
      );
    },
  );

  it.each([
    "session",
    "lifecycle",
    "writer",
    "abandoned",
    "removed",
    "missing-media",
    "cleanup-pending",
  ] as const)(
    "rejects replay after %s changes while its real owned write is queued",
    async (changed) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "source-reply-stale-" },
        async (state) => {
          const fixture = await createSourceReplyFixture(state);
          let held: Awaited<ReturnType<Fixture["holdWrites"]>> | undefined;
          let replay: Promise<void> | undefined;
          try {
            const original = await createPartialPromotion(fixture);
            held = await fixture.holdWrites();
            replay = fixture.persist({ runId: "retry-run" });
            await Promise.race([
              held.queued,
              replay.then(() => {
                throw new Error("replay completed before the owned queue");
              }),
            ]);
            if (changed === "session" || changed === "lifecycle" || changed === "writer") {
              await replaceSessionEntry(fixture.scope, {
                ...fixture.entry,
                ...(changed === "session" ? { sessionId: "replacement-session" } : {}),
                ...(changed === "lifecycle" ? { lifecycleRevision: "replacement-lifecycle" } : {}),
                ...(changed === "writer" ? { activeWriterRunId: "replacement-writer" } : {}),
              });
            } else if (changed === "abandoned") {
              await appendTranscriptMessage(fixture.scope, {
                eventId: "replacement-root",
                parentId: null,
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Replacement branch" }],
                },
              });
            } else if (changed === "removed") {
              await replaceTranscriptEvents(
                fixture.scope,
                original.events.filter(
                  (event) => readTranscriptEventId(event) !== original.messageId,
                ),
              );
            } else {
              const pending = (await fixture.records()).find(
                ({ record }) => record.messageId === null,
              )?.record;
              if (!pending) {
                throw new Error("expected second prepared media record");
              }
              if (changed === "cleanup-pending") {
                expect(await claimManagedImageRecordCleanupIfCurrent(pending, state.stateDir)).toBe(
                  true,
                );
              } else {
                await removeManagedOutgoingMediaBlocks({
                  stateDir: state.stateDir,
                  messageId: null,
                  blocks: [
                    {
                      type: "image",
                      url: `/api/chat/media/outgoing/${encodeURIComponent(fixture.scope.sessionKey)}/${pending.attachmentId}/full`,
                    },
                  ],
                });
                expect(await fixture.records()).toHaveLength(1);
              }
            }
            const beforeEvents = await fixture.events();
            const beforeRecords = await fixture.records();
            held.release();
            await expect(replay).rejects.toThrow(
              changed === "missing-media" || changed === "cleanup-pending"
                ? "media ownership could not be persisted"
                : "no longer owns the active transcript",
            );
            await held.done;
            expect(await fixture.events()).toEqual(beforeEvents);
            const records = await fixture.records();
            expect(records).toEqual(beforeRecords);
            expect(fixture.updates).toEqual([]);
            await expectOriginalBytes(records);
          } finally {
            held?.release();
            await held?.done;
            await replay?.catch(() => {});
            await fixture.dispose();
          }
        },
      );
    },
  );
});
