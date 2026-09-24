import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compareCodeModeMatrixModes } from "../../scripts/lib/code-mode-matrix-comparison.js";
import {
  captureMatrixLedgerBoundary,
  collectMatrixUsage,
  readMatrixSessionLedger,
  selectMatrixLedgerRows,
  type MatrixSessionLedger,
} from "../../scripts/lib/code-mode-matrix-usage.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ROOT = "agent:qa:matrix:root";
const CHILD = "agent:worker:subagent:child";

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider: "openai",
    model: "fixture-model",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 8,
      cacheWrite: 2,
      totalTokens: 24,
      reasoningTokens: 3,
      cost: { total: 0.012 },
    },
    ...overrides,
  };
}

function ledger(events: unknown[] = [assistant()]): MatrixSessionLedger {
  return {
    stores: { qa: "1:2" },
    rows: events.map((event, seq) => ({
      storeId: "qa",
      sessionId: "root",
      sessionKey: ROOT,
      seq,
      sha256: JSON.stringify(event),
      event,
    })),
    sessions: [
      {
        storeId: "qa",
        sessionId: "root",
        sessionKey: ROOT,
        historyRewritten: false,
        generation: "initial",
      },
    ],
    runs: [],
    issues: [],
  };
}

function reportedUsage(calls = 1) {
  return {
    input_tokens: 20 * calls,
    output_tokens: 4 * calls,
    input_tokens_details: { cached_tokens: 8 * calls, cache_write_tokens: 2 * calls },
    total_tokens: 24 * calls,
  };
}

function accounting(events?: unknown[], rootUsage: unknown = reportedUsage()) {
  return collectMatrixUsage({
    ledger: ledger(events),
    rootSessionKeys: [ROOT],
    settled: true,
    terminalResponseObserved: true,
    rootUsage,
  });
}

