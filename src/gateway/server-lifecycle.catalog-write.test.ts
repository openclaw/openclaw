import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("settles an accepted catalog refresh before Gateway close retires its state writer", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-catalog-write-close");
  const accepted = createDeferredCore();
  const release = createDeferredCore();
  const parentClosed = createDeferredCore();
  let refreshing: ReturnType<typeof refreshRemoteModelCatalog> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const lifecycle = createGatewayUpdateLifecycle(kernel.scheduler);
    kernel.runtimeState.stopGatewayUpdateCheck = lifecycle.stop;
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const bundle = {
      schemaVersion: 2,
      sourceCommit: "synthetic",
      generatedAt: 1_753_500_000_000,
      providers: { anthropic: {} },
      models: [{ id: "catalog-close", provider: "anthropic", pricing: { status: "unknown" } }],
    };
    const run = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "modelCatalog.remote.write") {
                  accepted.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
    );
    refreshing = lifecycle.run((catalogSignal) =>
      refreshRemoteModelCatalog({
        config: {},
        force: true,
        signal: catalogSignal,
        databaseOptions: { env: fixture.state.env },
        bundledGeneratedAt: () => bundle.generatedAt - 1,
        fetchImpl: async () => new Response(JSON.stringify(bundle)),
      }),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        accepted.promise,
        refreshing,
        "Catalog refresh settled before handing its accepted write to the state worker",
      ),
      signal,
    );
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), {
      once: true,
    });
    closing = server.close({ reason: "catalog write close regression" });
    await withinTest(parentClosed.promise, signal);
    expect(lifecycle.signal.aborted).toBe(true);
    const lateWork = vi.fn(async () => undefined);
    await expect(lifecycle.run(lateWork)).rejects.toThrow();
    expect(lateWork).not.toHaveBeenCalled();
    expect(shared.isOpen).toBe(true);
    release.resolve();
    await expect(refreshing).resolves.toMatchObject({
      status: "updated",
      generatedAt: bundle.generatedAt,
    });
    await closing;
    expect(shared.isOpen).toBe(false);
    expect(
      JSON.parse(readRemoteModelCatalog({ env: fixture.state.env })?.bundle_json ?? "null"),
    ).toEqual(bundle);
  } finally {
    release.resolve();
    await Promise.allSettled([refreshing, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
