import { channel } from "node:diagnostics_channel";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

test.skipIf(process.env.OPENCLAW_BENCH_SESSION_COLD !== "1")(
  "measures three simultaneous first lists against a cold 5000-row catalog",
  async () => {
    await withStateDirEnv("openclaw-list-cold-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      resetConfigRuntimeState();
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      setRuntimeConfigSnapshot(cfg);
      const entries: Record<string, SessionEntry> = Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [
          `agent:main:cold-${index}`,
          {
            sessionId: `cold-${index}`,
            updatedAt: index + 1,
            lastInteractionAt: index + 1,
            ...(index >= 2_300 ? { archivedAt: 1 } : {}),
          },
        ]),
      );
      writeResidentEntries(entries);
      const release = retainSessionListForegroundWork();
      const delay = monitorEventLoopDelay({ resolution: 1 });
      delay.enable();
      await yieldToEventLoop();
      const startup = performance.now();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const startupMs = performance.now() - startup;
      const startupLoopMaxMs = delay.max / 1e6;
      delay.reset();
      const context = requestContext(cfg);
      bindSessionRowProjection(context, () => projection);
      const diagnostics = channel("openclaw.session.list");
      const messages: unknown[] = [];
      const record = (message: unknown) => messages.push(message);
      diagnostics.subscribe(record);
      const reads = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
      const before = projection.materializedCount;
      const started = performance.now();
      const cpu = process.threadCpuUsage();
      const counts: number[] = [];
      try {
        await Promise.all(
          Array.from({ length: 3 }, async (_, index) => {
            await sessionReadHandlers["sessions.list"]!({
              req: { type: "req", id: `cold-${index}`, method: "sessions.list" },
              params: { limit: 60 },
              client: null,
              context,
              isWebchatConnect: () => false,
              respond(ok, result) {
                expect(ok).toBe(true);
                expect(result).toMatchObject({ count: 60, totalCount: 2_300 });
                JSON.stringify(result);
                counts.push(projection.materializedCount - before);
              },
            });
          }),
        );
        const used = process.threadCpuUsage(cpu);
        const elapsedMs = performance.now() - started;
        // Let the delay sampler observe the final response turn.
        await yieldToEventLoop();
        await yieldToEventLoop();
        console.log(
          JSON.stringify({
            rows: 5_000,
            liveRows: 2_300,
            callers: 3,
            startupMs,
            startupLoopMaxMs,
            elapsedMs,
            threadCpuMs: (used.user + used.system) / 1e3,
            loopMaxMs: delay.max / 1e6,
            loopP99Ms: delay.percentile(99) / 1e6,
            workerReads: reads.mock.calls.length,
            materializedAtResponse: counts,
            diagnostics: messages,
          }),
        );
        expect(counts).toHaveLength(3);
        expect(messages).toHaveLength(3);
      } finally {
        reads.mockRestore();
        diagnostics.unsubscribe(record);
        delay.disable();
        projection.dispose();
        release();
      }
    });
  },
  120_000,
);