function writeStore(root: string, agent: string, sessionKey: string, parentSessionKey?: string) {
  const file = path.join(root, "agents", agent, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT);
      CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT, reason TEXT);
      CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY(session_id,seq));
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT, generation TEXT);
      CREATE TABLE session_transcript_archives(session_id TEXT);
    `);
    db.prepare("INSERT INTO session_nodes VALUES (?,?)").run(
      sessionKey,
      JSON.stringify({
        parentSessionKey,
        lastRunId: parentSessionKey ? "child-run" : "root-run",
        inputTokens: 10,
        outputTokens: 4,
        cacheRead: 8,
        cacheWrite: 2,
        estimatedCostUsd: 0.012,
        totalTokens: 9999,
      }),
    );
    db.prepare("INSERT INTO session_windows VALUES (?,?,?)").run(agent, sessionKey, "initial");
    db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)").run(
      agent,
      `generation-${agent}`,
    );
    db.prepare("INSERT INTO transcript_events VALUES (?,?,?,NULL,NULL)").run(
      agent,
      1,
      JSON.stringify(assistant()),
    );
  } finally {
    db.close();
  }
  return file;
}

describe("matrix task billing", () => {
  it("reads separate agent stores and separates an interview despite colliding child sequence numbers", async () => {
    const root = tempDirs.make("code-mode-accounting-");
    const parentFile = writeStore(root, "qa", ROOT);
    writeStore(root, "worker", CHILD, ROOT);
    const shared = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const registry = new DatabaseSync(shared);
    registry.exec(
      "CREATE TABLE subagent_runs(run_id TEXT, child_session_key TEXT, requester_session_key TEXT, requester_store_path TEXT, payload_json TEXT)",
    );
    registry
      .prepare("INSERT INTO subagent_runs VALUES (?,?,?,?,?)")
      .run(
        "child-run",
        CHILD,
        ROOT,
        parentFile,
        JSON.stringify({ execution: { status: "terminal" } }),
      );
    registry.close();
    const taskEnd = captureMatrixLedgerBoundary(await readMatrixSessionLedger(root));
    const parent = new DatabaseSync(parentFile);
    parent
      .prepare("INSERT INTO transcript_events VALUES (?,?,?,NULL,NULL)")
      .run("qa", 2, JSON.stringify(assistant()));
    parent.close();
    const final = await readMatrixSessionLedger(root);
    const task = collectMatrixUsage({
      ledger: final,
      after: taskEnd,
      rootSessionKeys: [ROOT],
      settled: true,
      terminalResponseObserved: true,
      rootUsage: reportedUsage(),
    });
    const interview = collectMatrixUsage({
      ledger: final,
      before: taskEnd,
      rootSessionKeys: [ROOT],
      settled: true,
      terminalResponseObserved: true,
      rootUsage: reportedUsage(),
    });
    expect(task).toMatchObject({
      complete: true,
      totalTokens: 48,
      reasoningTokens: 6,
      assistantTurns: 2,
      parents: { knownTotalTokens: 24 },
      descendants: { knownTotalTokens: 24 },
    });
    expect(task.costUsd).toBeCloseTo(0.024);
    expect(interview).toMatchObject({ complete: true, totalTokens: 24, assistantTurns: 1 });
    expect(
      selectMatrixLedgerRows({ ledger: final, after: taskEnd, rootSessionKeys: [ROOT] }).rows,
    ).toHaveLength(2);
    expect(final.rows.map((row) => [row.storeId, row.sessionId, row.seq])).toEqual([
      ["agents/qa/agent/openclaw-agent.sqlite", "qa", 1],
      ["agents/qa/agent/openclaw-agent.sqlite", "qa", 2],
      ["agents/worker/agent/openclaw-agent.sqlite", "worker", 1],
    ]);
  });

  it.each([
    {
      label: "missing response usage",
      event: assistant({ usage: undefined }),
      complete: false,
      costComplete: false,
      totalTokens: null,
      knownTotalTokens: 24,
    },
    {
      label: "placeholder price",
      event: assistant({
        usage: {
          input: 10,
          output: 4,
          cacheRead: 8,
          cacheWrite: 2,
          totalTokens: 24,
          cost: { total: 0 },
        },
      }),
      complete: true,
      costComplete: false,
      totalTokens: 24,
      knownTotalTokens: 24,
    },
    {
      label: "provider-billed zero",
      event: assistant({
        usage: {
          input: 10,
          output: 4,
          cacheRead: 8,
          cacheWrite: 2,
          totalTokens: 24,
          cost: { total: 0, totalOrigin: "provider-billed" },
        },
      }),
      complete: true,
      costComplete: true,
      totalTokens: 24,
      knownTotalTokens: 24,
    },
    {
      label: "missing cache bucket",
      event: assistant({ usage: { input: 10, output: 4, totalTokens: 24, cost: { total: 0.01 } } }),
      complete: false,
      costComplete: false,
      totalTokens: null,
      knownTotalTokens: 24,
    },
  ])(
    "preserves missingness for $label",
    ({ event, complete, costComplete, totalTokens, knownTotalTokens }) => {
      expect(accounting([event])).toMatchObject({
        complete,
        costComplete,
        totalTokens,
        knownTotalTokens,
      });
    },
  );

  it("counts failed model consumption and tool repair while excluding a delivery mirror", () => {
    const result = accounting(
      [
        assistant({ stopReason: "error" }),
        { role: "toolResult", toolCallId: "failed-call", isError: true },
        assistant(),
        { role: "assistant", provider: "openclaw", model: "delivery-mirror" },
      ],
      reportedUsage(2),
    );
    expect(result).toMatchObject({
      complete: true,
      totalTokens: 48,
      assistantTurns: 2,
      reasoningTokens: 6,
      modelErrors: 1,
      toolFailures: 1,
    });
  });

  it("keeps known consumption but withholds a total after a lost terminal response", () => {
    expect(
      collectMatrixUsage({
        ledger: ledger(),
        rootSessionKeys: [ROOT],
        settled: true,
        terminalResponseObserved: false,
        rootUsage: undefined,
      }),
    ).toMatchObject({
      complete: false,
      totalTokens: null,
      knownTotalTokens: 24,
      knownCostUsd: 0.012,
    });
  });

  it("retains root auxiliary usage separately without inventing transcript buckets or doubling totals", () => {
    const result = accounting([assistant()], reportedUsage(2));
    expect(result).toMatchObject({
      complete: false,
      totalTokens: null,
      knownTotalTokens: 48,
      input: 10,
      output: 4,
      cacheRead: 8,
      cacheWrite: 2,
      parents: { knownTotalTokens: 24 },
    });
    expect(result.runtimeReconciliation).toMatchObject([
      {
        source: "root-response",
        tokenGap: 24,
        reported: { input: 20, output: 8, cacheRead: 16, cacheWrite: 4, total: 48 },
        matched: false,
      },
    ]);
  });

  it.each([
    "auxiliary usage",
    "wrong run",
    "multiple runs",
    "reused session",
    "cost difference",
  ] as const)("reconciles a child's %s against its canonical run snapshot", (condition) => {
    const final = ledger();
    final.stores.worker = "1:3";
    final.rows.push({
      ...final.rows[0]!,
      storeId: "worker",
      sessionId: "child",
      sessionKey: CHILD,
    });
    final.sessions.push({
      storeId: "worker",
      sessionId: "child",
      sessionKey: CHILD,
      parentSessionKey: ROOT,
      historyRewritten: false,
      runUsage: {
        runId: condition === "wrong run" ? "different-run" : "child-run",
        usage:
          condition === "cost difference"
            ? { input: 10, output: 4, cacheRead: 8, cacheWrite: 2, costUsd: 0.024 }
            : { input: 20, output: 8, cacheRead: 16, cacheWrite: 4, costUsd: 0.024 },
      },
    });
    final.runs.push({
      runId: "child-run",
      childSessionKey: CHILD,
      requesterSessionKey: ROOT,
      requesterStorePath: null,
      executionStatus: "terminal",
    });
    if (condition === "multiple runs") {
      final.runs.push({ ...final.runs[0]!, runId: "another-run" });
    }
    const result = collectMatrixUsage({
      ledger: final,
      rootSessionKeys: [ROOT],
      settled: true,
      terminalResponseObserved: true,
      rootUsage: reportedUsage(),
      ...(condition === "reused session"
        ? { before: captureMatrixLedgerBoundary({ ...final, rows: [] }) }
        : {}),
    });
    expect(result.complete).toBe(condition === "cost difference");
    expect(result.totalTokens).toBe(condition === "cost difference" ? 48 : null);
    expect(result.costComplete).toBe(false);
    expect(result.knownTotalTokens).toBe(condition === "auxiliary usage" ? 72 : 48);
    if (condition === "auxiliary usage") {
      expect(result.knownCostUsd).toBeCloseTo(0.036);
      expect(result.runtimeReconciliation[1]).toMatchObject({
        source: "child-session",
        runId: "child-run",
        tokenGap: 24,
        costGapUsd: 0.012,
      });
    } else if (condition === "cost difference") {
      expect(result.knownCostUsd).toBeCloseTo(0.036);
      expect(result.runtimeReconciliation[1]).toMatchObject({
        matched: true,
        costMatched: false,
        tokenGap: 0,
        costGapUsd: 0.012,
      });
      expect(result.issues).toEqual([]);
      expect(result.costIssues).toEqual([expect.stringContaining("cumulative cost")]);
    } else {
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("one fresh run")]),
      );
    }
  });

  it.each([
    "[responses] retrying streamed encrypted content provider=openai",
    "[responses] retrying full history after rejected previous_response_id provider=openai",
    "[session-recovery] Anthropic thinking stream error; retrying once without thinking blocks: sessionId=fixture",
    "[session-recovery] Anthropic thinking request rejected; retrying once without thinking blocks: sessionId=fixture",
  ])(
    "does not equate a final successful response with observed usage for an internal retry: %s",
    (runtimeLog) => {
      const result = collectMatrixUsage({
        ledger: ledger(),
        rootSessionKeys: [ROOT],
        settled: true,
        terminalResponseObserved: true,
        rootUsage: reportedUsage(),
        runtimeLog,
      });
      expect(result).toMatchObject({ complete: false, knownTotalTokens: 24, totalTokens: null });
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("without separate failed-request usage")]),
      );
    },
  );

  it("does not silently discard unlinked model activity in the isolated state", () => {
    const final = ledger();
    final.rows.push({ ...final.rows[0]!, sessionId: "orphan", sessionKey: CHILD });
    const result = collectMatrixUsage({
      ledger: final,
      rootSessionKeys: [ROOT],
      settled: true,
      terminalResponseObserved: true,
      rootUsage: reportedUsage(),
    });
    expect(result).toMatchObject({
      complete: false,
      knownTotalTokens: 48,
      unattributed: { knownTotalTokens: 24 },
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("Unattributed model response")]),
    );
  });

  it.each(["rewritten", "unsettled", "duplicate-response", "unfinished-child"] as const)(
    "withholds complete totals for %s",
    (condition) => {
      const final = ledger([assistant({ responseId: "response-1" })]);
      const before = captureMatrixLedgerBoundary(final);
      if (condition === "rewritten") {
        final.rows[0]!.sha256 = "changed";
      } else if (condition === "duplicate-response") {
        final.rows.push({ ...final.rows[0]!, seq: 2 });
      } else if (condition === "unfinished-child") {
        final.runs.push({
          runId: "child-run",
          childSessionKey: CHILD,
          requesterSessionKey: ROOT,
          requesterStorePath: null,
          executionStatus: "running",
        });
      }
      const result = collectMatrixUsage({
        ledger: final,
        ...(condition === "rewritten" ? { after: before } : {}),
        rootSessionKeys: [ROOT],
        settled: condition !== "unsettled",
        terminalResponseObserved: true,
        rootUsage: reportedUsage(),
      });
      expect(result.complete).toBe(false);
      expect(result.totalTokens).toBeNull();
      expect(result.knownTotalTokens).toBe(24);
    },
  );
});

function modeRow(mode: "code" | "direct", repetition = 1) {
  return {
    id: `${mode}-${repetition}`,
    mode,
    model: "openai/fixture-model",
    task: "fixture-task",
    repetition,
    gitSha: "fixed-source",
    buildSha256: "fixed-build",
    sourceDirty: false,
    sourcePatchSha256: null,
    passed: true,
    elapsedMs: 20,
    oracle: { identity: true },
    gateway: { taskElapsedMs: 10 },
    workload: {
      promptSha256: `prompt-${repetition}`,
      fixtureSha256: `fixture-${repetition}`,
      settings: {
        thinking: "low",
        fast: false,
        runtime: "openclaw",
        allowedTools: ["read", "write"],
        timeoutSeconds: 60,
        executor: "node",
      },
    },
    accounting: accounting(),
  };
}

describe("same-source mode comparisons", () => {
  it("charges failed attempts to completed tasks and exposes auditable empirical pairs", () => {
    const completedWithErrors = modeRow("code", 1);
    completedWithErrors.accounting.toolFailures = 1;
    const rows = [
      modeRow("direct", 1),
      completedWithErrors,
      modeRow("direct", 2),
      { ...modeRow("code", 2), passed: false },
    ];
    const report = compareCodeModeMatrixModes(rows);
    expect(report.incompletePairs).toEqual([]);
    expect(report.byTask[0]).toMatchObject({
      pairs: 2,
      successfulPairs: 1,
      direct: {
        completed: 2,
        completedWithObservedErrors: 0,
        totalTokens: 48,
        tokensPerCompletedTask: 24,
      },
      code: {
        completed: 1,
        completedWithObservedErrors: 1,
        totalTokens: 48,
        tokensPerCompletedTask: 48,
      },
      operationalRatios: { totalTokensPerCompletedTask: 2 },
    });
    expect(report.byTask[0]!.pairedSuccessDifference).toEqual({
      samples: 2,
      mean: -0.5,
      p50: -0.5,
      min: -1,
      max: 0,
    });
    expect(report.pairs[0]!.totalTokens).toEqual({ direct: 24, code: 24, delta: 0, ratio: 1 });
    expect(report.pairs[1]!.totalTokens).toBeNull();
    expect(report).toEqual(compareCodeModeMatrixModes(rows));
  });

  it("does not claim successful-subset savings when another attempt has missing usage", () => {
    const rows = [
      modeRow("direct", 1),
      modeRow("code", 1),
      modeRow("direct", 2),
      {
        ...modeRow("code", 2),
        accounting: accounting([assistant({ usage: undefined })]),
      },
    ];
    const result = compareCodeModeMatrixModes(rows);
    expect(result.pairs[1]!.totalTokens).toBeNull();
    expect(result.byModel[0]).toMatchObject({
      successfulPairs: 2,
      code: { usageMissing: 1, totalTokens: null },
      pairedSuccessfulDeltas: { totalTokens: null, costUsd: null },
      operationalRatios: { totalTokensPerCompletedTask: null, costPerCompletedTask: null },
    });
  });

  it.each(["thinking", "fast", "permissions", "seed", "source", "build"] as const)(
    "leaves mismatched %s observations unpaired",
    (field) => {
      const direct = modeRow("direct");
      const code = modeRow("code");
      if (field === "thinking") {
        code.workload.settings.thinking = "high";
      } else if (field === "fast") {
        code.workload.settings.fast = true;
      } else if (field === "permissions") {
        code.workload.settings.allowedTools = ["read"];
      } else if (field === "seed") {
        code.workload.fixtureSha256 = "different-seed";
      } else if (field === "source") {
        code.gitSha = "different-source";
      } else {
        code.buildSha256 = "different-build";
      }
      const result = compareCodeModeMatrixModes([direct, code]);
      expect(result.incompletePairs).toHaveLength(2);
      expect(result.pairs).toHaveLength(0);
      for (const group of result.byModel) {
        expect(group.operationalRatios.totalTokensPerCompletedTask).toBeNull();
      }
    },
  );

  it("rejects duplicate observations instead of selecting a favorable rerun", () => {
    expect(() =>
      compareCodeModeMatrixModes([modeRow("direct"), modeRow("direct"), modeRow("code")]),
    ).toThrow("Duplicate");
  });
});
