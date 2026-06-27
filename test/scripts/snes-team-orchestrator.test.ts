import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRepairPlan,
  initPccProject,
  judgeMilestone,
  pccNext,
  pccProjectDir,
  pccStatus,
  recordLastKnownGood,
  runSnesTeam,
  validateAssetIntentContract,
  validatePccProject,
} from "../../scripts/lib/snes-team-orchestrator.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snes-pcc-"));
}

function writePrompt(root: string, text = "Make a legal clean-room SNES platformer.") {
  const promptPath = path.join(root, "prompt.txt");
  fs.writeFileSync(promptPath, text);
  return promptPath;
}

type TestMilestone = {
  milestoneId: string;
  status: string;
  completionPercent: number;
  requiredProof: Array<string | { name: string }>;
  proof: Record<string, string>;
  humanApprovalRequired?: boolean;
  workerRole?: string;
  judgeRole?: string;
  allowedWriteSurfaces: string[];
};

type TestLedger = { milestones: TestMilestone[] };

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function initDemo(project = "demo") {
  const root = tempRoot();
  const promptPath = writePrompt(root);
  const report = initPccProject({ project, promptPath, root });
  expect(report.status).toBe("pass");
  return { root, project, pccDir: pccProjectDir({ project, root }) };
}

function passMilestone(root: string, project: string, milestoneId: string) {
  const pccDir = pccProjectDir({ project, root });
  const ledgerPath = path.join(pccDir, "milestone-ledger.json");
  const ledger = readJson<TestLedger>(ledgerPath);
  const milestone = ledger.milestones.find((entry) => entry.milestoneId === milestoneId);
  expect(milestone).toBeTruthy();
  milestone.status = "pass";
  milestone.completionPercent = 100;
  milestone.proof = {};
  for (const entry of milestone.requiredProof) {
    const name = typeof entry === "string" ? entry : entry.name;
    const proofPath = `pass-receipts/${milestoneId}-${name}.json`;
    fs.mkdirSync(path.join(pccDir, "pass-receipts"), { recursive: true });
    fs.writeFileSync(path.join(pccDir, proofPath), JSON.stringify({ status: "pass", name }));
    milestone.proof[name] = proofPath;
  }
  if (milestone.humanApprovalRequired) {
    const proofPath = `pass-receipts/${milestoneId}-humanVisualApproval.json`;
    fs.writeFileSync(path.join(pccDir, proofPath), JSON.stringify({ status: "pass", score: 100 }));
    milestone.proof.humanVisualApproval = proofPath;
  }
  writeJson(ledgerPath, ledger);
}

