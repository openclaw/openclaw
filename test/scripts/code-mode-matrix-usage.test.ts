import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { compareCodeModeMatrixModes } from "../../scripts/lib/code-mode-matrix-comparison.js";
import {
  captureMatrixLedgerBoundary,
  collectMatrixUsage,
  readMatrixSessionLedger,
  type MatrixSessionLedger,
} from "../../scripts/lib/code-mode-matrix-usage.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ROOT = "agent:qa:matrix:root";
const CHILD = "agent:worker:subagent:child";
const rootIdentity = { storeId: "qa", sessionId: "root", sessionKey: ROOT };

function usage(scale = 1, total = 0.012, totalOrigin?: "provider-billed") {
  return {
    input: 10 * scale,
    output: 4 * scale,
    cacheRead: 8 * scale,
    cacheWrite: 2 * scale,
    totalTokens: 24 * scale,
    reasoningTokens: 3 * scale,
    cost: { total, totalOrigin },
  };
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider: "openai",
    model: "fixture-model",
    usage: usage(),
    ...overrides,
  };
}
const assistantJson = JSON.stringify(assistant());
const terminalRunJson = JSON.stringify({ execution: { status: "terminal" } });

function ledger(events: unknown[] = [assistant()]): MatrixSessionLedger {
  return {
    stores: { qa: "1:2" },
    rows: events.map((event, seq) => ({
      ...rootIdentity,
      seq,
      sha256: JSON.stringify(event),
      event,
    })),
    sessions: [{ ...rootIdentity, historyRewritten: false, generation: "initial" }],
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

type BillingOptions = Partial<Parameters<typeof collectMatrixUsage>[0]> & { events?: unknown[] };
function accounting({ events, ...options }: BillingOptions = {}) {
  return collectMatrixUsage({
    ledger: ledger(events),
    rootSessionKeys: [ROOT],
    settled: true,
    terminalResponseObserved: true,
    rootUsage: reportedUsage(),
    ...options,
  });
}

function childRun(executionStatus = "terminal") {
  return {
    runId: "child-run",
    childSessionKey: CHILD,
    requesterSessionKey: ROOT,
    requesterStorePath: null,
    executionStatus,
  };
}

function database(
  file: string,
  schema: string,
  ...rows: [table: string, ...values: (string | number | null)[]][]
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    for (const [table, ...values] of rows) {
      db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`).run(...values);
    }
  } finally {
    db.close();
  }
  return file;
}

function writeStore(root: string, agent: string, sessionKey: string, parentSessionKey?: string) {
  return database(
    path.join(root, "agents", agent, "agent", "openclaw-agent.sqlite"),
    `
      CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT);
      CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT, reason TEXT);
      CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY(session_id,seq));
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT, generation TEXT);
      CREATE TABLE session_transcript_archives(session_id TEXT);
    `,
    [
      "session_nodes",
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
    ],
    ["session_windows", agent, sessionKey, "initial"],
    ["transcript_rewrite_watermarks", agent, `generation-${agent}`],
    ["transcript_events", agent, 1, assistantJson, null, null],
  );
}

describe("matrix task billing", () => {
  it("reads separate agent stores and separates an interview despite colliding child sequence numbers", async () => {
    const root = tempDirs.make("code-mode-accounting-");
    const parentFile = writeStore(root, "qa", ROOT);
    writeStore(root, "worker", CHILD, ROOT);
    database(
      path.join(root, "state", "openclaw.sqlite"),
      "CREATE TABLE subagent_runs(run_id TEXT, child_session_key TEXT, requester_session_key TEXT, requester_store_path TEXT, payload_json TEXT)",
      ["subagent_runs", "child-run", CHILD, ROOT, parentFile, terminalRunJson],
    );
    const taskEnd = captureMatrixLedgerBoundary(await readMatrixSessionLedger(root));
    database(parentFile, "", ["transcript_events", "qa", 2, assistantJson, null, null]);
    const final = await readMatrixSessionLedger(root);
    const task = accounting({ ledger: final, after: taskEnd });
    const interview = accounting({ ledger: final, before: taskEnd });
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
  });

  const unavailable = { usageReport: { state: "unavailable" } };
  const unknownTotals = {
    complete: false,
    costComplete: false,
    totalTokens: null,
    costUsd: null,
    reasoningTokens: null,
  };
  const buckets = { input: 10, output: 4, cacheRead: 8, cacheWrite: 2 };
  const incomplete = (knownTotalTokens = 24) => ({
    complete: false,
    totalTokens: null,
    knownTotalTokens,
  });
  it("ignores unavailable counters", () => {
    expect(
      accounting({
        events: [assistant({ usage: { ...usage(), ...unavailable } })],
        rootUsage: unavailable,
      }),
    ).toMatchObject({
      ...unknownTotals,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      knownTotalTokens: 0,
      knownCostUsd: 0,
      assistantTurns: 1,
    });
  });
  it("preserves measured usage alongside unavailable usage", () => {
    const failed = assistant({ usage: { ...usage(), ...unavailable }, stopReason: "error" });
    expect(
      accounting({
        events: [failed, assistant()],
        rootUsage: unavailable,
      }),
    ).toMatchObject({
      ...unknownTotals,
      ...buckets,
      knownTotalTokens: 24,
      knownCostUsd: 0.012,
      reasoningComplete: false,
      assistantTurns: 2,
      modelErrors: 1,
    });
  });
  it.each([false, true])("distinguishes measured=%s zero usage", (measured) => {
    const zero = {
      ...usage(0, 0, "provider-billed"),
      ...(measured ? { usageReport: { state: "available" } } : {}),
    };
    expect(accounting({ events: [assistant({ usage: zero })], rootUsage: zero })).toMatchObject({
      complete: measured,
      costComplete: measured,
      totalTokens: measured ? 0 : null,
      costUsd: measured ? 0 : null,
      knownTotalTokens: 0,
      reasoningTokens: measured ? 0 : null,
      reasoningComplete: measured,
      assistantTurns: 1,
    });
  });
  const missingCache = { input: 10, output: 4, totalTokens: 24, cost: { total: 0.01 } };
  it.each([
    ["missing response usage", undefined, false, false],
    ["placeholder price", usage(1, 0), true, false],
    ["provider-billed zero", usage(1, 0, "provider-billed"), true, true],
    ["missing cache bucket", missingCache, false, false],
  ] as const)("accounts for %s", (_label, observation, complete, costComplete) => {
    expect(accounting({ events: [assistant({ usage: observation })] })).toMatchObject({
      complete,
      costComplete,
      totalTokens: complete ? 24 : null,
      knownTotalTokens: 24,
    });
  });
  it("counts failed model/tool consumption without the delivery mirror", () => {
    expect(
      accounting({
        events: [
          assistant({ stopReason: "error" }),
          { role: "toolResult", toolCallId: "failed-call", isError: true },
          assistant(),
          { role: "assistant", provider: "openclaw", model: "delivery-mirror" },
        ],
        rootUsage: reportedUsage(2),
      }),
    ).toMatchObject({
      complete: true,
      totalTokens: 48,
      assistantTurns: 2,
      reasoningTokens: 6,
      modelErrors: 1,
      toolFailures: 1,
    });
  });
  it("withholds totals when the terminal response is lost", () => {
    expect(accounting({ terminalResponseObserved: false, rootUsage: undefined })).toMatchObject({
      ...incomplete(),
      knownCostUsd: 0.012,
    });
  });
  it("keeps root auxiliary usage without inventing buckets or doubling totals", () => {
    expect(accounting({ rootUsage: reportedUsage(2) })).toMatchObject({
      ...buckets,
      ...incomplete(48),
      parents: { knownTotalTokens: 24 },
      runtimeReconciliation: [
        {
          source: "root-response",
          tokenGap: 24,
          matched: false,
          reported: { input: 20, output: 8, cacheRead: 16, cacheWrite: 4, total: 48 },
        },
      ],
    });
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
    const identity = { storeId: "worker", sessionId: "child", sessionKey: CHILD };
    final.rows.push({ ...final.rows[0]!, ...identity });
    final.sessions.push({
      ...identity,
      parentSessionKey: ROOT,
      historyRewritten: false,
      runUsage: {
        runId: condition === "wrong run" ? "different-run" : "child-run",
        usage:
          condition === "cost difference"
            ? { ...buckets, costUsd: 0.024 }
            : { input: 20, output: 8, cacheRead: 16, cacheWrite: 4, costUsd: 0.024 },
      },
    });
    final.runs.push(childRun());
    if (condition === "multiple runs") {
      final.runs.push({ ...final.runs[0]!, runId: "another-run" });
    }
    const result = accounting({
      ledger: final,
      ...(condition === "reused session"
        ? { before: captureMatrixLedgerBoundary({ ...final, rows: [] }) }
        : {}),
    });
    expect(result).toMatchObject({
      complete: condition === "cost difference",
      totalTokens: condition === "cost difference" ? 48 : null,
      costComplete: false,
      knownTotalTokens: condition === "auxiliary usage" ? 72 : 48,
    });
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
      const result = accounting({ runtimeLog });
      expect(result).toMatchObject(incomplete());
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.stringContaining("without separate failed-request usage")]),
      );
    },
  );

  it("does not silently discard unlinked model activity in the isolated state", () => {
    const final = ledger();
    final.rows.push({ ...final.rows[0]!, sessionId: "orphan", sessionKey: CHILD });
    const result = accounting({ ledger: final });
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
        final.runs.push(childRun("running"));
      }
      const result = accounting({
        ledger: final,
        ...(condition === "rewritten" ? { after: before } : {}),
        settled: condition !== "unsettled",
      });
      expect(result).toMatchObject(incomplete());
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
        allowedTools: ["read", "write"],
        timeoutSeconds: 60,
      },
    },
    accounting: accounting(),
  };
}
function comparePairs(...codeRows: ReturnType<typeof modeRow>[]) {
  return compareCodeModeMatrixModes(
    codeRows.flatMap((row) => [modeRow("direct", row.repetition), row]),
  );
}

describe("same-source mode comparisons", () => {
  it("charges failed attempts to completed tasks and exposes auditable empirical pairs", () => {
    const completedWithErrors = modeRow("code", 1);
    completedWithErrors.accounting.toolFailures = 1;
    const report = comparePairs(completedWithErrors, { ...modeRow("code", 2), passed: false });
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
    const distribution = { samples: 2, mean: -0.5, p50: -0.5, min: -1, max: 0 };
    expect(report.byTask[0]!.pairedSuccessDifference).toEqual(distribution);
    expect(report.pairs[0]!.totalTokens).toEqual({ direct: 24, code: 24, delta: 0, ratio: 1 });
    expect(report.pairs[1]!.totalTokens).toBeNull();
  });

  it("does not claim successful-subset savings when another attempt has missing usage", () => {
    const missingUsage = {
      ...modeRow("code", 2),
      accounting: accounting({ events: [assistant({ usage: undefined })] }),
    };
    const result = comparePairs(modeRow("code"), missingUsage);
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
