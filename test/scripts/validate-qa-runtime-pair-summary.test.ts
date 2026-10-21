import { describe, expect, it } from "vitest";
import {
  validateQaRuntimePairReport as validateReport,
  validateQaRuntimePairSummary as validateSummary,
} from "../../scripts/validate-qa-runtime-pair-summary.mts";

type CellStatus = "pass" | "fail" | "skip";
type RuntimeCell = {
  runtime: "openclaw" | "codex";
  status?: CellStatus;
  details?: string;
  runtimeErrorClass?: string;
  toolCalls: Array<{ errorClass?: string }>;
};

function scenario(
  name: string,
  options: {
    status?: CellStatus;
    drift?: "none" | "structural" | "failure-mode";
    openclaw?: Partial<RuntimeCell>;
    codex?: Partial<RuntimeCell>;
  } = {},
) {
  const status = options.status ?? "pass";
  const cell = (
    runtime: RuntimeCell["runtime"],
    overrides?: Partial<RuntimeCell>,
  ): RuntimeCell => ({ runtime, status: "pass", toolCalls: [], ...overrides });
  return {
    name,
    status,
    runtimeParity: {
      scenarioId: name.toLowerCase().replaceAll(" ", "-"),
      drift: options.drift ?? (status === "pass" ? "none" : "failure-mode"),
      cells: { openclaw: cell("openclaw", options.openclaw), codex: cell("codex", options.codex) },
    },
  };
}

function summary(scenarios = [scenario("passing")]) {
  return {
    run: {
      status: "completed",
      runtimePair: ["openclaw", "codex"],
      scenarioIds: scenarios.map((entry) => entry.runtimeParity.scenarioId),
    },
    counts: {
      total: scenarios.length,
      passed: scenarios.filter((entry) => entry.status === "pass").length,
      failed: scenarios.filter((entry) => entry.status === "fail").length,
      skipped: scenarios.filter((entry) => entry.status === "skip").length,
    },
    scenarios,
  };
}

const gapIds = [
  "apply-patch",
  "bash",
  "edit",
  "exec",
  "fs-list",
  "fs-read",
  "fs-write",
  "grep",
].map((name) => "runtime-tool-" + name);
// Immutable candidate report inventory, independent of the live catalog.
const frozenIds = [
  "instruction-followthrough-repo-contract",
  "subagent-fanout-synthesis",
  "subagent-handoff",
  "subagent-stale-child-links",
  "config-restart-capability-flip",
  "image-understanding-attachment",
  "memory-recall",
  "thread-memory-isolation",
  "model-switch-tool-continuity",
  "approval-turn-tool-followthrough",
  "codex-plugin-pinned-new",
  "codex-plugin-pinned-old",
  "compaction-retry-mutating-tool",
  "runtime-first-hour-20-turn",
  ...gapIds,
  "runtime-tool-session-status",
  "runtime-tool-sessions-spawn",
  "runtime-tool-web-fetch",
  "runtime-tool-web-search",
  "source-docs-discovery-report",
];
const legacyOptions = {
  candidateSuiteOutcome: "success",
  targetSha: "ee5ead24b1b46a3560f28f8d57e0afcd911acacb",
  lane: "core",
};
const gapOptions = {
  requireExplicitGap: true,
  targetSha: "c37af96b18776fecc9e24268f27fc89b563481bf",
  lane: "core",
};
const trackedGap = { status: "skip", details: "known-harness-gap exec: tracked" } as const;

function frozenSummary(legacy = false) {
  const ids = legacy ? frozenIds.filter((id) => !id.startsWith("codex-plugin-pinned-")) : frozenIds;
  const fixture = summary(
    ids.map((id) =>
      scenario(id, !legacy && gapIds.includes(id) ? { status: "skip", codex: trackedGap } : {}),
    ),
  );
  if (legacy) {
    delete (fixture.run as { status?: string }).status;
  }
  return Object.assign(fixture, {
    run: {
      ...fixture.run,
      startedAt: "2026-08-22T06:02:37.608Z",
      finishedAt: "2026-08-22T06:14:49.336Z",
    },
  });
}

function reportFor(fixture: ReturnType<typeof summary>, secondCodexStatus = "pass") {
  const rows = fixture.scenarios.map((entry, index) => ({
    name: entry.name,
    status: "pass",
    drift: entry.runtimeParity.drift,
    driftDetails: undefined,
    openclawStatus: "pass",
    codexStatus: index === 1 ? secondCodexStatus : "pass",
  }));
  return {
    json: {
      runtimePair: ["openclaw", "codex"],
      totalScenarios: rows.length,
      passedScenarios: rows.length,
      failedScenarios: 0,
      scenarios: rows,
      failures: [],
      pass: true,
    },
    markdown: [
      "# OpenClaw Runtime Parity Report — openclaw vs codex",
      "",
      "- Verdict: pass",
      ...rows.flatMap((entry) => [
        "",
        "### " + entry.name,
        "",
        "- status: pass",
        "- drift: " + entry.drift,
        "- openclaw: pass (0 tool calls)",
        "- codex: " + entry.codexStatus + " (0 tool calls)",
      ]),
      "",
    ].join("\n"),
  };
}

