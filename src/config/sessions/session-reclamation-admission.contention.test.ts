import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";

// Set a report path to replay at measurement scale; the default stays a small regression smoke.
const reportPath = process.env.OPENCLAW_RECLAMATION_CONTENTION_REPORT;
const scale = reportPath
  ? {
      victims: 12,
      events: Number(process.env.OPENCLAW_RECLAMATION_CONTENTION_EVENTS ?? 2_048),
      eventBytes: 2_048,
      foregroundWriters: 4,
      baselineMs: 3_000,
    }
  : { victims: 2, events: 16, eventBytes: 256, foregroundWriters: 2, baselineMs: 150 };

type SessionWriteEvent = {
  operation: string;
  writer: string;
  outcome: string;
  elapsedMs: number;
  queueWaitMs?: number;
  writerExecutionMs?: number;
  admissionPhasesMs?: Record<string, number>;
  nativeTransactionMs?: number;
  nativeTransactionOpenAtRelease?: boolean;
};

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

function distribution(values: readonly number[]) {
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}

test("reclamation grants partition their writer hold while foreground writers contend", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = (sessionId: string) =>
      resolveSqliteTranscriptScope({
        agentId: "main",
        env: state.env,
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
      });
    const storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
    const content = "x".repeat(scale.eventBytes);
    const victims = Array.from(
      { length: scale.victims },
      (_, index) => `contention-victim-${index}`,
    );
    for (const sessionId of victims) {
      const resolved = scope(sessionId);
      runOpenClawAgentWriteTransaction((database) => {
        writeSessionEntry(database, resolved.sessionKey, { sessionId, updatedAt: 1 });
        for (let event = 0; event < scale.events; event += 1) {
          appendTranscriptMessageInTransaction(database, resolved, {
            message: { role: "user", content },
          });
        }
      }, toDatabaseOptions(resolved));
    }
    const foregroundScopes = Array.from({ length: scale.foregroundWriters }, (_, index) =>
      scope(`contention-foreground-${index}`),
    );

    const events: SessionWriteEvent[] = [];
    const diagnostics = channel("openclaw.session.write");
    const collect = (event: unknown) => events.push(event as SessionWriteEvent);
    diagnostics.subscribe(collect);
    // Direct writer reservations outside the session-write owner share the same FIFO.
    const reservations: Array<{
      operation: string;
      caller?: unknown;
      workerOperations?: string[];
      writerExecutionMs: number;
    }> = [];
    const reservationDiagnostics = channel("openclaw.agent-database.reservation");
    const collectReservation = (event: unknown) =>
      reservations.push(event as (typeof reservations)[number]);
    reservationDiagnostics.subscribe(collectReservation);
    const foregroundRunning = { current: true };
    const foregroundLatencyMs: Record<"baseline" | "contended", number[]> = {
      baseline: [],
      contended: [],
    };
    let window: keyof typeof foregroundLatencyMs = "baseline";
    const foreground = foregroundScopes.map(async (resolved, writerIndex) => {
      let revision = 0;
      while (foregroundRunning.current) {
        const startedAt = performance.now();
        await runExclusiveSqliteSessionWrite(
          resolved,
          async () =>
            runOpenClawAgentWriteTransaction(
              (database) =>
                writeSessionEntry(database, resolved.sessionKey, {
                  sessionId: resolved.sessionId,
                  updatedAt: Date.now() + writerIndex,
                  label: `revision-${(revision += 1)}`,
                }),
              toDatabaseOptions(resolved),
            ),
          "session-entry.patch",
        );
        foregroundLatencyMs[window].push(performance.now() - startedAt);
        // Foreground cadence: one short write per writer every ~5 ms.
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    });
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, scale.baselineMs);
      });
      window = "contended";
      // Separates main-thread blocking from writer-lane holds in the foreground latency.
      const loopDelay = monitorEventLoopDelay({ resolution: 5 });
      loopDelay.enable();
      const reclamationStartedAt = performance.now();
      for (const sessionId of victims) {
        const result = await deleteSessionEntryLifecycle({
          agentId: "main",
          env: state.env,
          storePath,
          archiveTranscript: true,
          target: {
            canonicalKey: `agent:main:${sessionId}`,
            storeKeys: [`agent:main:${sessionId}`],
          },
        });
        expect(result.deleted).toBe(true);
        expect(result.archivedTranscripts).toHaveLength(1);
      }
      const reclamationMs = performance.now() - reclamationStartedAt;
      loopDelay.disable();
      const eventLoopDelayMs = {
        p99: loopDelay.percentile(99) / 1e6,
        max: loopDelay.max / 1e6,
      };
      foregroundRunning.current = false;
      await Promise.all(foreground);

      const grants = events.filter((event) => event.writer === "worker" && event.admissionPhasesMs);
      expect(grants.length).toBeGreaterThanOrEqual(victims.length);
      for (const grant of grants) {
        expect(grant.nativeTransactionOpenAtRelease).toBe(false);
        const phased = Object.values(grant.admissionPhasesMs ?? {}).reduce(
          (sum, ms) => sum + ms,
          0,
        );
        // Worker phases plus grant transit fit inside the parent's existing writer aggregate.
        expect(phased).toBeLessThanOrEqual((grant.writerExecutionMs ?? 0) + 1);
      }
      for (const sessionId of victims) {
        expect(loadSessionEntry(scope(sessionId))).toBeUndefined();
      }
      for (const resolved of foregroundScopes) {
        expect(loadSessionEntry(resolved)?.label).toMatch(/^revision-\d+$/);
      }
      if (reportPath) {
        const phases = ["lease-prepare", "open", "schema", "mutation", "commit", "release"];
        const report = {
          scale,
          reclamationMs,
          eventLoopDelayMs,
          grants: {
            n: grants.length,
            byOperation: Object.fromEntries(
              [...new Set(grants.map((grant) => grant.operation))].map((operation) => [
                operation,
                grants.filter((grant) => grant.operation === operation).length,
              ]),
            ),
            writerExecutionMs: distribution(grants.map((grant) => grant.writerExecutionMs ?? 0)),
            nativeTransactionMs: distribution(
              grants.map((grant) => grant.nativeTransactionMs ?? 0),
            ),
            phasesMs: Object.fromEntries(
              phases.map((phase) => [
                phase,
                distribution(grants.map((grant) => grant.admissionPhasesMs?.[phase] ?? 0)),
              ]),
            ),
            perGrant: grants.map((grant) => ({
              operation: grant.operation,
              writerExecutionMs: grant.writerExecutionMs,
              nativeTransactionMs: grant.nativeTransactionMs,
              phasesMs: grant.admissionPhasesMs,
            })),
          },
          // Every other writer-lane owner during the contended window, phased or not.
          otherWriters: Object.fromEntries(
            [
              ...new Set(
                events
                  .filter((event) => event.operation !== "session-entry.patch")
                  .map((event) => `${event.writer}:${event.operation}`),
              ),
            ].map((key) => [
              key,
              distribution(
                events
                  .filter((event) => `${event.writer}:${event.operation}` === key)
                  .map((event) => event.writerExecutionMs ?? event.elapsedMs),
              ),
            ]),
          ),
          reservations: Object.fromEntries(
            [
              ...new Set(
                reservations.map(
                  (event) =>
                    `${event.operation}:${JSON.stringify(event.workerOperations ?? event.caller ?? null)}`,
                ),
              ),
            ].map((key) => [
              key,
              distribution(
                reservations
                  .filter(
                    (event) =>
                      `${event.operation}:${JSON.stringify(event.workerOperations ?? event.caller ?? null)}` ===
                      key,
                  )
                  .map((event) => event.writerExecutionMs),
              ),
            ]),
          ),
          foregroundQueueWaitMs: distribution(
            events
              .filter((event) => event.operation === "session-entry.patch")
              .map((event) => event.queueWaitMs ?? 0),
          ),
          foregroundLatencyMs: {
            baseline: distribution(foregroundLatencyMs.baseline),
            contended: distribution(foregroundLatencyMs.contended),
          },
        };
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
    } finally {
      foregroundRunning.current = false;
      await Promise.allSettled(foreground);
      diagnostics.unsubscribe(collect);
      reservationDiagnostics.unsubscribe(collectReservation);
    }
  });
}, 600_000);
