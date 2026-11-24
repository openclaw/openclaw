import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as channelMessage from "../../channels/message/runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as entryReader from "../../config/sessions/session-entry-read-runtime.js";
import * as managedMedia from "../../gateway/managed-image-attachments.js";
import { deliverQueuedSessionDelivery } from "../../gateway/server-restart-sentinel.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { computeBackoffMs } from "../../infra/delivery-recovery.shared.js";
import { pruneOrphanedDeliveryQueueMedia } from "../../infra/outbound/delivery-queue-media-spool.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
} from "../../infra/session-delivery-queue-recovery.js";
import * as queue from "../../infra/session-delivery-queue-storage.js";
import { observeSessionDeliveryPublications } from "../../infra/session-delivery-queue.test-helpers.js";
import { cleanOldMedia } from "../../media/store.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { findDuplicateGuardImageGenerationTaskForSession } from "../media-generation-task-status.js";
import * as direct from "../subagents/announce/subagent-announce-direct-delivery.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import { createImageTool } from "./image-tool.js";
import { mediaGenerationCompletionDeliveryKey } from "./media-generate-background-completion.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
} from "./media-generate-background-shared.js";
import { runMediaGenerationTask } from "./media-generate-background.js";

const sessionKey = "agent:main:creative-review";
const lifecycle = createMediaGenerationTaskLifecycle("image");
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
});

async function requester(state: OpenClawTestState) {
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  setRuntimeConfigSnapshot({ agents: { ownership: "explicit", entries: { main: {} } } });
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    { sessionId: "creative-review-session", updatedAt: 1 },
  );
}

async function decide(params: {
  action: "review" | "deliver" | "supersede";
  taskId?: string;
  sessionKey: string;
  agentId: string;
}) {
  const tool = createImageGenerateTool(
    { agentSessionKey: params.sessionKey, requesterAgentId: params.agentId },
    true,
  );
  assert(tool);
  return tool.execute("review-decision", { action: params.action, taskId: params.taskId });
}

async function task(
  deliveryMode?: "review",
  requesterOrigin: DeliveryContext = { channel: "webchat" },
) {
  const handle = await lifecycle.createTaskRun({
    sessionKey,
    requesterAgentId: "main",
    requesterOrigin,
    prompt: "A reference-aware creative candidate",
    deliveryMode,
  });
  assert(handle);
  return handle;
}

it("pages candidate summaries without losing exact private inspection or a deleted cursor", async () => {
  await withOpenClawTestState({ label: "review-candidate-pages" }, async (state) => {
    await requester(state);
    const source = state.statePath("media", "candidate.png");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }));
    const context = captureOpenClawStateWorkerContext();
    const ids = Array.from(
      { length: 25 },
      (_, index) => "candidate-list-" + String(index).padStart(3, "0"),
    );
    for (const [index, taskId] of ids.entries()) {
      const key = mediaGenerationCompletionDeliveryKey("image_generate", taskId);
      await queue.enqueueClaimedSessionDelivery(
        {
          kind: "mediaCandidate",
          sessionKey,
          messageId: key,
          idempotencyKey: key,
          requesterBinding: {
            agentId: "main",
            sessionKey,
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            sessionId: "creative-review-session",
            lifecycleRevision: null,
          },
          expectedMediaUrls: [source],
          taskId,
          inspectionContext: "Synthetic candidate",
          disposition: index % 3 === 0 ? "superseded" : "review_pending",
        },
        0,
        context,
      );
    }
    const tool = createImageGenerateTool(
      { agentSessionKey: sessionKey, requesterAgentId: "main" },
      true,
    );
    assert(tool);
    let cursor: string | undefined;
    const seen: unknown[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await tool.execute("candidate-page", {
        action: "review",
        ...(cursor ? { cursor } : {}),
      });
      const details = asRecord(result.details);
      const candidates = details.candidates;
      assert(Array.isArray(candidates));
      expect(candidates).toHaveLength(page === 3 ? 1 : 8);
      expect(JSON.stringify(result.content).length).toBeLessThan(4_000);
      expect(candidates[0]).toHaveProperty("imageCount", 1);
      expect(candidates[0]).not.toHaveProperty("files");
      seen.push(...candidates.map((candidate) => asRecord(candidate).taskId));
      if (page < 3) {
        assert(typeof details.nextCursor === "string");
        cursor = details.nextCursor;
      } else {
        expect(details.nextCursor).toBeNull();
      }
      if (page === 0) {
        await expect(
          decide({ action: "deliver", taskId: ids[7], sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({ details: { status: "approved" } });
      }
    }
    expect(seen).toEqual(ids);
    await expect(
      decide({ action: "review", taskId: ids[24], sessionKey, agentId: "main" }),
    ).resolves.toMatchObject({
      details: {
        candidates: [{ taskId: ids[24], files: [source], inspectionFiles: [expect.any(String)] }],
      },
    });
  });
});

