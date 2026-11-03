import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { captureGatewayRootWorkReleaseObserver } from "../../process/gateway-work-admission.js";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  FollowupRunDeferredError,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
describe("followup queue collect heartbeat recovery", () => {
  it.for(["collect", "overflow"] as const)(
    "resumes %s source heartbeats when preparation failure becomes a capacity wait",
    async (mode, { signal }) => {
      vi.useFakeTimers();
      vi.stubEnv("OPENCLAW_TEST_FAST", "0");
      const q = createQueueCase({
        mode: mode === "collect" ? "collect" : "followup",
        cap: mode === "collect" ? 2 : 1,
        debounceMs: 10,
      });
      const releaseAdoption = createDeferred();
      const sources = ["first source", "second source"].map((prompt) => ({
        prompt,
        heartbeat: vi.fn(),
        adopted: vi.fn(async () => {}),
        enqueued: vi.fn(),
      }));
      let attempts = 0;
      let drainReleased: Promise<void> | undefined;
      try {
        for (const source of sources) {
          q.add({
            ...createRun({ prompt: source.prompt, originatingChannel: "webchat" }),
            turnAdoptionLifecycle: {
              admission: "cancel-only",
              onDeferred: source.enqueued,
              onAdopted: source.adopted,
              onDeferredHeartbeat: source.heartbeat,
              deferredHeartbeatIntervalMs: 2,
            },
          });
        }
        if (mode === "overflow") {
          q.add(createRun({ prompt: "live item", originatingChannel: "webchat" }));
        }
        q.start(async (run) => {
          const released = createDeferred();
          captureGatewayRootWorkReleaseObserver()?.(() => released.resolve());
          drainReleased = released.promise;
          if (run.prompt !== "live item") {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("ENOSPC: preparation failed");
            }
            if (attempts === 2) {
              throw new FollowupRunDeferredError("reply lane busy");
            }
            await releaseAdoption.promise;
          }
          await admitFollowupRunLifecycle(run);
          completeFollowupRunLifecycle(run);
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(attempts).toBe(1);
        const stoppedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(5);
        expect(sources.map((source) => source.heartbeat.mock.calls.length)).toEqual(stoppedCounts);
        await vi.advanceTimersByTimeAsync(15);
        expect(attempts).toBe(3);
        const resumedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(40);
        for (const [index, source] of sources.entries()) {
          expect(source.heartbeat.mock.calls.length).toBeGreaterThan(resumedCounts[index]!);
          expect(source.enqueued).toHaveBeenCalledOnce();
        }
        releaseAdoption.resolve();
        expect(drainReleased).toBeDefined();
        await withinTest(drainReleased!, signal);
        const adoptedCounts = sources.map((source) => source.heartbeat.mock.calls.length);
        await vi.advanceTimersByTimeAsync(40);
        expect(sources.map((source) => source.heartbeat.mock.calls.length)).toEqual(adoptedCounts);
        for (const source of sources) {
          expect(source.adopted).toHaveBeenCalledOnce();
        }
        expect(getExistingFollowupQueue(q.key)).toBeUndefined();
      } finally {
        releaseAdoption.resolve();
        clearFollowupQueue(q.key);
        await drainReleased;
        vi.unstubAllEnvs();
        vi.useRealTimers();
      }
    },
  );
});
