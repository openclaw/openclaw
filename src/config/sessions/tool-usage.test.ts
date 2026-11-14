import { expect, it } from "vitest";
import { createRunToolUsageRecorder } from "../../agents/tool-usage-recorder.js";
import { decayToolUsage } from "../../agents/tool-usage.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import {
  flushAgentToolUsage,
  importAgentToolUsage,
  readAgentToolUsageStatus,
  pruneRegisteredAgentToolUsage,
  resetAgentToolUsage,
} from "./tool-usage.js";
import { seedAgentToolUsageRunForTest } from "./tool-usage.test-support.js";

const day = 86_400_000;
const now = Date.UTC(2026, 9, 1);
const toolId = "openclaw:synthetic:lookup";
const catalog = [{ id: toolId, name: "lookup" }];

it("imports terminal calls once through workers, preserves live counts, and fences reset batches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { env } = state;
    const options = { agentId: "main", env, now };
    const events: { session_id: string; seq: number; event_json: string; created_at: number }[] =
      [];
    function append(message: unknown, at: number) {
      const seq = events.length;
      events.push({
        session_id: "usage-fixture",
        seq,
        event_json: JSON.stringify({
          type: "message",
          id: `event-${seq}`,
          timestamp: new Date(at).toISOString(),
          message,
        }),
        created_at: at,
      });
    }
    function call(id: string, name: string, at: number, status?: string, args: unknown = {}) {
      append(
        { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
        at - 1,
      );
      append(
        {
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          content: [],
          isError: status === "error",
          details: status ? { status } : {},
          timestamp: at,
        },
        at,
      );
    }
    call("old", "lookup", now - 30 * day);
    call("direct", "lookup", now - 14 * day);
    call("dispatch", "dispatch_action", now - 7 * day, undefined, { id: toolId });
    append(
      createNestedToolActivity({
        runId: "synthetic-run",
        scopeId: "synthetic-scope",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer",
        toolCallId: "nested",
        toolName: "lookup",
        input: {},
        result: { content: [] },
        isError: false,
        startedAt: now - 3 * day,
        timestamp: now - 3 * day,
      }),
      now - 3 * day,
    );
    call("outer", "dispatch_action", now - 3 * day, undefined, { id: toolId });
    call("error", "lookup", now - day, "error");
    call("cancel", "lookup", now - day, "cancelled");
    call("client", "lookup", now - day, "pending");
    call("wrapper", "tool_search", now - day);
    call("unknown", "missing", now - day);
    await seedUnindexedTranscriptForTest({
      agentId: "main",
      env,
      sessionKey: "agent:main:usage-fixture",
      entry: { sessionId: "usage-fixture", updatedAt: now - 100 * day },
      transcriptMtimeMs: now,
      events,
    });

    const dry = await importAgentToolUsage({ ...options, catalog, sinceDays: 14, dryRun: true });
    expect(dry).toMatchObject({ successfulCalls: 3, scannedEvents: events.length });
    expect(dry.applied).toBe(false);
    expect(dry.excluded).toMatchObject({
      errors: 1,
      cancelled: 1,
      pending: 1,
      wrappers: 3,
      unknownTools: 1,
    });
    expect(await readAgentToolUsageStatus(options)).toMatchObject({
      rows: [],
      liveSince: null,
      lastImportAt: null,
    });

    const { generation } = await seedAgentToolUsageRunForTest(options);
    expect(
      await flushAgentToolUsage({
        ...options,
        generation,
        rows: [{ toolId, score: 2, updatedAt: now }],
      }),
    ).toBe(true);
    const imported = await importAgentToolUsage({ ...options, catalog, sinceDays: 14 });
    expect(imported.applied).toBe(true);
    const expected = 2 + 0.5 + 2 ** (-7 / 14) + 2 ** (-3 / 14);
    const status = await readAgentToolUsageStatus(options);
    expect(status.rows).toHaveLength(1);
    expect(decayToolUsage(status.rows[0]!, now)).toBeCloseTo(expected);
    expect(status.lastImportAt).toBe(now);
    expect(
      (await importAgentToolUsage({ ...options, catalog, sinceDays: 14 })).successfulCalls,
    ).toBe(0);
    expect((await readAgentToolUsageStatus(options)).rows).toEqual(status.rows);
    expect((await importAgentToolUsage({ ...options, catalog })).successfulCalls).toBe(1);
    expect(decayToolUsage((await readAgentToolUsageStatus(options)).rows[0]!, now)).toBeCloseTo(
      expected + 2 ** (-30 / 14),
    );
    expect((await readAgentToolUsageStatus({ ...options, agentId: "other" })).rows).toEqual([]);

    const reset = await resetAgentToolUsage({ ...options, now: now + 1 });
    expect(
      await flushAgentToolUsage({
        ...options,
        generation,
        rows: [{ toolId, score: 10, updatedAt: now }],
      }),
    ).toBe(false);
    expect((await readAgentToolUsageStatus(options)).rows).toEqual([]);
    expect(
      await flushAgentToolUsage({
        ...options,
        generation: reset.generation,
        rows: [{ toolId, score: 1, updatedAt: now + 2 }],
      }),
    ).toBe(true);
    await pruneRegisteredAgentToolUsage({ env, now: now + 91 * day, assertCurrent: () => {} });
    // An earlier read clock proves the expired row was deleted, not only hidden.
    expect((await readAgentToolUsageStatus(options)).rows).toEqual([]);

    const storePath = state.statePath("shared", "sessions.json");
    for (const agent of ["main", "other"]) {
      const sessionId = `custom-${agent}`;
      await seedUnindexedTranscriptForTest({
        agentId: "main",
        env,
        storePath,
        sessionKey: `agent:${agent}:${sessionId}`,
        entry: { sessionId, updatedAt: now },
        events: [
          {
            session_id: sessionId,
            seq: 0,
            created_at: now - day,
            event_json: JSON.stringify({
              type: "message",
              id: `result-${agent}`,
              message: {
                role: "toolResult",
                toolCallId: `call-${agent}`,
                toolName: "lookup",
                isError: false,
              },
            }),
          },
        ],
      });
    }
    const custom = await importAgentToolUsage({
      ...options,
      catalog,
      config: { session: { store: storePath } },
    });
    expect(custom.successfulCalls).toBe(1);
    expect((await readAgentToolUsageStatus(options)).rows).toEqual([
      { toolId, score: 1, updatedAt: now - day },
    ]);

    const gapOptions = { agentId: "coverage", env };
    const seedRun = async (runId: string, at: number) => {
      await seedUnindexedTranscriptForTest({
        ...gapOptions,
        sessionKey: `agent:coverage:${runId}`,
        entry: { sessionId: runId, updatedAt: at },
        events: [
          {
            session_id: runId,
            seq: 0,
            created_at: at,
            event_json: JSON.stringify({
              type: "message",
              id: `result-${runId}`,
              message: {
                role: "toolResult",
                toolCallId: runId,
                toolName: "lookup",
                isError: false,
                __openclaw: { runId },
              },
            }),
          },
        ],
      });
    };
    await seedRun("off-first", now - 10);
    expect((await importAgentToolUsage({ ...gapOptions, catalog, now })).successfulCalls).toBe(1);
    expect((await readAgentToolUsageStatus({ ...gapOptions, now })).liveSince).toBeNull();
    await seedRun("off-second", now + 10);
    expect(
      (await importAgentToolUsage({ ...gapOptions, catalog, now: now + 20 })).successfulCalls,
    ).toBe(1);
    for (const [runId, at] of [
      ["live-first", now + 30],
      ["live-second", now + 70],
    ] as const) {
      const admitted = await seedAgentToolUsageRunForTest({ ...gapOptions, runId, now: at });
      await seedRun(runId, at + 1);
      await flushAgentToolUsage({
        ...gapOptions,
        runId,
        generation: admitted.generation,
        now: at + 2,
        rows: [{ toolId, score: 1, updatedAt: at + 1 }],
      });
    }
    await seedRun("disabled-between-live-runs", now + 50);
    const gapImport = await importAgentToolUsage({ ...gapOptions, catalog, now: now + 80 });
    expect(gapImport).toMatchObject({ successfulCalls: 1, excluded: { recordedLive: 2 } });
    expect(
      (await importAgentToolUsage({ ...gapOptions, catalog, now: now + 90 })).successfulCalls,
    ).toBe(0);
    expect(
      (await readAgentToolUsageStatus({ ...gapOptions, now: now + 90 })).rows[0]?.score,
    ).toBeCloseTo(5);
    await seedRun("unscanned-gap", now + 2 * day);
    await seedRun("later-narrow-window", now + 4 * day);
    expect(
      (await importAgentToolUsage({ ...gapOptions, catalog, sinceDays: 1, now: now + 5 * day }))
        .successfulCalls,
    ).toBe(1);
    expect(
      (await readAgentToolUsageStatus({ ...gapOptions, now: now + 5 * day })).importedWindows,
    ).toHaveLength(2);
    expect(
      (await importAgentToolUsage({ ...gapOptions, catalog, now: now + 5 * day + 1 }))
        .successfulCalls,
    ).toBe(1);
    await pruneRegisteredAgentToolUsage({ env, now: now + 96 * day, assertCurrent: () => {} });
    expect((await readAgentToolUsageStatus({ ...gapOptions, now })).rows).toEqual([]);
    const pendingRunId = "active-before-first-transcript-commit";
    await seedRun(pendingRunId, now + 96 * day);
    const active = createRunToolUsageRecorder({
      agentId: gapOptions.agentId,
      runId: pendingRunId,
      config: { agents: { defaults: { experimental: { usageRankedToolIndex: true } } } },
      log: { warn: () => {} },
      now: () => now + 96 * day,
    });
    expect(active).toBeDefined();
    try {
      expect(
        await importAgentToolUsage({
          ...gapOptions,
          catalog,
          dryRun: true,
          now: now + 96 * day + 1,
        }),
      ).toMatchObject({ successfulCalls: 0, excluded: { recordedLive: 1 } });
    } finally {
      await active?.settle();
    }
  });
});