it("durably holds produced candidates before waiting for the requester's turn", async () => {
  await withOpenClawTestState({ label: "creative-review" }, async (state) => {
    await requester(state);
    const candidatePath = state.statePath("media", "candidate.png");
    await fs.mkdir(path.dirname(candidatePath), { recursive: true });
    const candidateBytes = createSolidPngBuffer(2050, 1, { r: 17, g: 34, b: 51 });
    await fs.writeFile(candidatePath, candidateBytes);
    const original = await task("review");
    const settlement = createDeferred();
    const committed = createDeferred();
    const enqueue = queue.enqueueClaimedSessionDelivery;
    vi.spyOn(queue, "enqueueClaimedSessionDelivery").mockImplementation(async (...args) => {
      const receipt = await enqueue(...args);
      committed.resolve();
      return receipt;
    });
    const handle = { ...original, requesterSettlement: settlement.promise };
    const context = captureOpenClawStateWorkerContext();
    const completion = lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "generated",
      result: "Generated one candidate",
      mediaUrls: [candidatePath],
    });
    try {
      await committed.promise;
      expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
        {
          kind: "mediaCandidate",
          taskId: handle.taskId,
          disposition: "review_pending",
        },
      ]);
      const [candidate] = await queue.loadPendingSessionDeliveries(context);
      assert(candidate && candidate.kind === "mediaCandidate" && candidate.expectedMediaUrls?.[0]);
      expect(await fs.readFile(candidate.expectedMediaUrls[0])).toEqual(candidateBytes);
    } finally {
      lifecycle.failTaskRun({ handle });
      settlement.resolve();
      await completion;
    }
  });
});

