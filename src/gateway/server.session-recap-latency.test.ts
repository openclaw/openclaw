import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { assert, expect, onTestFinished, test, vi } from "vitest";
import { WebSocket } from "ws";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { GatewayBrowserClient, type GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import { createSessionCapability as createBaseline } from "../../ui/src/lib/sessions/index.recap-latency-baseline.test-support.ts";
import { createSessionCapability } from "../../ui/src/lib/sessions/index.ts";
import { createGatewayHarness } from "../../ui/src/lib/sessions/session-capability.test-support.ts";
import * as listQueries from "../../ui/src/lib/sessions/session-list-query.ts";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { broadcastSessionActivitySummary } from "./session-activity-summary-events.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";
import { installGatewayTestHooks } from "./test-helpers.js";

// Temporary, synthetic investigation. Both subjects use the same real wire frames.
// The baseline file is the exact frozen owner; only the recap branch differs.
let harness: Awaited<ReturnType<typeof startGatewayServerHarness>>;
let kernel: Awaited<ReturnType<typeof captureGatewayKernel>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    kernel = await captureGatewayKernel(async () => {
      harness = await startGatewayServerHarness();
    });
    await waitForGatewayStartup(harness.port);
  },
  cleanup: async () => harness?.close(),
});

type Sample = {
  pair: number;
  variant: string;
  phase: string;
  wallMs: number[];
  cpuMs: number[];
};
const isRecap = (event: GatewayEventFrame) =>
  event.event === "sessions.changed" &&
  (event.payload as { reason?: string } | null)?.reason === "activity-summary";

