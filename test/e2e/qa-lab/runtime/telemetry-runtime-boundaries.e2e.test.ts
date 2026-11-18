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
      mutateConfig: (cfg) => ({ ...cfg, tools: { ...cfg.tools, codeMode: { enabled: codeMode } } }),
      outputDir,
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      scenarioIds: [...SCENARIO_IDS],
      startLab: startQaLabServer,
    });

    const artifactText = await Promise.all(
      [runtime.result.summaryPath, runtime.result.evidencePath, runtime.result.reportPath].map(
        (file) => fs.readFile(file, "utf8"),
      ),
    );
    const evidence = validateQaEvidenceSummaryJson(JSON.parse(artifactText[1]!));
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([...SCENARIO_IDS]);

    for (const entry of evidence.entries) {
      expect(entry.result.status).toBe("pass");
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
  },
  180_000,
);
