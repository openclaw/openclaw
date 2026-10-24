import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
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
  let finishHeld: (() => Promise<void>) | undefined;
  const payload = {
    text: "Source reply",
    mediaUrls: imagePaths,
    attachments: imagePaths.map((file) => ({ name: path.basename(file) })),
    trustedLocalMedia: true,
  };
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
          payload: options.textOnly ? { text: payload.text } : payload,
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
    holdReplay: async () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const done = lifecycle.withTranscriptWrite(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = createDeferredCore();
      onQueued = queued.resolve;
      const replay = Promise.resolve().then(() => persist({ runId: "retry-run" }));
      finishHeld = async () => {
        release.resolve();
        await done;
        await replay.catch(() => {});
      };
      await Promise.race([
        queued.promise,
        replay.then(() => {
          throw new Error("replay completed before the owned queue");
        }),
      ]);
      return { replay, done, release: release.resolve };
    },
    dispose: async () => {
      await finishHeld?.();
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

function withFixture(run: (fixture: Fixture, state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "source-reply-" }, async (state) => {
    const fixture = await createSourceReplyFixture(state);
    try {
      await run(fixture, state);
    } finally {
      await fixture.dispose();
    }
  });
}

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
  const { persist, events: readEvents, records: readRecords, updates } = fixture;
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
    await expect(persist()).rejects.toThrow("second media promotion failed");
    const events = await readEvents();
    const messageId = readTranscriptEventId(onlyAssistant(events));
    expect(messageId).toBeTruthy();
    const records = await readRecords();
    expect(records).toHaveLength(2);
    const first = records.find(({ record }) => record.original.filename === "first.png")?.record;
    const second = records.find(({ record }) => record.original.filename === "second.png")?.record;
    expect({ first, second }).toMatchObject({
      first: { messageId, retentionClass: "history" },
      second: { messageId: null, retentionClass: "transient" },
    });
    expect(updates).toEqual([]);
    await expectOriginalBytes(records);
    return { events, messageId };
  } finally {
    fault.mockRestore();
  }
}

function onlyAssistant(events: Awaited<ReturnType<Fixture["events"]>>) {
  const assistants = events.filter(
    (event) => readTranscriptEventMessage(event)?.role === "assistant",
  );
  expect(assistants).toHaveLength(1);
  return assistants[0];
}

it.each(["partial-promotion", "owned-drain", "canonical-key", "text-only"] as const)(
  "completes exact replay and refreshes history after %s",
  async (mode) =>
    withFixture(async (fixture) => {
      const { persist, records: readRecords, events: readEvents, updates, downloads } = fixture;
      if (mode === "partial-promotion") {
        await createPartialPromotion(fixture);
      } else if (mode === "owned-drain") {
        fixture.failNextDrain();
        await expect(persist()).rejects.toThrow("nested drain failed");
        expect(updates).toEqual([]);
        expect((await readRecords()).map(({ record }) => record.retentionClass)).toEqual([
          "history",
          "history",
        ]);
      } else {
        await persist({ textOnly: mode === "text-only" });
        expect(updates).toHaveLength(1);
      }
      const events = await readEvents();
      const assistant = onlyAssistant(events);
      expect(readTranscriptEventMessage(assistant)).toMatchObject({
        __openclaw: { runId: "original-run" },
      });
      const messageId = readTranscriptEventId(assistant);
      const originalIds = (await readRecords()).map(({ record }) => record.attachmentId).toSorted();
      const beforeUpdates = updates.length;
      await expect(
        persist({
          runId: "retry-run",
          textOnly: mode === "text-only",
          sessionKey:
            mode === "canonical-key" ? "AGENT:MAIN:webchat:dm:partial-promotion" : undefined,
        }),
      ).resolves.toBeUndefined();
      expect(await readEvents()).toEqual(events);
      const records = await readRecords();
      expect(records.map(({ record }) => record.attachmentId).toSorted()).toEqual(originalIds);
      expect(updates.map((update) => update.message !== undefined)).toEqual([
        ...Array<boolean>(beforeUpdates).fill(true),
        false,
      ]);
      expect(records).toHaveLength(mode === "text-only" ? 0 : 2);
      for (const { record, cleanupPending } of records) {
        expect({ cleanupPending, record }).toMatchObject({
          cleanupPending: false,
          record: { messageId, retentionClass: "history" },
        });
      }
      await expectOriginalBytes(records);
      expect((await downloads()).map((download) => download?.type)).toEqual(
        Array<string>(updates.length * (mode === "text-only" ? 0 : 2)).fill("image"),
      );
    }),
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
  async (changed) =>
    withFixture(async (fixture, state) => {
      const { scope, entry, records: readRecords, events: readEvents, updates } = fixture;
      const original = await createPartialPromotion(fixture);
      const held = await fixture.holdReplay();
      if (changed === "session" || changed === "lifecycle" || changed === "writer") {
        const replacements = {
          session: { sessionId: "replacement-session" },
          lifecycle: { lifecycleRevision: "replacement-lifecycle" },
          writer: { activeWriterRunId: "replacement-writer" },
        };
        await replaceSessionEntry(scope, { ...entry, ...replacements[changed] });
      } else if (changed === "abandoned") {
        await appendTranscriptMessage(scope, {
          eventId: "replacement-root",
          parentId: null,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Replacement branch" }],
          },
        });
      } else if (changed === "removed") {
        await replaceTranscriptEvents(
          scope,
          original.events.filter((event) => readTranscriptEventId(event) !== original.messageId),
        );
      } else {
        const pending = (await readRecords()).find(
          ({ record }) => record.messageId === null,
        )?.record;
        if (!pending) {
          throw new Error("expected second prepared media record");
        }
        if (changed === "cleanup-pending") {
          expect(await claimManagedImageRecordCleanupIfCurrent(pending, state.stateDir)).toBe(true);
        } else {
          await removeManagedOutgoingMediaBlocks({
            stateDir: state.stateDir,
            messageId: null,
            blocks: [
              {
                type: "image",
                url: `/api/chat/media/outgoing/${encodeURIComponent(scope.sessionKey)}/${pending.attachmentId}/full`,
              },
            ],
          });
          expect(await readRecords()).toHaveLength(1);
        }
      }
      const beforeEvents = await readEvents();
      const beforeRecords = await readRecords();
      held.release();
      await expect(held.replay).rejects.toThrow(
        changed === "missing-media" || changed === "cleanup-pending"
          ? "media ownership could not be persisted"
          : "no longer owns the active transcript",
      );
      await held.done;
      expect(await readEvents()).toEqual(beforeEvents);
      const records = await readRecords();
      expect(records).toEqual(beforeRecords);
      expect(updates).toEqual([]);
      await expectOriginalBytes(records);
    }),
);
