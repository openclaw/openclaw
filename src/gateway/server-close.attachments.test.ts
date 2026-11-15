import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import * as gatewayClose from "./server-close.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
} from "./server-close.test-support.js";

const sharedStateLifecycle = resolveGlobalMap<string, boolean>(
  Symbol("gateway-close-attachment-shared-state"),
  "shared-state",
);
const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory({
  disposeAllBundleLspRuntimes: async () => {},
  stopGmailWatcher: async () => {},
  disposeAllCodeModeRuns: async () => {},
  closeProviderTransportDispatcherPool: async () => {},
  drainRetainedEmbeddingProviders: async () => {},
});
const closeGateway = createGatewayCloseTestHandlerFactory(gatewayClose);

beforeEach(() => {
  sharedStateLifecycle.set("open", true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it("joins detached request attachment cleanup before shared state closes", async () => {
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const attachments = await import("./chat-attachments.js");
  const mediaStore = await import("../media/store.js");
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parsed = await attachments.parseMessageWithAttachments(
      "read this",
      [
        {
          type: "file",
          mimeType: "text/plain",
          fileName: "cleanup.txt",
          content: Buffer.from("synthetic request attachment").toString("base64"),
        },
      ],
      { supportsImages: false },
    );
    const [uploaded] = parsed.offloadedRefs;
    assert(uploaded, "request parser did not offload the attachment");
    const deletionEntered = createDeferredCore();
    const releaseDeletion = createDeferredCore();
    const deleteMediaBuffer = mediaStore.deleteMediaBuffer;
    vi.spyOn(mediaStore, "deleteMediaBuffer").mockImplementation(async (id, subdir) => {
      if (id === uploaded.id) {
        deletionEntered.resolve();
        await releaseDeletion.promise;
      }
      await deleteMediaBuffer(id, subdir);
    });
    const drainEntered = createDeferredCore();
    const media = await import("./server-media-cleanup-lifecycle.js");
    const waitForDrains = media.waitForMediaCleanupDrainsToSettle;
    vi.spyOn(media, "waitForMediaCleanupDrainsToSettle").mockImplementation(() => {
      drainEntered.resolve();
      return waitForDrains();
    });
    const discarded = attachments.discardPreparedInboundMedia(parsed.offloadedRefs);
    await deletionEntered.promise;
    const closing = closeGateway(createGatewayCloseTestDeps())({ reason: "test" });
    let observedDrain: Promise<void> | undefined;
    try {
      await drainEntered.promise;
      let drained = false;
      observedDrain = waitForDrains().then(() => {
        drained = true;
      });
      // The empty owner resolves in this microtask; a retained deletion cannot.
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(sharedStateLifecycle.has("open")).toBe(true);
      expect(await fs.readFile(uploaded.path, "utf8")).toBe("synthetic request attachment");
    } finally {
      releaseDeletion.resolve();
      await discarded;
      await observedDrain;
      await closing;
    }
    await expect(fs.stat(uploaded.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(sharedStateLifecycle.size).toBe(0);
  });
});