it.each(["review", "automatic-retired"] as const)(
  "retains corrected and wake-failed paid candidates across restart, delivering only approved or default siblings: %s",
  async (mode) => {
    await withOpenClawTestState({ label: "creative-review-restart" }, async (state) => {
      await requester(state);
      const file = (name: string) => state.statePath("media", "tool-image-generation", name);
      await fs.mkdir(path.dirname(file("older.png")), { recursive: true });
      for (const name of ["older.png", "review.png"]) {
        await fs.writeFile(file(name), createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }));
      }
      const visibleSend = vi.spyOn(channelMessage, "sendDurableMessageBatchCore");
      const reviewWake = vi
        .spyOn(direct, "sendSubagentAnnounceDirectly")
        .mockRejectedValue(new Error("synthetic reviewer wake failure"));
      const older = await task(mode === "review" ? "review" : undefined);
      const providerEntered = createDeferred();
      const providerResult = createDeferred();
      let work: (() => Promise<void>) | undefined;
      scheduleMediaGenerationTaskCompletion({
        lifecycle,
        handle: older,
        scheduleBackgroundWork: (run) => {
          work = run;
        },
        progressSummary: "Generating image",
        toolName: "image_generate",
        onWakeFailure: vi.fn(),
        run: async () => {
          providerEntered.resolve();
          await providerResult.promise;
          return { count: 1, wakeResult: "generated", mediaUrls: [file("older.png")] };
        },
      });
      assert(work);
      const generation = work();
      await providerEntered.promise;
      await expect(
        decide({ action: "supersede", taskId: older.taskId, sessionKey, agentId: "main" }),
      ).resolves.toMatchObject({ details: { status: "superseded" } });
      expect(
        await findDuplicateGuardImageGenerationTaskForSession(sessionKey, {
          prompt: "A reference-aware creative candidate",
          agentId: "main",
        }),
      ).toBeUndefined();
      if (mode === "automatic-retired") {
        rotateAgentEventLifecycleGeneration();
      }
      providerResult.resolve();
      await generation;
      expect(reviewWake).not.toHaveBeenCalled();

      const sibling = await task("review");
      await expect(
        lifecycle.wakeTaskCompletion({
          handle: sibling,
          status: "ok",
          statusLabel: "generated",
          result: "Generated one candidate",
          attachments: [
            { type: "image", path: file("review.png"), mimeType: "image/png", name: "review.png" },
          ],
          mediaUrls: [file("review.png")],
        }),
      ).rejects.toThrow("synthetic reviewer wake failure");
      lifecycle.completeTaskRun({ handle: sibling, count: 1 });
      expect(reviewWake).toHaveBeenCalledOnce();
      const reviewerInput = reviewWake.mock.calls[0]?.[0];
      expect(reviewerInput?.inputAttachments).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          fileName: "review.png",
          content: createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }).toString("base64"),
        },
      ]);
      expect(reviewerInput?.internalEvents?.[0]?.result).toContain("held privately for review");
      expect(reviewerInput?.internalEvents?.[0]).not.toHaveProperty("attachments");
      expect(reviewerInput?.internalEvents?.[0]).not.toHaveProperty("mediaUrls");
      expect(reviewerInput?.triggerMessage).not.toContain("MEDIA:");

      let context = captureOpenClawStateWorkerContext();
      const heldCandidates = await queue.loadPendingSessionDeliveries(context);
      expect(heldCandidates).toHaveLength(2);
      const olderCandidate = heldCandidates.find(
        (entry) => entry.kind === "mediaCandidate" && entry.taskId === older.taskId,
      );
      const siblingCandidate = heldCandidates.find(
        (entry) => entry.kind === "mediaCandidate" && entry.taskId === sibling.taskId,
      );
      assert(
        olderCandidate?.kind === "mediaCandidate" && siblingCandidate?.kind === "mediaCandidate",
      );
      const olderFiles = olderCandidate.expectedMediaUrls ?? [];
      const siblingFiles = siblingCandidate.expectedMediaUrls ?? [];
      expect(reviewerInput?.internalEvents?.[0]?.result).toContain(siblingFiles[0]);
      const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
      const originalFiles = (await fs.readdir(path.dirname(file("older.png")))).map(file);
      await Promise.all(
        [...olderFiles, ...siblingFiles, ...originalFiles].map((filePath) =>
          fs.utimes(filePath, old, old),
        ),
      );
      await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
      rotateAgentEventLifecycleGeneration();
      context = captureOpenClawStateWorkerContext();
      await cleanOldMedia(1_000, { recursive: true });
      await pruneOrphanedDeliveryQueueMedia(
        { nowMs: Date.now() + 2 * 24 * 60 * 60_000 },
        { stateDir: state.stateDir, workerContext: context },
      );
      for (const filePath of [...olderFiles, ...siblingFiles]) {
        expect(await fs.readFile(filePath)).toEqual(
          createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }),
        );
      }
      const delivered: string[] = [];
      const deliver = vi.fn(
        async (entry: Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"]) => {
          await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext: context });
          delivered.push(entry.id);
        },
      );
      await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
      expect(deliver).not.toHaveBeenCalled();
      await expect(
        decide({ action: "review", sessionKey, agentId: "main" }),
      ).resolves.toMatchObject({
        details: {
          candidates: expect.arrayContaining([
            { taskId: older.taskId, disposition: "superseded", imageCount: 1 },
            { taskId: sibling.taskId, disposition: "review_pending", imageCount: 1 },
          ]),
        },
      });
      const inspected = await decide({
        action: "review",
        taskId: sibling.taskId,
        sessionKey,
        agentId: "main",
      });
      const candidates = asRecord(inspected.details).candidates;
      assert(Array.isArray(candidates));
      const references = asRecord(candidates[0]).inspectionFiles ?? asRecord(candidates[0]).files;
      assert(Array.isArray(references));
      const view = createImageTool({
        agentDir: state.statePath("agents", "main", "agent"),
        workspaceDir: state.workspaceDir,
        fsPolicy: { workspaceOnly: true },
        modelHasVision: true,
      });
      assert(view);
      expect(
        (await view.execute("inspect-held-candidate", { path: references[0] })).content,
      ).toContainEqual(expect.objectContaining({ type: "image" }));
      expect(visibleSend).not.toHaveBeenCalled();
      assert(sibling.requesterTranscript);
      expect(await loadTranscriptEvents(sibling.requesterTranscript)).not.toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "assistant" }),
        }),
      );
      await expect(
        decide({ action: "deliver", taskId: older.taskId, sessionKey, agentId: "main" }),
      ).resolves.toMatchObject({ details: { status: "superseded" } });
      await expect(
        decide({ action: "deliver", taskId: sibling.taskId, sessionKey, agentId: "main" }),
      ).resolves.toMatchObject({ details: { status: "approved" } });

      const automatic = await task();
      // This later provider output does not exist during the earlier cleanup.
      await fs.writeFile(
        file("automatic.png"),
        createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }),
      );
      await expect(
        lifecycle.wakeTaskCompletion({
          handle: automatic,
          status: "ok",
          statusLabel: "generated",
          result: "Generated default image",
          mediaUrls: [file("automatic.png")],
        }),
      ).resolves.toEqual({ status: "queued" });
      const messages: string[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (update.target?.sessionId === "creative-review-session" && update.messageId) {
          messages.push(update.messageId);
        }
      });
      try {
        // A queued handoff still honors its recorded retry backoff. Replay at
        // eligibility rather than assuming SQLite work consumed that interval.
        for (const entry of await queue.loadPendingSessionDeliveries(context)) {
          await drainPendingSessionDelivery({
            id: entry.id,
            queueContext: context,
            deliver,
            log,
            logLabel: "review restart proof",
            now: () =>
              Math.max(
                Date.now(),
                entry.availableAt ?? 0,
                (entry.lastAttemptAt ?? entry.enqueuedAt) + computeBackoffMs(entry.retryCount),
              ),
          });
        }
        expect(delivered).toHaveLength(2);
        expect(new Set(messages).size).toBe(2);
        expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
          {
            kind: "mediaCandidate",
            taskId: older.taskId,
            disposition: "superseded",
            expectedMediaUrls: olderFiles,
          },
        ]);
        await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
        expect(deliver).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
        lifecycle.completeTaskRun({ handle: automatic, count: 1 });
      }
    });
  },
);

