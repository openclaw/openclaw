import { expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as managedMedia from "./managed-image-attachments.js";
import { createFixture } from "./managed-image-attachments.test-support.js";
import { listManagedImageRecordEntries } from "./managed-image-record-store.js";
import { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";
import { createGeneratedMediaDeliveryEntry } from "./server-restart-sentinel.test-support.js";

it("retains produced media in the owning transcript before delivery settles", async () => {
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
    const { attachmentId, originalPath } = await createFixture(state.stateDir, {
      sessionKey,
      agentId: "main",
      messageId: null,
      body: createSolidPngBuffer(1, 1, { r: 17, g: 34, b: 51 }),
    });
    const url = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const blocks = [{ type: "image", url, openUrl: url }];
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
    let settled = false;
    const outcome = deliverQueuedSessionDelivery({
      deps: {},
      queueContext: captureOpenClawStateWorkerContext(),
      entry: createGeneratedMediaDeliveryEntry({
        id: "produced-media",
        sessionKey,
        messageId: "image:media-completion:agent-loop",
        idempotencyKey: "image:media-completion:agent-loop",
        requesterBinding: binding,
        route: { channel: "webchat", to: sessionKey, chatType: "direct" },
        expectedMediaUrls: [originalPath],
        preparedMediaBlocks: { [originalPath]: blocks },
      }),
    }).finally(() => {
      settled = true;
    });
    try {
      await awaitGateBeforeSettlement(promoting.promise, outcome, "Media promotion never started");
      expect(settled).toBe(false);
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: null, retentionClass: "transient" } },
      ]);
      release.resolve();
      await outcome;
      expect(await listManagedImageRecordEntries({ stateDir: state.stateDir })).toMatchObject([
        { record: { messageId: expect.any(String), retentionClass: "history" } },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([outcome]);
      promotion.mockRestore();
    }
  });
});
