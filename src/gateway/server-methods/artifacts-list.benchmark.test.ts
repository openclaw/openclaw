import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { seedTeamShapeSessions } from "../../../scripts/perf/team-shape-sessions.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { artifactsHandlers } from "./artifacts.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { listSessionBranchesForGateway } from "./sessions-branches-list.js";
import type { RespondFn } from "./types.js";

it.each(["default", "custom", "configured alias", "selected alias"] as const)(
  "retains the artifact history reader between lists and closes its %s store",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const alias = store === "configured alias" || store === "selected alias";
      const physicalPath =
        store === "default"
          ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : state.statePath(alias ? "physical.sqlite" : "custom.sqlite");
      const selectedPath = state.statePath("custom.sqlite");
      const configuredPath = alias ? state.statePath("custom.json") : physicalPath;
      if (alias) {
        await fs.symlink(physicalPath, selectedPath, "file");
      }
      const config = {
        agents: { entries: { main: {} } },
        ...(store === "default" ? {} : { session: { store: configuredPath } }),
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:artifact-reader-lifetime",
        sessionId: "artifact-reader-lifetime",
        storePath: physicalPath,
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "artifact",
          parentId: null,
          message: {
            role: "assistant",
            content: [{ type: "file", title: "result.txt", data: "aGVsbG8=" }],
          },
        },
      ]);
      await waitForSessionTranscriptProjection(scope);
      await closeOpenClawAgentDatabaseByPathAsync(physicalPath, "main");
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      const read = async () => {
        const respond = vi.fn<RespondFn>();
        await artifactsHandlers["artifacts.list"]!({
          params: { sessionKey: scope.sessionKey },
          context,
          client: null,
          req: { type: "req", id: "artifact-lifetime", method: "artifacts.list" },
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return respond.mock.calls[0]?.[1];
      };
      const first = await read();
      expect(first).toMatchObject({
        artifacts: [{ title: "result.txt", sizeBytes: 5, sessionKey: scope.sessionKey }],
      });
      const close = vi.spyOn(historyLane.pool, "closeResources");
      try {
        expect(await read()).toEqual(first);
        expect(close).not.toHaveBeenCalled();
      } finally {
        close.mockRestore();
      }
      const claimSoleCustody = () => {
        const raw = new DatabaseSync(physicalPath);
        try {
          raw.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
        } finally {
          raw.close();
        }
      };
      expect(claimSoleCustody).toThrow(/database is locked/);
      await closeOpenClawAgentDatabaseByPathAsync(
        store === "selected alias" ? selectedPath : configuredPath,
        "main",
      );
      expect(claimSoleCustody).not.toThrow();
    });
  },
);

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures artifacts.list and branches over 5000 sessions with 500 artifacts and branches",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const now = Date.UTC(2026, 9, 24);
      const seeded = await seedTeamShapeSessions({
        stateDir: state.stateDir,
        sessions: 4999,
        retainedRuns: 0,
        transcriptBytes: 0,
        seed: "artifact-branches-benchmark",
        now,
      });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:artifact-bench",
        sessionId: "artifact-bench",
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: now });
      const files = Array.from({ length: 500 }, (_, index) => ({
        type: "file",
        title: `result-${index}.txt`,
        url: `https://artifacts.example.test/results/result-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 4096,
      }));
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...files.map((file, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "context ".repeat(2048) }, file],
          },
        })),
        ...Array.from({ length: 500 }, (_, index) => ({
          type: "message",
          id: `branch-${index}`,
          parentId: "message-499",
          message: { role: "assistant", content: `Preserved branch ${index}` },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const context = await createHistoryReadContext();
      if (process.env.OPENCLAW_ARTIFACT_BENCH_PAUSE === "1") {
        // The Linux controller moves this scope from preparation to measurement CPUs.
        writeSync(1, `${JSON.stringify({ artifactBenchReadyPid: process.pid })}\n`);
        process.kill(process.pid, "SIGSTOP");
      }
      for (const method of ["artifacts.list", "sessions.branches.list"] as const) {
        const request = async () => {
          let response: Parameters<RespondFn> | undefined;
          const handler =
            method === "artifacts.list"
              ? artifactsHandlers["artifacts.list"]!
              : listSessionBranchesForGateway;
          await handler({
            params: { sessionKey: scope.sessionKey },
            context,
            client: null,
            req: { type: "req", id: "artifact-bench", method },
            isWebchatConnect: () => false,
            respond: (...args) => {
              response = args;
            },
          });
          return response;
        };
        const coldStart = performance.now();
        const first = await request();
        const coldMs = performance.now() - coldStart;
        expect(first?.[0]).toBe(true);
        const golden = JSON.stringify(first?.[1]);
        const field = method === "artifacts.list" ? "artifacts" : "branches";
        expect(JSON.parse(golden)[field]).toHaveLength(500);
        const workerResult =
          method === "artifacts.list"
            ? await readSessionArtifacts(scope, {
                kind: "list",
                sessionKey: scope.sessionKey,
                includeDownloadData: false,
              })
            : undefined;
        const samples = [];
        const warmup = 25;
        const count = 1200;
        for (let round = 0; round < warmup + count; round++) {
          const start = performance.now();
          const cpu = process.threadCpuUsage();
          const response = await request();
          const elapsed = process.threadCpuUsage(cpu);
          const wallMs = performance.now() - start;
          expect(response?.[0]).toBe(true);
          expect(JSON.stringify(response?.[1])).toBe(golden);
          if (round >= warmup) {
            samples.push({ wallMs, mainThreadCpuMs: (elapsed.user + elapsed.system) / 1000 });
          }
        }
        const wall = samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b);
        const cpu = samples.map((sample) => sample.mainThreadCpuMs).toSorted((a, b) => a - b);
        console.log(
          JSON.stringify({
            method,
            sessions: seeded.sessions.length + 1,
            branches: 500,
            files: files.length,
            coldMs,
            samples: samples.length,
            workerResultJsonBytes: workerResult
              ? Buffer.byteLength(JSON.stringify(workerResult))
              : undefined,
            responseBytes: Buffer.byteLength(golden),
            meanWallMs: wall.reduce((sum, value) => sum + value, 0) / count,
            medianWallMs: wall[Math.floor(count / 2)],
            p95WallMs: wall[Math.ceil(count * 0.95) - 1],
            p99WallMs: wall[Math.ceil(count * 0.99) - 1],
            maxWallMs: wall.at(-1),
            meanMainThreadCpuMs: cpu.reduce((sum, value) => sum + value, 0) / count,
          }),
        );
      }
    });
  },
);