it.each([
  "started",
  "replaced",
  "replaced-before-completion",
  "retired-before-completion",
  "store-before-completion",
] as const)(
  "does not disclose or resend a candidate after its requester is %s",
  async (scenario) => {
    await withOpenClawTestState({ label: "creative-review-authority" }, async (state) => {
      await requester(state);
      const source = state.statePath("media", "candidate.png");
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }));
      vi.spyOn(direct, "sendSubagentAnnounceDirectly").mockRejectedValue(
        new Error("synthetic reviewer unavailable"),
      );
      const send = vi
        .spyOn(channelMessage, "sendDurableMessageBatchCore")
        .mockRejectedValue(new Error("must not resend"));
      const handle = await task("review", { channel: "telegram", to: "123" });
      if (scenario === "replaced-before-completion") {
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey,
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          },
          { sessionId: "replacement", updatedAt: 2 },
        );
      } else if (scenario === "retired-before-completion") {
        rotateAgentEventLifecycleGeneration();
      } else if (scenario === "store-before-completion") {
        const alternate = state.statePath("alternate", "sessions.json");
        setRuntimeConfigSnapshot({
          agents: { ownership: "explicit", entries: { main: {} } },
          session: { store: alternate },
        });
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath: alternate },
          { sessionId: "creative-review-session", updatedAt: 2 },
        );
      }
      const completion = lifecycle.wakeTaskCompletion({
        handle,
        status: "ok",
        statusLabel: "generated",
        result: "candidate",
        mediaUrls: [source],
      });
      if (scenario.endsWith("before-completion")) {
        await expect(completion).resolves.toEqual({ status: "permanent_failure" });
      } else {
        await expect(completion).rejects.toThrow("synthetic reviewer unavailable");
      }
      lifecycle.completeTaskRun({ handle, count: 1 });
      const context = captureOpenClawStateWorkerContext();
      if (scenario === "started") {
        await decide({ action: "deliver", taskId: handle.taskId, sessionKey, agentId: "main" });
        const [approved] = await queue.loadPendingSessionDeliveries(context);
        assert(approved?.kind === "agentTurn");
        await queue.markSessionDeliveryAttemptStarted(approved, context);
        await expect(
          decide({ action: "supersede", taskId: handle.taskId, sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({ details: { status: "delivery_started" } });
      } else if (scenario !== "retired-before-completion") {
        if (scenario !== "store-before-completion") {
          await replaceSessionEntry(
            {
              agentId: "main",
              sessionKey,
              storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            },
            { sessionId: "replacement", updatedAt: 2 },
          );
        }
        await expect(
          decide({ action: "review", sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({ details: { candidates: [] } });
        await expect(
          decide({ action: "deliver", taskId: handle.taskId, sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({ details: { status: "not_found" } });
      }
      if (scenario === "store-before-completion") {
        await expect(
          decide({ action: "supersede", taskId: handle.taskId, sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({ details: { status: "not_found" } });
      }
      const deliver = vi.fn(
        async (entry: Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"]) => {
          await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext: context });
        },
      );
      await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
      await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
      expect(send).not.toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(scenario === "started" ? 1 : 0);
      if (scenario !== "started") {
        expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
          { kind: "mediaCandidate", disposition: "review_pending" },
        ]);
      }
    });
  },
);

it.each(["queued", "delivery-started", "delivered"] as const)(
  "supersedes one produced automatic task without losing bytes or revoking admitted delivery: %s",
  async (phase) => {
    await withOpenClawTestState({ label: "automatic-supersession" }, async (state) => {
      await requester(state);
      const source = state.statePath("media", "automatic.png");
      const bytes = createSolidPngBuffer(1, 1, { r: 91, g: 34, b: 51 });
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, bytes);
      const handle = await task();
      await expect(
        lifecycle.wakeTaskCompletion({
          handle,
          status: "ok",
          statusLabel: "generated",
          result: "default output",
          mediaUrls: [source],
        }),
      ).resolves.toEqual({ status: "queued" });
      const context = captureOpenClawStateWorkerContext();
      const entered = createDeferred();
      const release = createDeferred();
      const prepare = managedMedia.createManagedOutgoingMediaBlocks;
      if (phase === "delivery-started") {
        vi.spyOn(managedMedia, "createManagedOutgoingMediaBlocks").mockImplementationOnce(
          async (params) => {
            entered.resolve();
            await release.promise;
            return prepare(params);
          },
        );
      }
      const updates: string[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (update.target?.sessionId === "creative-review-session" && update.messageId) {
          updates.push(update.messageId);
        }
      });
      const deliver = vi.fn(
        async (entry: Parameters<typeof deliverQueuedSessionDelivery>[0]["entry"]) => {
          await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext: context });
        },
      );
      const recovery =
        phase === "delivery-started"
          ? recoverPendingSessionDeliveries({ queueContext: context, deliver, log })
          : undefined;
      try {
        if (recovery) {
          await entered.promise;
        }
        if (phase === "delivered") {
          await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
        }
        await expect(
          decide({ action: "supersede", taskId: handle.taskId, sessionKey, agentId: "main" }),
        ).resolves.toMatchObject({
          details: { status: phase === "queued" ? "superseded" : "delivery_started" },
        });
        if (phase === "queued") {
          const [held] = await queue.loadPendingSessionDeliveries(context);
          assert(held?.kind === "mediaCandidate" && held.expectedMediaUrls?.[0]);
          expect(held.expectedMediaUrls[0]).not.toBe(source);
          const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
          await fs.utimes(source, old, old);
          await cleanOldMedia(1_000, { recursive: true });
          await pruneOrphanedDeliveryQueueMedia(
            { nowMs: Date.now() + 2 * 24 * 60 * 60_000 },
            { stateDir: state.stateDir, workerContext: context },
          );
          expect(await fs.readFile(held.expectedMediaUrls[0])).toEqual(bytes);
        }
      } finally {
        release.resolve();
        await recovery;
        unsubscribe();
        lifecycle.completeTaskRun({ handle, count: 1 });
      }
      await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
      expect(deliver).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
      expect(updates).toHaveLength(phase === "queued" ? 0 : 1);
    });
  },
);

