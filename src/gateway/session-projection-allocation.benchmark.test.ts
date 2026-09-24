import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

// Opt-in profiling fixture: excluded from routine test cost; run on a Testbox.
it.skipIf(process.env.OPENCLAW_ALLOCATION_BENCH !== "1")(
  "profiles 5,000 rows across 50 viewers",
  async () => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const entries = Array.from({ length: 5_000 }, (_, index) => ({
        sessionId: `allocation-${index}`,
        updatedAt: Date.now() - index,
        label: `Session ${index}`,
        status: "done" as const,
      }));
      entries.forEach((entry, index) =>
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: `agent:main:allocation-${index}` },
          entry,
        ),
      );
      const context = requestContext(cfg);
      const wire: string[] = [];
      const clients = Array.from({ length: 50 }, (_, index) =>
        Object.assign(identifiedClient(`viewer-${index}`), {
          connId: `viewer-${index}`,
          usesSharedGatewayAuth: false,
          authenticatedUserProfile: {
            profileId: `viewer-${index}`,
            displayName: `viewer-${index}`,
            avatarRevision: "1",
            hasAvatar: false,
            updatedAt: 1,
          },
          socket: {
            readyState: 1,
            bufferedAmount: 0,
            send: (frame: string) => {
              if (index < 3) {
                wire[index] = frame;
              }
            },
            close() {},
          } as unknown as GatewayWsClient["socket"],
        }),
      );
      const request = { configuredAgentsOnly: true, limit: 100 };
      const list = (index: number) =>
        listSessions({ client: clients[index % 50]!, context, request });
      await list(0);
      const projection = getSessionRowProjection(context)!;
      const connection = createGatewayConnectionState({ bootId: "allocation", cfg });
      const detach = connection.attachSessionRowProjection(projection);
      clients.forEach((client) => connection.clients.add(client));
      const connIds = new Set(clients.map((client) => client.connId));
      const refresh = () =>
        connection.broadcastToConnIds(
          "sessions.changed",
          { sessionKey: "agent:main:allocation-0", agentId: "main", reason: "benchmark" },
          connIds,
        );
      const inspector = new Session();
      inspector.connect();
      try {
        for (let index = 0; index < 50; index++) {
          await list(index);
        }
        for (let index = 0; index < 50; index++) {
          refresh();
        }
        const golden: string[] = [];
        for (const revision of [1, 2]) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:allocation-0" },
            { ...entries[0]!, label: `Revision ${revision}` },
          );
          await projection.ensureMaterialized();
          for (let index = 0; index < 3; index++) {
            const result = await list(index);
            expect(result.sessions[0]?.label).toBe(`Revision ${revision}`);
            expect(result.totalCount).toBe(5_000);
            // A fixed clock preserves every serialized row byte, including property order.
            golden.push(createHash("sha256").update(JSON.stringify(result.sessions)).digest("hex"));
          }
          refresh();
          for (let index = 0; index < 3; index++) {
            const frame = JSON.parse(wire[index]!);
            expect(frame.payload.session.label).toBe(`Revision ${revision}`);
            golden.push(createHash("sha256").update(JSON.stringify(frame.payload)).digest("hex"));
          }
        }
        // Captured from the unchanged owner at b6a449c84a9: three viewers, two revisions.
        expect
          .soft(golden)
          .toEqual(
            [
              "151f22796650c322b4ca3f229031b4fc8135178ac5d021504ddfa1dd8d68c615",
              "e4b8b9478db07c2fe02fb7360d636f8504f8fdb4fc6f1ee89b5ad13a609f3823",
              "c00e5ca642060f28731e4dea89aa264e06475a551bfd5f3dec08f4f5a895a1ce",
              "b92215f9f344e28b4512f4ea9c223b2a4ce0e50f464f0ccf683996a21f5f4290",
            ].flatMap((hash) => [hash, hash, hash]),
          );
        await inspector.post("HeapProfiler.enable");
        await inspector.post("Profiler.enable");
        for (const phase of ["list", "refresh"] as const) {
          const calls = 1_000;
          await inspector.post("HeapProfiler.collectGarbage");
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          await inspector.post("Profiler.start");
          const start = performance.now();
          for (let index = 0; index < calls; index++) {
            if (phase === "list") {
              await list(index);
            } else {
              refresh();
            }
          }
          const elapsedMs = performance.now() - start;
          const { profile: cpu } = await inspector.post("Profiler.stop");
          const { profile: heap } = await inspector.post("HeapProfiler.stopSampling");
          const sites = new Map<string, number>();
          function visit(node: typeof heap.head) {
            const frame = node.callFrame;
            const name = `${frame.functionName} ${frame.url.split("/").slice(-2).join("/")}:${frame.lineNumber + 1}`;
            sites.set(name, (sites.get(name) ?? 0) + node.selfSize);
            node.children.forEach(visit);
          }
          visit(heap.head);
          const totalBytes = [...sites.values()].reduce((a, b) => a + b, 0);
          const gc = new Set(
            cpu.nodes
              .filter((node) => node.callFrame.functionName === "(garbage collector)")
              .map((node) => node.id),
          );
          const samples = cpu.samples ?? [];
          console.log(
            JSON.stringify({
              phase,
              calls,
              viewers: 50,
              rows: 5_000,
              elapsedMs,
              bytesPerCall: Math.round(totalBytes / calls),
              sampledBytesPerSecond: Math.round((totalBytes * 1_000) / elapsedMs),
              gcPercent: (100 * samples.filter((id) => gc.has(id)).length) / samples.length,
              sites: [...sites].toSorted((a, b) => b[1] - a[1]).slice(0, 15),
            }),
          );
          await inspector.post("Profiler.start");
          const cpuStart = performance.now();
          let cpuCalls = 0;
          do {
            if (phase === "list") {
              await list(cpuCalls);
            } else {
              refresh();
            }
            cpuCalls++;
          } while (performance.now() - cpuStart < 5_000);
          const { profile } = await inspector.post("Profiler.stop");
          const nodes = new Map(
            profile.nodes.map((node) => [node.id, node.callFrame.functionName]),
          );
          let busyUs = 0;
          let gcUs = 0;
          profile.samples?.forEach((id, index) => {
            const name = nodes.get(id);
            const us = profile.timeDeltas?.[index] ?? 0;
            if (name !== "(idle)") {
              busyUs += us;
            }
            if (name === "(garbage collector)") {
              gcUs += us;
            }
          });
          console.log(
            JSON.stringify({
              phase,
              cpuCalls,
              cpuDurationMs: (profile.endTime - profile.startTime) / 1_000,
              busyMs: busyUs / 1_000,
              gcBusyPercent: (100 * gcUs) / busyUs,
            }),
          );
        }
      } finally {
        inspector.disconnect();
        detach();
        await connection.mentionInbox.dispose();
      }
    });
  },
  120_000,
);
