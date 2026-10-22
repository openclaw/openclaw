import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  runQaSuite,
  startQaLabServer,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const SCENARIO_IDS = ["telemetry-qa-lab-bus", "telemetry-task-evidence-followthrough"] as const;
const PRIMARY_COVERAGE_IDS = [
  "evidence",
  "no-fake-progress",
  "qa-bus",
  "qa-lab",
  "task-followthrough",
].map((id) => `observability.telemetry-${id}`);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "writes exact bus telemetry and task followthrough evidence (codeMode=%s)",
  async (codeMode) => {
    const repoRoot = process.cwd();
    const artifactRoot = path.join(repoRoot, ".artifacts", "qa-e2e");
    await fs.mkdir(artifactRoot, { recursive: true });
    const outputDir = tempDirs.make("openclaw-telemetry-runtime-", artifactRoot);
    const runtime = await runQaSuite({
      alternateModel: "mock-openai/gpt-5.6-luna",
      concurrency: 1,
      mutateConfig: (cfg) => ({
        ...cfg,
        tools: { ...cfg.tools, codeMode: { enabled: codeMode } },
      }),
      outputDir,
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      scenarioIds: [...SCENARIO_IDS],
      startLab: startQaLabServer,
    });

    expect(runtime.executionKind).toBe("flow");
    expect(runtime.result.scenarios).toEqual(
      SCENARIO_IDS.map(() =>
        expect.objectContaining({
          name: expect.any(String),
          status: "pass",
          steps: [expect.objectContaining({ status: "pass" })],
        }),
      ),
    );

    const artifactText = await Promise.all(
      [runtime.result.summaryPath, runtime.result.evidencePath, runtime.result.reportPath].map(
        (file) => fs.readFile(file, "utf8"),
      ),
    );
    const summary: unknown = JSON.parse(artifactText[0]!);
    expect(summary).toEqual(
      expect.objectContaining({
        counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
        run: expect.objectContaining({
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          scenarioIds: [...SCENARIO_IDS],
        }),
        scenarios: SCENARIO_IDS.map(() => expect.objectContaining({ status: "pass" })),
      }),
    );

    const evidence = validateQaEvidenceSummaryJson(JSON.parse(artifactText[1]!));
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([...SCENARIO_IDS]);
    expect(
      evidence.entries
        .flatMap((entry) => entry.coverage)
        .filter((coverage) => coverage.role === "primary")
        .map((coverage) => coverage.id)
        .toSorted(),
    ).toEqual([...PRIMARY_COVERAGE_IDS].toSorted());

    for (const entry of evidence.entries) {
      expect(entry.result.status).toBe("pass");
      expect(entry.execution).toMatchObject({
        runner: "host",
        provider: {
          id: "openai",
          live: false,
          fixture: "mock-openai",
          model: {
            name: "gpt-5.6-luna",
            ref: "mock-openai/gpt-5.6-luna",
          },
        },
        channel: {
          id: "qa-channel",
          live: false,
        },
        packageSource: { kind: "source-checkout" },
      });
      expect(entry.execution?.environment).toEqual({
        ref: expect.any(String),
        os: expect.any(String),
        nodeVersion: expect.stringMatching(/^v\d+/u),
      });
      expect(entry.execution?.artifacts).toEqual([
        {
          kind: "scenario-observation",
          path: expect.stringMatching(/^artifacts\/occurrences\/[0-9a-f-]+\.json$/u),
          source: "qa-suite",
        },
        { kind: "summary", path: "qa-suite-summary.json", source: "qa-suite" },
        { kind: "report", path: "qa-suite-report.md", source: "qa-suite" },
      ]);
    }

    const serializedArtifacts = artifactText.join("\n");
    expect(serializedArtifacts).not.toContain(repoRoot);
    expect(serializedArtifacts).not.toMatch(
      /PERSONAL_TASK_LEDGER\.md|FOLLOWTHROUGH_NOTE\.md|QA_TELEMETRY_PROBE\.md/,
    );
    expect(path.basename(runtime.result.outputDir)).toMatch(/^openclaw-telemetry-runtime-/u);
  },
  180_000,
);