it("honors a correction that arrives during automatic completion handoff", async () => {
  await withOpenClawTestState({ label: "automatic-handoff-correction" }, async (state) => {
    await requester(state);
    const source = state.statePath("media", "handoff.png");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, createSolidPngBuffer(1, 1, { r: 91, g: 34, b: 51 }));
    const handle = await task();
    const entered = createDeferred();
    const release = createDeferred();
    const read = entryReader.withSessionEntryReadOnlyInWorker;
    vi.spyOn(entryReader, "withSessionEntryReadOnlyInWorker").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return read(...args);
      },
    );
    const completion = lifecycle.wakeTaskCompletion({
      handle,
      status: "ok",
      statusLabel: "generated",
      result: "automatic handoff",
      mediaUrls: [source],
    });
    try {
      await entered.promise;
      await expect(
        decide({ action: "supersede", taskId: handle.taskId, sessionKey, agentId: "main" }),
      ).resolves.toMatchObject({ details: { status: "superseded" } });
      const context = captureOpenClawStateWorkerContext();
      expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
        { kind: "mediaCandidate", taskId: handle.taskId, disposition: "superseded" },
      ]);
      release.resolve();
      await expect(completion).resolves.toEqual({ status: "delivered" });
      expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
        { kind: "mediaCandidate", taskId: handle.taskId, disposition: "superseded" },
      ]);
      const deliver = vi.fn(async () => {});
      await recoverPendingSessionDeliveries({ queueContext: context, deliver, log });
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await completion;
      lifecycle.completeTaskRun({ handle, count: 1 });
    }
  });
});

