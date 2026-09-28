import { channel } from "node:diagnostics_channel";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";

it.runIf(process.env.OPENCLAW_SESSION_PUBLICATIONS_BENCH === "1")(
  "measures 8,000 resident rows with ten appends and three list calls per simulated second",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      setRuntimeConfigSnapshot(cfg);
      const clients = [0, 1, 2].map((index) =>
        identifiedClient(ensureProfileForEmail(`list-bench-${index}@example.test`).id),
      );
      writeResidentEntries(
        Object.fromEntries(
          Array.from({ length: 8_000 }, (_, index) => [
            `agent:main:dashboard:bench-${index}`,
            {
              sessionId: `bench-${index}`,
              updatedAt: index + 1,
              visibility: "shared" as const,
            },
          ]),
        ),
      );
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const diagnostics = channel("openclaw.session.list");
      const samples: {
        prepareThreadCpuMs: number;
        rowThreadCpuMs: number;
        responseThreadCpuMs: number;
        phaseDurationsMs: Record<string, number>;
      }[] = [];
      const collect = (sample: unknown) => samples.push(sample as (typeof samples)[number]);
      const cpuSamples: number[] = [];
      const scans = vi.spyOn(projection, "selectEntries");
      let calls = 0;
      const rpc = async (client: (typeof clients)[number]) => {
        const cpu = process.threadCpuUsage();
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "benchmark", method: "sessions.list" },
          params: {},
          client,
          context,
          isWebchatConnect: () => false,
          respond(ok, result) {
            expect(ok).toBe(true);
            const page = result as SessionsListResult;
            expect(page.sessions).toHaveLength(100);
            expect(page.totalCount).toBe(8_000);
            JSON.stringify(page);
          },
        });
        const used = process.threadCpuUsage(cpu);
        cpuSamples.push((used.user + used.system) / 1_000);
        calls++;
      };
      try {
        await projection.ensureMaterialized();
        for (let warmup = 0; warmup < 5; warmup++) {
          for (const client of clients) {
            await rpc(client);
          }
        }
        calls = 0;
        cpuSamples.length = 0;
        scans.mockClear();
        diagnostics.subscribe(collect);
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        for (let tick = 0; tick < 240; tick++) {
          const index = 7_997 + (tick % 3);
          const target = {
            agentId: "main",
            sessionId: `bench-${index}`,
            sessionKey: `agent:main:dashboard:bench-${index}`,
          };
          runOpenClawAgentWriteTransaction(
            (database) =>
              appendTranscriptEventsInTransaction(database, target, [
                {
                  type: "message",
                  id: `append-${tick}`,
                  message: { role: "assistant", content: "Synthetic stream" },
                },
              ]),
            { agentId: "main" },
          );
          emitSessionTranscriptUpdate({ target });
          await vi.advanceTimersByTimeAsync(100);
          await projection.ensureMaterialized();
          const clientIndex = [0, 3, 6].indexOf(tick % 10);
          if (clientIndex >= 0) {
            await rpc(clients[clientIndex]!);
          }
        }
        const mean = (values: number[]) =>
          values.reduce((sum, value) => sum + value, 0) / values.length;
        const broadScans = scans.mock.calls.filter(([query]) => !query?.key).length;
        console.log(
          JSON.stringify({
            rows: 8_000,
            appends: 240,
            calls,
            broadScans,
            selectionCacheHitRate: 1 - broadScans / calls,
            handlerCpuMs: mean(cpuSamples),
            prepareCpuMs: mean(samples.map((sample) => sample.prepareThreadCpuMs)),
            rowCpuMs: mean(samples.map((sample) => sample.rowThreadCpuMs)),
            responseCpuMs: mean(samples.map((sample) => sample.responseThreadCpuMs)),
            handlerExitMs: mean(samples.map((sample) => sample.phaseDurationsMs.handlerExit ?? 0)),
          }),
        );
        expect(broadScans).toBe(0);
      } finally {
        diagnostics.unsubscribe(collect);
        scans.mockRestore();
        projection.dispose();
        release();
        vi.useRealTimers();
      }
    });
  },
  120_000,
);
