import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import * as directWake from "../agents/subagents/announce/subagent-announce-direct-delivery.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createImageGenerateTool } from "../agents/tools/image-generate-tool.js";
import { mediaGenerationCompletionDeliveryKey } from "../agents/tools/media-generate-background-completion.js";
import { createMediaGenerationTaskLifecycle } from "../agents/tools/media-generate-background-shared.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  getGatewayServiceInstallation,
  withGatewayServiceInstallation,
} from "../infra/gateway-service-installation-context.js";
import { startSessionDeliveryRuntime } from "../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import { enqueueUnclaimedSessionDeliveryFixture } from "../infra/session-delivery-queue.test-helpers.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import * as managedMedia from "./managed-image-attachments.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";
import { createScheduledGatewayRunner } from "./scheduled-run-gateway-context.js";
import { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";
import { createGeneratedMediaDeliveryEntry } from "./server-restart-sentinel.test-support.js";

it("promotes produced media before publishing its transcript message and settling delivery", async () => {
  await withOpenClawTestState({ label: "produced-media-delivery" }, async (state) => {
    const sessionKey = "agent:main:media-completion";
    const sessionId = "media-completion-session";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    setRuntimeConfigSnapshot({
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { store: storePath },
    });
    const binding = {
      agentId: "main",
      sessionKey,
      sessionId,
      storePath,
      lifecycleRevision: null,
    };
    await replaceSessionEntry(binding, { sessionId, updatedAt: 1 });
    const originalPath = state.statePath("generated.png");
    await fs.writeFile(originalPath, createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }));
    const blocks = await managedMedia.createManagedOutgoingMediaBlocks({
      sessionKey,
      agentId: "main",
      messageId: null,
      stateDir: state.stateDir,
      localRoots: [state.stateDir],
      items: [{ url: originalPath, trustedLocal: true }],
    });
    const promoting = createDeferred();
    const release = createDeferred();
    const attach = managedMedia.attachManagedOutgoingMediaToMessage;
    const promotion = vi
      .spyOn(managedMedia, "attachManagedOutgoingMediaToMessage")
      .mockImplementationOnce(async (params) => {
        promoting.resolve();
        await release.promise;
        return attach(params);
      });
    const updates: unknown[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
      if (update.target?.sessionId === sessionId) {
        updates.push(update);
      }
    });
    const queueContext = captureOpenClawStateWorkerContext();
    const id = await enqueueUnclaimedSessionDeliveryFixture(
      createGeneratedMediaDeliveryEntry({
        id: "produced-media",
        sessionKey,
        messageId: "image:media-completion:agent-loop",
        idempotencyKey: "image:media-completion:agent-loop",
        requesterBinding: binding,
        route: { channel: "webchat", to: sessionKey, chatType: "direct" },
        expectedMediaUrls: [originalPath],
        preparedMediaBlocks: { [originalPath]: blocks },
      }),
      queueContext,
    );
    const entry = await loadPendingSessionDelivery(id, queueContext);
    assert(entry);
    let settled = false;
    const outcome = deliverQueuedSessionDelivery({ deps: {}, queueContext, entry }).finally(() => {
      settled = true;
    });
    try {
      await awaitGateBeforeSettlement(promoting.promise, outcome, "Media promotion never started");
      expect(settled).toBe(false);
      expect(updates).toEqual([]);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: null, retentionClass: "transient" } },
      ]);
      release.resolve();
      await expect(outcome).resolves.toBeUndefined();
      expect(updates).toEqual([expect.objectContaining({ messageId: expect.any(String) })]);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: expect.any(String), retentionClass: "history" } },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([outcome]);
      unsubscribe();
      promotion.mockRestore();
    }
  });
});

