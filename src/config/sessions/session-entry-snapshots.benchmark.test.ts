import { channel } from "node:diagnostics_channel";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listSessionEntriesReadOnly } from "./session-accessor.sqlite-entry-list.read.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryReadOnly } from "./session-accessor.sqlite-exact-read.js";
import type { InternalSessionEntry } from "./types.js";

// Opt-in allocation comparison through the storage owners; ordinary suites own regressions.
it.runIf(process.env.OPENCLAW_SESSION_ENTRY_SNAPSHOTS_BENCH === "1")(
  "measures session metadata reads and patches with retained cold snapshots",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const rows = 128;
      const scope = { agentId: "main", sessionKey: "agent:main:snapshots-0", env };
      const entry: InternalSessionEntry = {
        sessionId: "snapshots-0",
        updatedAt: 1_800_000_000_000,
        lifecycleRevision: "fixture-revision",
        label: "Snapshot fixture 0",
        model: "fixture-model",
        modelProvider: "fixture",
        status: "done",
        sessionDiffBaseline: {
          version: 1,
          sessionId: "snapshots-0",
          root: "/synthetic/workspace",
          files: Array.from({ length: 160 }, (_, index) => ({
            path: `src/synthetic/fixture-${index}.ts`,
            fingerprint: index.toString(16).padStart(64, "0"),
          })),
        },
        skillsSnapshot: { prompt: "Synthetic saved skill instructions. ".repeat(384), skills: [] },
        systemPromptReport: {
          source: "run",
          generatedAt: 1_800_000_000_000,
          systemPrompt: { chars: 20_000, projectContextChars: 0, nonProjectContextChars: 20_000 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 14_000, entries: [] },
          tools: {
            listChars: 2_000,
            schemaChars: 4_000,
            entries: Array.from({ length: 16 }, (_, index) => ({
              name: `synthetic_tool_${index}`,
              summaryChars: 125,
              schemaChars: 250,
              propertiesCount: 4,
            })),
          },
        },
      };
      runOpenClawAgentWriteTransaction(() => {
        for (let index = 0; index < rows; index++) {
          const sessionId = `snapshots-${index}`;
          replaceSessionEntrySync(
            { ...scope, sessionKey: `agent:main:${sessionId}` },
            {
              ...entry,
              sessionId,
              label: `Snapshot fixture ${index}`,
              sessionDiffBaseline: { ...entry.sessionDiffBaseline!, sessionId },
            },
          );
        }
      }, scope);
      const hotRead = () => loadExactSessionEntryReadOnly({ ...scope, projection: "list" });
      const fullRead = () => loadExactSessionEntryReadOnly(scope);
      const list = () =>
        listSessionEntriesReadOnly({ ...scope, projection: "list", readConsistency: "latest" });
      expect(hotRead()?.entry.label).toBe(entry.label);
      expect(list()).toHaveLength(rows);
      expect(fullRead()?.entry.sessionDiffBaseline).toEqual(entry.sessionDiffBaseline);

      const inspector = new Session();
      inspector.connect();
      const samples: Array<Record<string, unknown>> = [];
      const measure = async <T>(phase: string, calls: number, run: () => T | Promise<T>) => {
        await inspector.post("HeapProfiler.collectGarbage");
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 16_384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const memoryBefore = process.memoryUsage();
        const cpu = process.threadCpuUsage();
        const startedAt = performance.now();
        const result = await run();
        const wallMs = performance.now() - startedAt;
        const elapsedCpu = process.threadCpuUsage(cpu);
        const memoryAfter = process.memoryUsage();
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const sites = new Map<string, number>();
        let sampledAllocationBytes = 0;
        let sampledCloneBytes = 0;
        const visit = (node: typeof profile.head, cloned = false) => {
          const { functionName, url, lineNumber } = node.callFrame;
          const name = `${functionName} ${url.split("/").slice(-2).join("/")}:${lineNumber + 1}`;
          const inClone = cloned || functionName === "structuredClone";
          sampledAllocationBytes += node.selfSize;
          sampledCloneBytes += inClone ? node.selfSize : 0;
          sites.set(name, (sites.get(name) ?? 0) + node.selfSize);
          for (const child of node.children) {
            visit(child, inClone);
          }
        };
        visit(profile.head);
        samples.push({
          phase,
          calls,
          wallMs,
          wallMsPerCall: wallMs / calls,
          mainThreadCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1_000,
          sampledAllocationBytes,
          sampledBytesPerCall: Math.round(sampledAllocationBytes / calls),
          sampledCloneBytes,
          heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
          rssBeforeBytes: memoryBefore.rss,
          rssAfterBytes: memoryAfter.rss,
          sites: [...sites].toSorted((left, right) => right[1] - left[1]).slice(0, 10),
        });
        return result;
      };
      const writeDiagnostics = channel("openclaw.session.write");
      const executionMs: number[] = [];
      const queueWaitMs: number[] = [];
      const recordWrite = (message: unknown) => {
        if (
          isRecord(message) &&
          message.operation === "session-entry.patch" &&
          typeof message.writerExecutionMs === "number" &&
          typeof message.queueWaitMs === "number"
        ) {
          executionMs.push(message.writerExecutionMs);
          queueWaitMs.push(message.queueWaitMs);
        }
      };
      try {
        const hotLabels = await measure("exact-metadata-read", 1_000, () => {
          let labels = 0;
          for (let index = 0; index < 1_000; index++) {
            labels += Number(hotRead()?.entry.label === entry.label);
          }
          return labels;
        });
        expect(hotLabels).toBe(1_000);
        const listedRows = await measure("metadata-list", 100, () => {
          let total = 0;
          for (let index = 0; index < 100; index++) {
            total += list().length;
          }
          return total;
        });
        expect(listedRows).toBe(rows * 100);
        const fullReads = await measure("full-entry-read-control", 100, () => {
          let files = 0;
          for (let index = 0; index < 100; index++) {
            files += fullRead()?.entry.sessionDiffBaseline?.files.length ?? 0;
          }
          return files;
        });
        expect(fullReads).toBe(16_000);
        writeDiagnostics.subscribe(recordWrite);
        const patched = await measure("entry-label-patch", 100, async () => {
          let result: InternalSessionEntry | null = null;
          for (let index = 0; index < 100; index++) {
            result = await patchSessionEntryCore(scope, () => ({ label: `Patched ${index}` }), {
              skipMaintenance: true,
              preserveActivity: true,
            });
          }
          return result;
        });
        expect(patched?.label).toBe("Patched 99");
        expect(executionMs).toHaveLength(100);
        const persisted = fullRead()?.entry;
        expect(persisted?.label).toBe("Patched 99");
        expect(persisted?.sessionDiffBaseline).toEqual(entry.sessionDiffBaseline);
        expect(persisted?.skillsSnapshot).toEqual(entry.skillsSnapshot);
        expect(persisted?.systemPromptReport).toEqual(entry.systemPromptReport);
        const summarize = (values: number[]) => {
          const ordered = values.toSorted((left, right) => left - right);
          return {
            mean: values.reduce((sum, value) => sum + value, 0) / values.length,
            p50: ordered[Math.ceil(ordered.length * 0.5) - 1],
            p99: ordered[Math.ceil(ordered.length * 0.99) - 1],
            max: ordered.at(-1),
          };
        };
        console.log(
          JSON.stringify({
            benchmark: "session-entry-snapshots",
            rows,
            fixtureEntryBytes: Buffer.byteLength(JSON.stringify(entry)),
            samples,
            patchWriterExecutionMs: summarize(executionMs),
            patchQueueWaitMs: summarize(queueWaitMs),
            timingResolutionMs: 1,
          }),
        );
      } finally {
        writeDiagnostics.unsubscribe(recordWrite);
        inspector.disconnect();
      }
    });
  },
);
