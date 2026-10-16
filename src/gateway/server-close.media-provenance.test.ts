import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as provenance from "../media/generated-html-provenance.js";
import { saveMediaBuffer } from "../media/store.js";
import * as webMedia from "../media/web-media.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

it("settles accepted media provenance cleanup across the close prelude before shared-state teardown", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-media-provenance-close");
  const pruningEntered = createDeferred();
  const releasePruning = createDeferred();
  const parentClosed = createDeferred();
  let closing: Promise<void> | undefined;
  let restorePruning: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    const html = Buffer.from("<!doctype html><title>Cleanup close proof</title>");
    const artifact = await saveMediaBuffer(html, "text/html", "outbound", undefined, "proof.html");
    await webMedia.markTrustedGeneratedHtmlPath(artifact.path, html);
    await fs.unlink(artifact.path);
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    let acceptedSignal: AbortSignal | undefined;
    const prune = provenance.pruneGeneratedHtmlProvenance;
    const pruning = vi
      .spyOn(provenance, "pruneGeneratedHtmlProvenance")
      .mockImplementation(async (context) => {
        acceptedSignal = getAsyncWorkSignal();
        pruningEntered.resolve();
        await releasePruning.promise;
        await prune(context);
      });
    restorePruning = () => pruning.mockRestore();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const maintenance = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      scheduler: kernel.scheduler,
      isNixMode: true,
      runManagedOutgoingMediaGc: async () => ({
        deletedRecordCount: 0,
        deletedFileCount: 0,
        retainedCount: 0,
      }),
    });
    kernel.kernel.setMaintenanceHandles(maintenance);
    maintenance.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await withinTest(pruningEntered.promise, signal);
    expect(acceptedSignal?.aborted).toBe(false);

    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    let closed = false;
    closing = server.close({ reason: "media provenance close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        parentClosed.promise,
        closing,
        "Gateway closed before fencing the parent scheduler",
      ),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(acceptedSignal?.aborted).toBe(false);
    expect(shared.isOpen).toBe(true);
    expect(closed).toBe(false);
    maintenance.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(pruning).toHaveBeenCalledOnce();
    expect(shared.isOpen).toBe(true);

    releasePruning.resolve();
    await withinTest(closing, signal);
    expect(shared.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(pruning).toHaveBeenCalledOnce();
    vi.useRealTimers();
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(fixture.state.env), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT realpath FROM outbound_media_provenance").all()).toEqual([]);
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    releasePruning.resolve();
    await Promise.allSettled([closing]);
    restorePruning?.();
    await fixture.cleanup();
  }
});