it("manages review in the durable requester when the tool policy key is different", async () => {
  await withOpenClawTestState({ label: "review-requester-alias" }, async (state) => {
    await requester(state);
    const policyKey = "agent:main:tool-policy";
    const source = state.statePath("media", "alias.png");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, createSolidPngBuffer(1, 1, { r: 91, g: 34, b: 51 }));
    const handle = await lifecycle.createTaskRun({
      sessionKey: policyKey,
      requesterRunSessionKey: sessionKey,
      requesterAgentId: "main",
      requesterOrigin: { channel: "webchat" },
      deliveryMode: "review",
      prompt: "alias review",
    });
    assert(handle);
    vi.spyOn(direct, "sendSubagentAnnounceDirectly").mockRejectedValue(
      new Error("reviewer unavailable"),
    );
    await expect(
      lifecycle.wakeTaskCompletion({
        handle,
        status: "ok",
        statusLabel: "generated",
        result: "alias output",
        mediaUrls: [source],
      }),
    ).rejects.toThrow("reviewer unavailable");
    const tool = createImageGenerateTool(
      { agentSessionKey: policyKey, requesterRunSessionKey: sessionKey, requesterAgentId: "main" },
      true,
    );
    assert(tool);
    await expect(tool.execute("list-alias", { action: "review" })).resolves.toMatchObject({
      details: {
        candidates: [
          expect.objectContaining({ taskId: handle.taskId, disposition: "review_pending" }),
        ],
      },
    });
    await expect(
      tool.execute("deliver-alias", { action: "deliver", taskId: handle.taskId }),
    ).resolves.toMatchObject({ details: { status: "approved" } });
    const context = captureOpenClawStateWorkerContext();
    const delivered: string[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.target?.sessionId === "creative-review-session" && update.messageId) {
        delivered.push(update.messageId);
      }
    });
    try {
      await recoverPendingSessionDeliveries({
        queueContext: context,
        deliver: async (entry) => {
          await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext: context });
        },
        log,
      });
      expect(delivered).toHaveLength(1);
    } finally {
      unsubscribe();
      lifecycle.completeTaskRun({ handle, count: 1 });
    }
  });
});

it("rejects durable review in an incognito requester before generation or queue publication", async () => {
  await withOpenClawTestState({ label: "incognito-review-rejection" }, async () => {
    const key = "agent:main:dashboard:private-review";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: process.env,
    });
    setRuntimeConfigSnapshot({
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { store: storePath },
    });
    const database = { agentId: "main", path: storePath };
    const owner = memorySessionActorOwners.get(database);
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: key },
      { assertCurrent() {}, assertReadable() {} },
    );
    assert(actor.storage);
    const publications = await observeSessionDeliveryPublications();
    try {
      await actor.storage.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "private-review", updatedAt: 1, incognito: true } },
        },
        { assertCurrent() {}, authorize() {} },
      );
      const generate = vi.fn(async () => {
        throw new Error("must not buy an image");
      });
      await expect(
        runMediaGenerationTask({
          lifecycle,
          generationLabel: "image",
          sessionKey: key,
          requesterAgentId: "main",
          deliveryMode: "review",
          prompt: "private request",
          requestKey: "private-review",
          scheduleBackgroundWork: () => {},
          onFailure: () => {},
          run: generate,
        }),
      ).rejects.toThrow("durable chat");
      expect(generate).not.toHaveBeenCalled();
      const tool = createImageGenerateTool(
        { agentSessionKey: key, requesterAgentId: "main" },
        true,
      );
      assert(tool);
      await expect(tool.execute("private-review", { action: "review" })).rejects.toThrow(
        "durable chat",
      );
      expect(publications).toEqual([]);
    } finally {
      await actor.release();
      memorySessionActorOwners.closeDatabase(database);
    }
  });
});