test("measures real recap delivery with populated and empty managed rosters", async () => {
  vi.stubGlobal("WebSocket", WebSocket);
  vi.stubGlobal("navigator", { platform: "node", userAgent: "synthetic-recap-investigation" });
  const loadStart = loadavg();
  const ready = Promise.withResolvers<void>();
  const receivers = new Set<(event: GatewayEventFrame) => void>();
  const cleanup: (() => void)[] = [];
  let expectedDelivery:
    | { remaining: Set<string>; done: ReturnType<typeof Promise.withResolvers<void>> }
    | undefined;
  let requests = 0;
  const client = new GatewayBrowserClient({
    url: `ws://127.0.0.1:${harness.port}`,
    clientName: "cli",
    mode: "cli",
    platform: "node",
    onHello: () => ready.resolve(),
    onClose: (info) => {
      const error = new Error(`Synthetic client closed: ${info.code}`);
      ready.reject(error);
      expectedDelivery?.done.reject(error);
    },
    onEvent: (event) => {
      for (const receive of receivers) {
        receive(event);
      }
    },
    onRequestTiming: () => {
      requests += 1;
    },
  });
  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    const error = new Error("Synthetic recap fixture disposed");
    ready.reject(error);
    expectedDelivery?.done.reject(error);
    expectedDelivery = undefined;
    while (cleanup.length) {
      cleanup.pop()!();
    }
    receivers.clear();
    client.stop();
  };
  onTestFinished(stop);
  client.start();
  const samples: Sample[] = [];
  const counts: { variant: string; calls: number; windows: number }[] = [];
  try {
    await ready.promise;
    const keys = Array.from({ length: 64 }, (_, index) => `agent:main:synthetic-recap-${index}`);
    for (const key of keys) {
      await client.request("sessions.create", { key, agentId: "main", visibility: "shared" });
    }
    const projection = getSessionRowProjection(kernel.gatewayRequestContext);
    assert(projection, "Expected admitted session projection");
    const loaded = await loadGatewaySessionEntryReadOnlyAsync(keys[0]!, { agentId: "main" });
    expect(await client.request("sessions.subscribe", {})).toMatchObject({ subscribed: true });
    const deliveryReceipt = (event: GatewayEventFrame) => {
      if (!isRecap(event) || !expectedDelivery) {
        return;
      }
      const key = (event.payload as { sessionKey: string }).sessionKey;
      expectedDelivery.remaining.delete(key);
      if (!expectedDelivery.remaining.size) {
        expectedDelivery.done.resolve();
      }
    };
    receivers.add(deliveryReceipt);
    const publish = async (selected: string[]) => {
      const receipt = { remaining: new Set(selected), done: Promise.withResolvers<void>() };
      expectedDelivery = receipt;
      void receipt.done.promise.catch(() => {});
      await Promise.all(
        selected.map((key) =>
          broadcastSessionActivitySummary(
            { key, agentId: "main", storePath: loaded.storePath },
            {
              getSessionRowProjection: () => projection,
              broadcast: kernel.gatewayRequestContext.broadcast,
            },
          ),
        ),
      );
      await receipt.done.promise;
      expectedDelivery = undefined;
      // Drain request timing and non-recap events before checking counters.
      await client.request("health", {});
    };
    for (let pair = 0; pair < 6; pair += 1) {
      const subjects = [];
      const variants =
        pair % 2 === 0
          ? ["baseline-populated", "candidate-populated", "baseline-empty", "candidate-empty"]
          : ["candidate-empty", "baseline-empty", "candidate-populated", "baseline-populated"];
      for (const variant of variants) {
        const adapter = createGatewayHarness(client);
        const factory = variant.startsWith("baseline") ? createBaseline : createSessionCapability;
        const sessions = factory(adapter.gateway, {
          state: { selectedId: "main" },
          subscribe: () => () => {},
        });
        cleanup.push(() => sessions.dispose());
        await sessions.refresh({
          agentId: "main",
          archivedFilter: "all",
          rowMode: "sidebar",
          limit: 64,
        });
        const windows = [];
        if (variant.endsWith("populated")) {
          for (let index = 0; index < 32; index += 1) {
            const scope = {
              agentId: "main",
              archivedFilter: "all" as const,
              rowMode: "sidebar" as const,
              limit: index + 1,
            };
            const window = sessions.observeList(scope, () => {});
            windows.push({ scope, window });
            await window.refresh();
            expect(sessions.listSnapshot(scope)).toMatchObject({ error: null });
            expect(sessions.listSnapshot(scope).result?.sessions.length).toBeGreaterThan(0);
          }
        }
        let delivered = 0;
        let applied = 0;
        const row = sessions.observeRow({ key: keys[0]!, agentId: "main" }, () => {}, {
          onEvent: (_event, result) => {
            applied += Number(result.applied);
            delivered += 1;
          },
        });
        const subject = {
          variant,
          sessions,
          adapter,
          windows,
          row,
          phase: "first-delivery",
          wallMs: [] as number[],
          cpuMs: [] as number[],
          readDelivered: () => delivered,
          readApplied: () => applied,
        };
        const receive = (event: GatewayEventFrame) => {
          if (!isRecap(event)) {
            adapter.emitEvent(event);
            return;
          }
          const cpu = process.cpuUsage();
          const start = performance.now();
          adapter.emitEvent(event);
          const wallMs = performance.now() - start;
          const spent = process.cpuUsage(cpu);
          subject.wallMs.push(wallMs);
          subject.cpuMs.push((spent.user + spent.system) / 1000);
        };
        receivers.add(receive);
        cleanup.push(() => {
          receivers.delete(receive);
          row.dispose();
          windows.forEach(({ window }) => window.dispose());
        });
        subjects.push(subject);
      }
      // Finish setup RPCs before capturing identities and counters.
      await client.request("health", {});
      const identities = subjects.map((subject) => ({
        primary: subject.sessions.state.result,
        windows: subject.windows.map(({ scope }) => subject.sessions.listSnapshot(scope).result),
      }));
      const requestStart = requests;
      for (const phase of ["first-delivery", "warm"]) {
        for (const subject of subjects) {
          Object.assign(subject, { phase, wallMs: [], cpuMs: [] });
        }
        await publish(phase === "first-delivery" ? [keys[0]!] : keys);
        for (const subject of subjects) {
          expect(subject.wallMs.length).toBe(phase === "first-delivery" ? 1 : keys.length);
          samples.push({
            pair,
            variant: subject.variant,
            phase,
            wallMs: subject.wallMs,
            cpuMs: subject.cpuMs,
          });
        }
      }
      // Two explicit health barriers are the only requests made by recap delivery.
      expect(requests - requestStart).toBe(2);
      subjects.forEach((subject, index) => {
        expect(subject.sessions.state.result).toBe(identities[index]!.primary);
        subject.windows.forEach(({ scope }, windowIndex) => {
          expect(subject.sessions.listSnapshot(scope).result).toBe(
            identities[index]!.windows[windowIndex],
          );
        });
        expect(subject.readDelivered()).toBe(65);
        expect(subject.readApplied()).toBe(0);
      });
      if (pair === 0) {
        const original = listQueries.sessionListsNeedingEventRefresh;
        let current: (typeof counts)[number] | undefined;
        const spy = vi
          .spyOn(listQueries, "sessionListsNeedingEventRefresh")
          .mockImplementation((entries, ...args) => {
            const counted = function* () {
              for (const entry of entries) {
                if (current) {
                  current.windows += 1;
                }
                yield entry;
              }
            };
            if (current) {
              current.calls += 1;
            }
            return original(counted(), ...args);
          });
        try {
          for (const subject of subjects) {
            const result = { variant: subject.variant, calls: 0, windows: 0 };
            counts.push(result);
            const receive = (event: GatewayEventFrame) => {
              if (!isRecap(event)) {
                return;
              }
              current = result;
              subject.adapter.emitEvent(event);
              current = undefined;
            };
            // Isolate work counting from measured delivery and other subjects.
            const measured = [...receivers];
            receivers.clear();
            receivers.add(deliveryReceipt);
            receivers.add(receive);
            try {
              await publish([keys[0]!]);
            } finally {
              receivers.clear();
              measured.forEach((item) => receivers.add(item));
            }
          }
        } finally {
          spy.mockRestore();
        }
        expect(counts.find((item) => item.variant === "baseline-populated")?.windows).toBe(32);
        expect(
          counts
            .filter((item) => item.variant.startsWith("candidate"))
            .every((item) => item.calls === 0),
        ).toBe(true);
      }
      while (cleanup.length) {
        cleanup.pop()!();
      }
    }
    const statistics = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      assert(sorted.length > 0);
      return {
        median:
          sorted.length % 2
            ? sorted[Math.floor(sorted.length / 2)]!
            : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        min: sorted[0]!,
        max: sorted.at(-1)!,
        n: sorted.length,
      };
    };
    const table = [];
    const regressions: string[] = [];
    let warmGain = 0;
    for (const sample of samples) {
      console.log("RECAP_LATENCY_SAMPLE " + JSON.stringify(sample));
    }
    for (const phase of ["first-delivery", "warm"]) {
      for (const shape of ["populated", "empty"]) {
        for (const metric of ["wallMs", "cpuMs"] as const) {
          const values = (variant: string) =>
            samples
              .filter(
                (sample) => sample.phase === phase && sample.variant === `${variant}-${shape}`,
              )
              .flatMap((sample) => sample[metric]);
          const baseline = statistics(values("baseline"));
          const candidate = statistics(values("candidate"));
          table.push({ phase, shape, metric, baseline, candidate });
          for (const quantile of ["median", "p95"] as const) {
            if (
              candidate[quantile] >= baseline[quantile] * 1.2 &&
              candidate[quantile] > baseline[quantile]
            ) {
              regressions.push(`${phase}/${shape}/${metric}/${quantile}`);
            }
          }
          if (phase === "warm" && shape === "populated" && metric === "wallMs") {
            warmGain = baseline.median > 0 ? 1 - candidate.median / baseline.median : 0;
          }
        }
      }
    }
    console.log(
      "RECAP_LATENCY_MEASUREMENTS " +
        JSON.stringify({
          runtime: process.version,
          platform: process.platform,
          cpus: cpus().length,
          loadStart,
          loadEnd: loadavg(),
          keys: 64,
          managedWindows: 32,
          coldDefinition:
            "first recap on a freshly constructed capability; process and transport already warm",
          metric:
            "synchronous decoded-event entry through real session capability; wire and producer debounce excluded",
          table,
          counts,
          warmGain,
          regressions,
        }),
    );
    expect(regressions).toEqual([]);
    expect(warmGain).toBeGreaterThanOrEqual(0.1);
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
}, 60_000);
