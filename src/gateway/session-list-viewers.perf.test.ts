import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as visibility from "../shared/session-list-visibility.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionListDiagnostics, SessionListPhase } from "./session-list-diagnostics.types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { writeResidentEntries } from "./session-utils.perf.test-support.js";

function viewer(profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: { profileId, displayName: profileId, hasAvatar: false, updatedAt: 1 },
    preparedSessionProfile: { profileId, aliases: new Set([profileId]), role: null },
  };
}

test.skipIf(process.env.OPENCLAW_BENCH_SESSION_VIEWERS !== "1")(
  "benchmarks the resident list and serialization for 50 distinct viewers",
  async () => {
    await withStateDirEnv("openclaw-list-viewers-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const clients = Array.from({ length: 50 }, (_, index) =>
        viewer(ensureProfileForEmail(`viewer-${index}@example.com`).id),
      );
      const store: Record<string, SessionEntry> = Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [
          `agent:main:viewer-row-${index}`,
          {
            sessionId: `viewer-row-${index}`,
            updatedAt: index + 1,
            lastInteractionAt: index + 1,
            visibility: index % 10 === 0 ? "draft" : "shared",
            createdActor: {
              type: "human",
              source: "profile",
              id: clients[index % clients.length]!.authenticatedUserProfile!.profileId,
            },
            ...(index >= 2_300 ? { archivedAt: 1 } : {}),
          },
        ]),
      );
      writeResidentEntries(store);
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const opts = { limit: 60, ownerFirst: true, excludeCron: true, excludeSystem: true };
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const rpcSamples: number[] = [];
      const rpc = async (client: GatewayClient) => {
        let replied = false;
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "benchmark", method: "sessions.list" },
          params: opts,
          client,
          context,
          isWebchatConnect: () => false,
          respond(ok, result) {
            if (!ok) {
              throw new Error("sessions.list benchmark failed");
            }
            JSON.stringify(result);
            replied = true;
          },
        });
        if (!replied) {
          throw new Error("sessions.list did not reply");
        }
      };
      try {
        await projection.ensureMaterialized();
        for (const client of clients) {
          await rpc(client);
        }
        for (let round = 0; round < 5; round++) {
          for (const client of clients) {
            const start = performance.now();
            await rpc(client);
            rpcSamples.push(performance.now() - start);
          }
        }
        const samples: number[] = [];
        const phases = new Map<SessionListPhase | "serialize" | "total", number>();
        for (let round = 0; round < 5; round++) {
          for (const client of clients) {
            let last = performance.now();
            const started = last;
            const diagnostics: SessionListDiagnostics = {
              startSyncCpu: () => undefined,
              finishSyncCpu: () => {},
              mark(phase) {
                const now = performance.now();
                phases.set(phase, (phases.get(phase) ?? 0) + now - last);
                last = now;
              },
              projection: {
                prepareSyncMs: 0,
                rowSyncMs: 0,
                yieldWaitMs: 0,
                yieldCount: 0,
                selectedRowCount: 0,
                dirtyRowCount: 0,
                materializedRowCount: 0,
                reusedRowCount: 0,
              },
            };
            const result = await listProjectedSessions({ projection, client, opts, diagnostics });
            expect(result.count).toBeGreaterThanOrEqual(60);
            const serialize = performance.now();
            JSON.stringify(result);
            phases.set("serialize", (phases.get("serialize") ?? 0) + performance.now() - serialize);
            samples.push(performance.now() - started);
          }
        }
        const inspector = new Session();
        inspector.connect();
        let cloneMs = 0;
        const clone = globalThis.structuredClone;
        const clones = vi
          .spyOn(globalThis, "structuredClone")
          .mockImplementation((value, options) => {
            const start = performance.now();
            try {
              return clone(value, options);
            } finally {
              cloneMs += performance.now() - start;
            }
          });
        try {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
          for (let round = 0; round < 4; round++) {
            for (const client of clients) {
              JSON.stringify(await listProjectedSessions({ projection, client, opts }));
            }
          }
          const { profile } = await inspector.post("Profiler.stop");
          const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
          const self = new Map<string, number>();
          profile.samples?.forEach((id, index) => {
            const name = nodes.get(id)?.callFrame.functionName || "(anonymous)";
            self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1_000);
          });
          console.log(
            JSON.stringify({
              rows: 5_000,
              liveRows: 2_300,
              viewers: clients.length,
              calls: samples.length,
              meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
              medianMs: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
              rpcMeanMs: rpcSamples.reduce((sum, value) => sum + value, 0) / rpcSamples.length,
              rpcMedianMs: rpcSamples.toSorted((a, b) => a - b)[Math.floor(rpcSamples.length / 2)],
              phaseMs: Object.fromEntries(
                [...phases].map(([key, ms]) => [key, ms / samples.length]),
              ),
              profiledCalls: 200,
              cloneCalls: clones.mock.calls.length,
              cloneMsPerCall: cloneMs / 200,
              profileSelfMsPerCall: Object.fromEntries(
                [...self]
                  .toSorted((a, b) => b[1] - a[1])
                  .slice(0, 20)
                  .map(([name, ms]) => [name, ms / 200]),
              ),
            }),
          );
        } finally {
          clones.mockRestore();
          inspector.disconnect();
        }
      } finally {
        projection.dispose();
        release();
      }
    });
  },
  120_000,
);