it.each([false, true])(
  "persists approved review media through the running queue, disposed approving attempt=%s",
  async (disposeAttempt) => {
    await withOpenClawTestState({ label: "scheduled-review-release" }, async (state) => {
      const sessionKey = "agent:main:dashboard:review-release";
      const sessionId = "review-release-session";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const binding = {
        agentId: "main",
        sessionKey,
        sessionId,
        storePath,
        lifecycleRevision: null,
      };
      setRuntimeConfigSnapshot({
        agents: { ownership: "explicit", entries: { main: {} } },
        session: { store: storePath },
      });
      await replaceSessionEntry(binding, { sessionId, updatedAt: 1 });
      const originalPath = state.statePath("media", "generated.png");
      await fs.mkdir(state.statePath("media"), { recursive: true });
      await fs.writeFile(originalPath, createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }));
      const wake = vi
        .spyOn(directWake, "sendSubagentAnnounceDirectly")
        .mockRejectedValue(new Error("synthetic reviewer wake"));
      const lifecycle = createMediaGenerationTaskLifecycle("image");
      const handle = await lifecycle.createTaskRun({
        sessionKey,
        requesterAgentId: "main",
        requesterOrigin: { channel: "webchat", to: sessionKey },
        deliveryMode: "review",
        prompt: "One held image",
      });
      assert(handle);
      await expect(
        lifecycle.wakeTaskCompletion({
          handle,
          status: "ok",
          statusLabel: "generated",
          result: "One candidate",
          mediaUrls: [originalPath],
        }),
      ).rejects.toThrow("synthetic reviewer wake");
      lifecycle.completeTaskRun({ handle, count: 1 });
      const context = captureOpenClawStateWorkerContext();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const installation = {
        root: process.cwd(),
        version: VERSION,
        cliVersion: VERSION,
        databasePath: context.admission.databasePath,
      };
      const runDelivery = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "constructing-request" },
        () =>
          withGatewayServiceInstallation({ installation }, () => createScheduledGatewayRunner()),
      );
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const stop = startSessionDeliveryRuntime({
        scheduler,
        queueContext: context,
        log,
        deliver: (entry, { queueContext }) =>
          runDelivery(async () => {
            expect(getGatewayServiceInstallation()).toEqual(installation);
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            await deliverQueuedSessionDelivery({ deps: {}, entry, queueContext });
          }),
      });
      const attempt = createEmbeddedAttemptTranscriptLifecycle({ sessionId });
      try {
        expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toEqual([]);
        const tool = createImageGenerateTool(
          { agentSessionKey: sessionKey, requesterAgentId: "main" },
          true,
        );
        assert(tool);
        await expect(
          withOwnedSessionTranscriptWrites(
            {
              sessionTarget: binding,
              withTranscriptWrite: (write) => attempt.withTranscriptWrite(write),
            },
            () => tool.execute("approve-review", { action: "deliver", taskId: handle.taskId }),
          ),
        ).resolves.toMatchObject({ details: { status: "approved" } });
        if (disposeAttempt) {
          await attempt.dispose();
          await expect(attempt.withTranscriptWrite(() => undefined)).rejects.toThrow(
            "attempt disposed before transcript write",
          );
        }
        await clock.advanceBy(10_000);
        const history = await listManagedImageRecordEntries({ stateDir: state.stateDir });
        const pending = await loadPendingSessionDelivery(
          sha256Hex(mediaGenerationCompletionDeliveryKey("image_generate", handle.taskId)),
          context,
        );
        expect(pending?.lastError).toBeUndefined();
        expect(history).toMatchObject([
          { record: { messageId: expect.any(String), retentionClass: "history" } },
        ]);
        const events = await loadTranscriptEvents(binding);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "assistant",
              [ASSISTANT_DISPLAY_CONTENT_FIELD]: expect.arrayContaining([
                expect.objectContaining({ type: "image" }),
              ]),
            }),
          }),
        );
        expect(
          await loadPendingSessionDelivery(
            sha256Hex(mediaGenerationCompletionDeliveryKey("image_generate", handle.taskId)),
            context,
          ),
        ).toBeNull();
        await clock.advanceBy(10_000);
        expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toHaveLength(1);
      } finally {
        await stop();
        await attempt.dispose();
        await scheduler.stop();
        wake.mockRestore();
      }
    });
  },
);
