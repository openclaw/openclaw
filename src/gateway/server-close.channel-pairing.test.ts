import assert from "node:assert/strict";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateReader from "../state/openclaw-state-read-worker.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it("joins an accepted pairing reader through the real Gateway close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-pairallow-close");
  const cleanupEntered = createDeferredCore();
  const releaseCleanup = createDeferredCore();
  const preludeEntered = createDeferredCore();
  let reading: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const observed: unknown[] = [];
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const capture = stateReader.captureOpenClawStateReadSource;
    vi.spyOn(stateReader, "captureOpenClawStateReadSource").mockImplementation(() => {
      const source = capture();
      return {
        ...source,
        createTransport(command) {
          const transport = source.createTransport(command);
          if (command.type !== "pairing.allowFrom") {
            return transport;
          }
          const cleanup = createRetainedOperation<void>(() => {});
          let started = false;
          return {
            ...transport,
            startRead(location, authority) {
              const operation = transport.startRead(location, authority);
              void operation.result.then(
                (outcome) => observed.push(outcome),
                (error: unknown) => observed.push(error),
              );
              return operation;
            },
            startClose() {
              if (!started) {
                started = true;
                cleanupEntered.resolve();
                void releaseCleanup.promise
                  .then(() => transport.startClose().result)
                  .then(cleanup.resolve, cleanup.reject);
              }
              return cleanup.operation;
            },
          };
        },
      };
    });
    reading = readChannelAllowFromStore("demo", fixture.state.env, "alpha").catch(
      (error: unknown) => error,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        cleanupEntered.promise,
        reading,
        "Pairing read bypassed retained cleanup",
      ),
      signal,
    );
    expect(observed).toMatchObject([
      { value: { ok: true, type: "pairing.allowFrom", entries: [] } },
    ]);
    kernel.scheduler.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "pairing read close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(preludeEntered.promise, closing, "Gateway skipped close prelude"),
      signal,
    );
    expect(closed).toBe(false);
    expect(shared.isOpen).toBe(true);
    releaseCleanup.resolve();
    await withinTest(Promise.all([reading, closing]), signal);
    expect(shared.isOpen).toBe(false);
  } finally {
    releaseCleanup.resolve();
    await Promise.allSettled([reading, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