describe("frozen QA runtime-pair validation", () => {
  it.each(["cell status", "zero skipped count"])("accepts legacy missing %s", (missing) => {
    const fixture = summary([scenario("legacy passing")]);
    if (missing === "cell status") {
      delete fixture.scenarios[0]!.runtimeParity.cells.openclaw.status;
      delete fixture.scenarios[0]!.runtimeParity.cells.codex.status;
    } else {
      delete (fixture.counts as { skipped?: number }).skipped;
    }
    expect(validateSummary(fixture)).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
  });

  it("rejects statusless frozen evidence with missing finishedAt", () => {
    const fixture = frozenSummary(true);
    delete (fixture.run as { finishedAt?: string }).finishedAt;
    expect(() => validateSummary(fixture, legacyOptions)).toThrow(
      "runtime-pair summary is not completed",
    );
  });

  it.each(["scenario failure", "count drift"])("rejects %s after frozen admission", (failure) => {
    const fixture = frozenSummary(true);
    fixture.counts.passed -= 1;
    if (failure === "scenario failure") {
      fixture.scenarios[0]!.status = "fail";
      fixture.counts.failed += 1;
    }
    expect(() => validateSummary(fixture, legacyOptions)).toThrow(
      failure === "scenario failure"
        ? "runtime-pair failure or unsupported skip"
        : "counts do not match validated scenario evidence",
    );
  });

  it("applies the trusted suite outcome gate to frozen report validation", () => {
    const fixture = frozenSummary(true);
    const { json, markdown } = reportFor(fixture);
    expect(validateReport(fixture, json, markdown, legacyOptions)).toMatchObject({
      total: 25,
      passed: 25,
    });
    expect(() =>
      validateReport(fixture, json, markdown, {
        ...legacyOptions,
        candidateSuiteOutcome: "failure",
      }),
    ).toThrow("runtime-pair summary is not completed");
  });

  it.each<NonNullable<Parameters<typeof scenario>[1]>>([
    { codex: { details: "implementation unavailable" } },
    { openclaw: { status: "skip" } },
    { codex: { runtimeErrorClass: "auth" } },
    { codex: { toolCalls: [{ errorClass: "tool-result-missing" }] } },
    { drift: "failure-mode" },
  ])("rejects malformed or unsafe advisory gap evidence: %j", (overrides) => {
    const entry = scenario("tracked advisory gap", {
      ...overrides,
      drift: overrides.drift ?? "structural",
      codex: {
        ...trackedGap,
        details: "known-harness-gap exec: tracked\ntracking: #80319",
        ...overrides.codex,
      },
    });
    expect(() => validateSummary(summary([entry]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );
  });

  it("requires complete declared results before overriding a nonzero suite exit", () => {
    expect(() =>
      validateSummary(summary(), {
        ...gapOptions,
        targetSha: "311047822ecdde24e824d839ab105ef08f17be00",
      }),
    ).toThrow("requires an explicit Codex-native harness gap");
    const incomplete = summary();
    incomplete.run.scenarioIds.push("missing-result");
    expect(() => validateSummary(incomplete)).toThrow(
      "do not match the declared scenario manifest",
    );
  });

  it("pins the exact frozen scenarios that may use the explicit gap exception", () => {
    const fixture = frozenSummary();
    const expectedGap = fixture.scenarios.find(
      (entry) => entry.name === "runtime-tool-apply-patch",
    )!;
    expectedGap.status = "pass";
    expectedGap.runtimeParity.drift = "none";
    expectedGap.runtimeParity.cells.codex.status = "pass";
    delete expectedGap.runtimeParity.cells.codex.details;
    const unrelated = fixture.scenarios[0]!;
    unrelated.status = "skip";
    unrelated.runtimeParity.drift = "failure-mode";
    Object.assign(unrelated.runtimeParity.cells.codex, trackedGap);
    expect(() => validateSummary(fixture, gapOptions)).toThrow("trusted frozen-lane manifest");
  });

  it("cross-checks generated report JSON and Markdown", () => {
    const fixture = summary([scenario("Passing")]);
    const { json, markdown } = reportFor(fixture);
    expect(validateReport(fixture, json, markdown)).toMatchObject({ total: 1, passed: 1 });
    json.scenarios = [];
    expect(() => validateReport(fixture, json, markdown)).toThrow("report summary does not match");
  });

  // Since #129616 an approved scenario-level gap may remain a skipped report cell.
  it.each(["skip", "fail"])("validates an approved gap reported as %s", (codexStatus) => {
    const fixture = summary([
      scenario("passing"),
      scenario("compaction retry", {
        drift: "structural",
        codex: {
          status: "skip",
          details: "known-harness-gap compaction-retry-mutating-tool: tracked",
        },
      }),
    ]);
    const { json, markdown } = reportFor(fixture, codexStatus);
    const validate = () => validateReport(fixture, json, markdown);
    if (codexStatus === "skip") {
      expect(validate()).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    } else {
      expect(validate).toThrow(
        "runtime-pair report scenarios do not match validated suite evidence",
      );
    }
  });
});