test("preserves viewer pages across publications while bounding shared predicate work", async () => {
  await withStateDirEnv("openclaw-list-viewer-golden-", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = {
      agents: { entries: { main: {} }, defaults: { thinkingDefault: "off" as const } },
    };
    resetConfigRuntimeState();
    setRuntimeConfigSnapshot(cfg);
    const clients = ["alice", "bob", "admin"].map((name) =>
      viewer(ensureProfileForEmail(`${name}@example.com`).id),
    );
    clients[2]!.connect.scopes = ["operator.admin"];
    const entry = (sessionId: string, owner: number, updatedAt: number): SessionEntry => ({
      sessionId,
      updatedAt,
      createdActor: {
        type: "human",
        source: "profile",
        id: clients[owner]!.authenticatedUserProfile!.profileId,
      },
    });
    const store = {
      "agent:main:a": entry("a", 0, 1),
      "agent:main:b": { ...entry("b", 0, 9), visibility: "draft" as const },
      "agent:main:c": entry("c", 1, 8),
      "agent:main:d": { ...entry("d", 1, 10), archivedAt: 1 },
      "agent:main:f": entry("f", 2, 7),
    };
    writeResidentEntries(store);
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const predicate = vi.spyOn(visibility, "isSystemCreatedSessionRow");
    const opts = { limit: 2, ownerFirst: true, excludeSystem: true };
    const golden = [
      [
        { ids: ["b", "a", "c"], total: 4 },
        { ids: ["c", "f"], total: 3 },
        { ids: ["f", "b", "c"], total: 4 },
      ],
      [
        { ids: ["b", "d"], total: 2 },
        { ids: ["d", "b"], total: 2 },
        { ids: ["f", "d"], total: 3 },
      ],
    ];
    try {
      for (let revision = 0; revision < 2; revision++) {
        // The first viewer primes only viewer-independent membership.
        await listProjectedSessions({ projection, client: clients[0], opts });
        predicate.mockClear();
        for (const [index, client] of clients.entries()) {
          const result = await listProjectedSessions({ projection, client, opts });
          const expected = golden[revision]![index]!;
          expect({
            ids: result.sessions.map((row) => row.sessionId),
            total: result.totalCount,
          }).toEqual(expected);
          expect(result.count).toBe(expected.ids.length);
          expect(result.hasMore).toBe(expected.total > 2);
          expect(result.nextOffset).toBe(expected.total > 2 ? 2 : null);
          expect(result.sessions.map((row) => row.sharingRole)).toEqual(
            expected.ids.map((id) =>
              client === clients[2]
                ? "admin"
                : (client === clients[0] ? ["a", "b"] : ["c", "d"]).includes(id)
                  ? "owner"
                  : "viewer",
            ),
          );
        }
        expect.soft(predicate.mock.calls.length).toBe(0);
        if (revision === 0) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:a" },
            { ...store["agent:main:a"], archivedAt: 2 },
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:b" },
            { ...store["agent:main:b"], visibility: "shared" },
          );
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            archiveTranscript: false,
            target: { canonicalKey: "agent:main:c", storeKeys: ["agent:main:c"] },
          });
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:d" },
            entry("d", 1, 11),
          );
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:f" },
            { ...entry("f", 2, 12), visibility: "draft" },
          );
        }
      }
    } finally {
      predicate.mockRestore();
      projection.dispose();
      release();
    }
  });
});