describe("SNES PCC team orchestrator", () => {
  it("initializes durable PCC state and preserves it on rerun", () => {
    const root = tempRoot();
    const project = "demo-pcc";
    const promptPath = writePrompt(root, "Make a colorful clean-room SNES game.");
    const first = initPccProject({ project, promptPath, root });
    expect(first).toMatchObject({ status: "pass", ok: true, initialized: true });

    const pccDir = pccProjectDir({ project, root });
    for (const name of [
      "project.intent.json",
      "milestone-ledger.json",
      "dependency-dag.json",
      "active-worker-locks.json",
      "decision-log.json",
      "memory-cards.json",
      "repair-queue.json",
      "model-usage.json",
      "build-history.json",
      "latest-summary.md",
    ]) {
      expect(fs.existsSync(path.join(pccDir, name))).toBe(true);
    }

    const before = fs.readFileSync(path.join(pccDir, "milestone-ledger.json"), "utf8");
    const second = initPccProject({ project, promptPath, root });
    expect(second).toMatchObject({ status: "pass", ok: true, initialized: false });
    expect(fs.readFileSync(path.join(pccDir, "milestone-ledger.json"), "utf8")).toBe(before);
  });

  it("reports status, next milestone, and valid state", () => {
    const { root, project } = initDemo();
    expect(pccStatus({ project, root })).toMatchObject({
      status: "pass",
      nextMilestone: "PCC-001-blueprint",
    });
    expect(pccNext({ project, root })).toMatchObject({
      status: "pass",
      nextMilestone: "PCC-001-blueprint",
    });
    expect(validatePccProject({ project, root })).toMatchObject({
      status: "pass",
      ok: true,
      errors: [],
    });
  });

  it("returns blocked JSON instead of crashing for a missing project", () => {
    const root = tempRoot();
    const report = runSnesTeam({ mode: "status", project: "missing", root, json: true });
    expect(report).toMatchObject({ status: "blocked", ok: false, blocker: "project-not-found" });
  });

  it("validates milestone Definition of Done and rejects missing proof", () => {
    const { root, project, pccDir } = initDemo();
    const ledgerPath = path.join(pccDir, "milestone-ledger.json");
    const ledger = readJson<TestLedger>(ledgerPath);
    const milestone = ledger.milestones.find((entry) => entry.milestoneId === "PCC-001-blueprint");
    milestone.status = "pass";
    milestone.completionPercent = 100;
    milestone.proof = {};
    writeJson(ledgerPath, ledger);

    const validation = validatePccProject({ project, root });
    expect(validation.status).toBe("fail");
    expect(validation.errors).toContain("PCC-001-blueprint:missing-proof:blueprintReceipt");
  });

  it("judges pass, missing runtime proof, human approval blockers, and self-approval", () => {
    const { root, project, pccDir } = initDemo();
    passMilestone(root, project, "PCC-001-blueprint");
    expect(judgeMilestone({ project, root, milestoneId: "PCC-001-blueprint" })).toMatchObject({
      status: "pass",
      ok: true,
    });

    const ledgerPath = path.join(pccDir, "milestone-ledger.json");
    const ledger = readJson<TestLedger>(ledgerPath);
    const runtime = ledger.milestones.find(
      (entry) => entry.milestoneId === "PCC-040-runtime-proof",
    );
    runtime.status = "pass";
    runtime.completionPercent = 100;
    runtime.proof = {};
    const visual = ledger.milestones.find(
      (entry) => entry.milestoneId === "PCC-050-human-visual-approval",
    );
    visual.status = "pass";
    visual.completionPercent = 100;
    visual.proof = {};
    const self = ledger.milestones.find((entry) => entry.milestoneId === "PCC-010-level-plan");
    self.status = "pass";
    self.workerRole = "same-agent";
    self.judgeRole = "same-agent";
    self.proof = {};
    writeJson(ledgerPath, ledger);

    expect(
      judgeMilestone({ project, root, milestoneId: "PCC-040-runtime-proof" }).failReasons,
    ).toContain("missing-proof:emulatorScreenshotReceipt");
    expect(
      judgeMilestone({ project, root, milestoneId: "PCC-050-human-visual-approval" }),
    ).toMatchObject({
      status: "blocked",
      requiresHuman: true,
    });
    expect(
      judgeMilestone({ project, root, milestoneId: "PCC-010-level-plan" }).failReasons,
    ).toContain("worker-self-approval-rejected");
  });

  it("plans parallel workers after blueprint and serializes conflicting surfaces", () => {
    const { root, project, pccDir } = initDemo();
    passMilestone(root, project, "PCC-001-blueprint");
    const next = pccNext({ project, root, maxParallel: 4 });
    expect(next.parallelBatches[0]).toHaveLength(4);
    expect(next.serializedMilestones).toContain("PCC-014-hardware-plan");

    const ledgerPath = path.join(pccDir, "milestone-ledger.json");
    const ledger = readJson<TestLedger>(ledgerPath);
    const level = ledger.milestones.find((entry) => entry.milestoneId === "PCC-010-level-plan");
    const gameplay = ledger.milestones.find(
      (entry) => entry.milestoneId === "PCC-011-gameplay-plan",
    );
    gameplay.allowedWriteSurfaces = [...level.allowedWriteSurfaces];
    writeJson(ledgerPath, ledger);
    const conflicted = pccNext({ project, root, maxParallel: 4 });
    expect(conflicted.parallelBatches[0]).toContain("PCC-010-level-plan");
    expect(conflicted.serializedMilestones).toContain("PCC-011-gameplay-plan");
  });

  it("creates repair tasks, blocks external blockers, and blocks on the fourth retry", () => {
    const { root, project } = initDemo();
    const first = createRepairPlan({
      project,
      root,
      milestoneId: "PCC-010-level-plan",
      failureClass: "runtime-failure",
    });
    expect(first).toMatchObject({ status: "pass", ok: true });
    expect(first.repair.nextModel).toBe("ollama/openclaw-control-qwen3-30b-q6-chatfix:latest");

    const external = createRepairPlan({
      project,
      root,
      milestoneId: "PCC-011-gameplay-plan",
      failureClass: "external-blocker",
    });
    expect(external).toMatchObject({ status: "blocked", ok: false });

    createRepairPlan({
      project,
      root,
      milestoneId: "PCC-010-level-plan",
      failureClass: "runtime-failure",
    });
    createRepairPlan({
      project,
      root,
      milestoneId: "PCC-010-level-plan",
      failureClass: "runtime-failure",
    });
    const fourth = createRepairPlan({
      project,
      root,
      milestoneId: "PCC-010-level-plan",
      failureClass: "runtime-failure",
    });
    expect(fourth).toMatchObject({ status: "blocked", ok: false });
  });

  it("records last known good without overwriting it on failure", () => {
    const { root, project } = initDemo();
    const good = recordLastKnownGood({
      project,
      root,
      milestoneId: "PCC-030-rom-build-proof",
      receipt: {
        sourceHash: "source-sha",
        romHash: "rom-sha",
        assetHashes: ["asset-sha"],
        emulatorScreenshotHash: "shot-sha",
        passReceipts: ["pass.json"],
      },
    });
    createRepairPlan({
      project,
      root,
      milestoneId: "PCC-030-rom-build-proof",
      failureClass: "build-failure",
    });
    const buildHistory = readJson<{ lastKnownGood: unknown }>(
      path.join(pccProjectDir({ project, root }), "build-history.json"),
    );
    expect(buildHistory.lastKnownGood).toEqual(good);
  });

  it("validates production asset intent contracts", () => {
    expect(
      validateAssetIntentContract({
        assetId: "hero_walk",
        kind: "sprite",
        dimensions: "32x32",
        frames: 6,
        paletteLimit: 16,
        mustShow: ["readable face"],
        mustNotShow: ["placeholder box"],
        animationBeats: ["left foot", "right foot"],
        production: true,
        runtimeProofRequired: true,
        humanVisualTarget: 90,
      }),
    ).toMatchObject({ status: "pass", ok: true });

    const invalid = validateAssetIntentContract({
      assetId: "hero_walk",
      kind: "sprite",
      frames: 1,
      paletteLimit: 17,
      mustShow: [],
      mustNotShow: [],
      animationBeats: [],
      production: true,
    });
    expect(invalid.status).toBe("fail");
    expect(invalid.errors).toContain("missing-dimensions");
    expect(invalid.errors).toContain("production-runtimeProofRequired-missing");
  });

  it("exposes CLI JSON modes", () => {
    const root = tempRoot();
    const project = "cli-demo";
    const promptPath = writePrompt(root);
    const script = path.join(process.cwd(), "scripts/snes-team-orchestrator.mjs");
    const init = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--mode",
          "init",
          "--project",
          project,
          "--prompt",
          promptPath,
          "--root",
          root,
          "--json",
        ],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(init.status).toBe("pass");
    for (const mode of ["status", "next", "validate"]) {
      const report = JSON.parse(
        execFileSync(
          process.execPath,
          [script, "--mode", mode, "--project", project, "--root", root, "--json"],
          {
            encoding: "utf8",
          },
        ),
      );
      expect(report.status).toBe("pass");
    }
  });

  it("keeps SNES skill orchestration references discoverable", () => {
    for (const file of [
      ".agents/skills/snes-game-creator/references/production-orchestration.md",
      ".agents/skills/snes-game-creator/references/agent-routing.md",
      ".agents/skills/snes-game-creator/references/proof-gates.md",
      ".agents/skills/snes-game-creator/references/art-quality-rubric.md",
      ".agents/skills/snes-game-creator/references/prompt-to-rom-workflow.md",
    ]) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});
