import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";

describe("lazy media generation scheduler loading", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("detaches completion work without bypassing cancellation for ordinary owned work", async () => {
    vi.resetModules();
    const schedulerReady = createDeferred();
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    const ownedStarted = createDeferred();
    const parent = new AsyncWorkScope();
    const requestContext = new AsyncLocalStorage<string>();
    let backgroundSignal: AbortSignal | undefined;
    let backgroundRequestContext: string | undefined;
    let ownedCancelled = false;

    requestContext.run("matrix-monitor-task", () => {
      void parent.track(async () => {
        const { createDefaultMediaGenerateBackgroundScheduler } =
          await import("./media-generate-background-shared.js");
        const schedule = createDefaultMediaGenerateBackgroundScheduler({
          toolName: "image_generate",
          onCrash: vi.fn(),
        });
        schedule(async () => {
          await trackAsyncWork(async () => {
            backgroundSignal = getAsyncWorkSignal();
            backgroundRequestContext = requestContext.getStore();
            backgroundStarted.resolve();
            await releaseBackground.promise;
          });
        });
        void trackAsyncWork(async () => {
          const signal = getAsyncWorkSignal();
          ownedStarted.resolve();
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                ownedCancelled = true;
                resolve();
              },
              { once: true },
            );
          });
        });
        schedulerReady.resolve();
      });
    });

    await schedulerReady.promise;
    await Promise.all([backgroundStarted.promise, ownedStarted.promise]);
    const drain = parent.drain();
    const drainedBeforeBackground = await Promise.race([
      drain.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 100);
      }),
    ]);
    try {
      expect(drainedBeforeBackground).toBe(true);
      expect(ownedCancelled).toBe(true);
      expect(backgroundSignal).toBeUndefined();
      expect(backgroundRequestContext).toBeUndefined();
    } finally {
      releaseBackground.resolve();
      await drain;
    }
  });
});
