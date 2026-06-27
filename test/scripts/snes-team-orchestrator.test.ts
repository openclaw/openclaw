import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyWorkerOutput,
  compactMemoryCards,
  createReviewerReceipt,
  createRepairPlan,
  dispatchWorker,
  exportWorkerPacket,
  initPccProject,
  judgeMilestone,
  listApprovals,
  modelHealth,
  parseAndValidateWorkerOutputText,
  pccNext,
  pccProjectDir,
  pccStatus,
  recordLastKnownGood,
  guardWriteSurfaces,
  pccDashboardSnapshot,
  pccTelemetry,
  requestApproval,
  resolvePccConflicts,
  runLivePcc,
  runPccUntilBlocked,
  runRegressionBenchmark,
  runSnesTeam,
  setRunControl,
  updateArtifactCache,
  validateAssetIntentContract,
  validateWorkerOutput,
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

function apiResponse(payload: unknown) {
  return JSON.stringify({ response: JSON.stringify(payload) });
}

function dispatchIdFromCurlArgs(args: string[]) {
  const payloadIndex = args.indexOf("-d");
  const payload = payloadIndex >= 0 ? args[payloadIndex + 1] : args.join(" ");
  const match = payload.match(/\\"dispatchId\\":\\"([^\\"]+)/);
  return match?.[1] ?? "unknown";
}

function validWorkerOutput(project: string, milestoneId: string, dispatchId: string) {
  return {
    format: "openclaw-snes-pcc-worker-output-v1",
    status: "pass",
    project,
    milestoneId,
    dispatchId,
    patchType: "receipt-only",
    writes: [],
    receipts: [
      {
        proofName: "blueprintReceipt",
        path: `receipts/${milestoneId}-blueprintReceipt.json`,
        content: {
          status: "pass",
          proofName: "blueprintReceipt",
          hostedGlmUsed: false,
          gpt55Used: false,
        },
      },
      {
        proofName: "legalBoundaryReceipt",
        path: `receipts/${milestoneId}-legalBoundaryReceipt.json`,
        content: {
          status: "pass",
          proofName: "legalBoundaryReceipt",
          hostedGlmUsed: false,
          gpt55Used: false,
        },
      },
    ],
    assumptions: ["clean-room local model output"],
    risks: ["runtime proof remains separate"],
    playtestHypothesis: "PCC judge should pass this receipt-only milestone.",
    commercialMaterialUsed: false,
    fxpakWritePerformed: false,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
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
      "approval-queue.json",
      "run-control.json",
      "run-history.json",
      "model-usage.json",
      "build-history.json",
      "latest-run-summary.md",
      "latest-summary.md",
      "worker-dispatch-log.json",
      "worker-sandboxes.json",
      "patch-ledger.json",
      "artifact-cache.json",
      "reviewer-receipts.json",
      "conflict-receipts.json",
      "telemetry.json",
      "dashboard-snapshot.json",
      "regression-benchmarks.json",
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

  it("creates approval requests, suppresses duplicates, and rejects invalid approval types", () => {
    const { root, project } = initDemo();
    const approval = requestApproval({
      project,
      root,
      milestoneId: "PCC-050-human-visual-approval",
      approvalType: "human-production-visual-approval",
      reason: "human visual gate",
      risk: "subjective production approval",
      requestedAction: "review screenshots",
    });
    expect(approval).toMatchObject({ status: "pass", ok: true, duplicateSuppressed: false });
    expect(approval.approval.status).toBe("pending");

    const duplicate = requestApproval({
      project,
      root,
      milestoneId: "PCC-050-human-visual-approval",
      approvalType: "human-production-visual-approval",
    });
    expect(duplicate).toMatchObject({ status: "pass", ok: true, duplicateSuppressed: true });

    const approvals = listApprovals({ project, root });
    expect(approvals.pendingApprovals).toHaveLength(1);

    const invalid = requestApproval({
      project,
      root,
      milestoneId: "PCC-001-blueprint",
      approvalType: "bad-approval-type",
    });
    expect(invalid).toMatchObject({ status: "blocked", ok: false });
    expect(invalid.blocker).toBe("invalid-approval-type:bad-approval-type");
  });

  it("exports bounded worker packets only for ready milestones", () => {
    const { root, project } = initDemo();
    const ready = exportWorkerPacket({ project, root, milestoneId: "PCC-001-blueprint" });
    expect(ready).toMatchObject({ status: "pass", ok: true, milestoneId: "PCC-001-blueprint" });
    expect(ready.forbiddenActions).toContain("hosted-glm-without-approval");
    expect(ready.nextValidationCommand).toContain("--mode judge");

    const blocked = exportWorkerPacket({ project, root, milestoneId: "PCC-010-level-plan" });
    expect(blocked).toMatchObject({ status: "blocked", ok: false, blocker: "milestone-not-ready" });
  });

  it("pauses, resumes, and cancels PCC runs", () => {
    const { root, project } = initDemo();
    expect(setRunControl({ project, root, action: "pause" })).toMatchObject({ status: "pass" });
    expect(runPccUntilBlocked({ project, root, maxMilestones: 1, maxMinutes: 10 })).toMatchObject({
      status: "blocked",
      stopReason: "run-paused",
    });

    expect(setRunControl({ project, root, action: "resume" })).toMatchObject({ status: "pass" });
    expect(setRunControl({ project, root, action: "cancel" })).toMatchObject({ status: "pass" });
    expect(runPccUntilBlocked({ project, root, maxMilestones: 1, maxMinutes: 10 })).toMatchObject({
      status: "blocked",
      stopReason: "run-cancelled",
    });
  });

  it("runs until repair, approval, or completion and writes run summaries", () => {
    const { root, project, pccDir } = initDemo();
    const first = runPccUntilBlocked({ project, root, maxMilestones: 1, maxMinutes: 10 });
    expect(first.status).toBe("blocked");
    expect(first.stopReason).toBe("repair-created");
    expect(fs.existsSync(path.join(pccDir, "latest-run-summary.md"))).toBe(true);
    const history = readJson<{ runs: Array<{ stopReason: string }> }>(
      path.join(pccDir, "run-history.json"),
    );
    expect(history.runs.at(-1)?.stopReason).toBe("repair-created");

    passMilestone(root, project, "PCC-001-blueprint");
    passMilestone(root, project, "PCC-010-level-plan");
    passMilestone(root, project, "PCC-011-gameplay-plan");
    const approvalStop = runPccUntilBlocked({ project, root, maxMilestones: 10, maxMinutes: 10 });
    expect(approvalStop.status).toBe("blocked");
    expect(approvalStop.stopReason).toBe("approval-required");
    expect(approvalStop.approvalsRequested).toHaveLength(1);

    const complete = initDemo("complete-demo");
    for (const id of [
      "PCC-001-blueprint",
      "PCC-010-level-plan",
      "PCC-011-gameplay-plan",
      "PCC-012-asset-intents",
      "PCC-013-audio-plan",
      "PCC-014-hardware-plan",
      "PCC-020-integration",
      "PCC-030-rom-build-proof",
      "PCC-040-runtime-proof",
      "PCC-050-human-visual-approval",
      "PCC-060-package-readiness",
    ]) {
      passMilestone(complete.root, complete.project, id);
    }
    const done = runPccUntilBlocked({
      project: complete.project,
      root: complete.root,
      maxMilestones: 10,
      maxMinutes: 10,
    });
    expect(done).toMatchObject({
      status: "pass",
      stopReason: "all-milestones-complete-or-none-ready",
    });
  });

  it("dispatches workers with sandbox contracts and guards write surfaces", () => {
    const { root, project } = initDemo();
    const dry = dispatchWorker({ project, root, milestoneId: "PCC-001-blueprint", dryRun: true });
    expect(dry).toMatchObject({ status: "pass", ok: true });
    expect(dry.dispatch.modelInvoked).toBe(false);
    expect(dry.sandbox.allowedWriteSurfaces).toContain("blueprint");

    const guardPass = guardWriteSurfaces({
      beforeFiles: ["docs/reference/snes-studio-workflow.md"],
      afterFiles: ["docs/reference/snes-studio-workflow.md", "blueprint/receipt.json"],
      allowedWriteSurfaces: ["blueprint"],
    });
    expect(guardPass.status).toBe("pass");

    const guardBlocked = guardWriteSurfaces({
      beforeFiles: [],
      afterFiles: ["music-creator-v1/state/private-key.pem"],
      allowedWriteSurfaces: ["blueprint"],
    });
    expect(guardBlocked.status).toBe("blocked");
    expect(guardBlocked.secretChanges).toHaveLength(1);
  });

  it("runs local worker adapter, applies schema-valid output, and records telemetry", () => {
    const { root, project, pccDir } = initDemo();
    const dispatch = dispatchWorker({
      project,
      root,
      milestoneId: "PCC-001-blueprint",
      dryRun: false,
      localOnly: true,
    });
    expect(dispatch.status).toBe("pass");
    expect(dispatch.dispatch.workerOutputPath).toBeTruthy();

    const applied = applyWorkerOutput({
      project,
      root,
      workerOutputPath: dispatch.dispatch.workerOutputPath,
    });
    expect(applied.status).toBe("pass");
    expect(applied.judge.failReasons).toEqual([]);
    expect(
      fs.existsSync(path.join(pccDir, "receipts/PCC-001-blueprint-blueprintReceipt.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(pccDir, "receipts/PCC-001-blueprint-legalBoundaryReceipt.json")),
    ).toBe(true);

    const telemetry = pccTelemetry({ project, root });
    expect(telemetry.status).toBe("pass");
    expect(telemetry.eventCount).toBeGreaterThan(0);
  });

  it("updates cache, reviewer receipts, conflicts, memory cards, dashboard, and benchmark", () => {
    const { root, project } = initDemo();
    expect(
      updateArtifactCache({
        project,
        root,
        cacheKey: "asset-check:hero",
        inputSha: "input-sha",
        outputPath: "artifacts/hero.json",
      }),
    ).toMatchObject({ status: "pass" });

    expect(
      createReviewerReceipt({
        project,
        root,
        milestoneId: "PCC-001-blueprint",
        reviewerRole: "domain-reviewer",
      }),
    ).toMatchObject({ status: "pass", ok: true });

    expect(
      resolvePccConflicts({ patches: [{ files: ["a.json"] }, { files: ["b.json"] }] }),
    ).toMatchObject({ status: "pass" });
    expect(
      resolvePccConflicts({ patches: [{ files: ["a.json"] }, { files: ["a.json"] }] }),
    ).toMatchObject({ status: "blocked" });

    expect(compactMemoryCards({ project, root })).toMatchObject({ status: "pass" });
    expect(pccDashboardSnapshot({ project, root })).toMatchObject({ status: "pass", ok: true });
    expect(runRegressionBenchmark({ project, root })).toMatchObject({ status: "pass", ok: true });
  });

  it("runs live local PCC path through bounded worker dispatch", () => {
    const { root, project } = initDemo();
    const live = runLivePcc({
      project,
      root,
      maxMilestones: 1,
      maxMinutes: 10,
      maxParallel: 4,
      localOnly: true,
    });
    expect(live.format).toBe("openclaw-snes-pcc-live-run-v1");
    expect(live.localOnly).toBe(true);
    expect(live.hostedGlmUsed).toBe(false);
    expect(live.dispatches[0].status).toBe("pass");
    expect(live.applications[0].status).toBe("pass");
    expect(live.completedMilestones).toEqual(["PCC-001-blueprint"]);
  });

  it("probes local model health with an injected Ollama runner", () => {
    const { root, project } = initDemo();
    const fakeSpawn = (command: string) => {
      if (command === "ollama") {
        return {
          status: 0,
          stdout:
            "NAME ID SIZE MODIFIED\nopenclaw-control-qwen3-30b-q6-chatfix:latest abc 1GB now\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        stdout: apiResponse({ status: "pass", ok: true }),
        stderr: "",
      } as ReturnType<typeof spawnSync>;
    };
    const health = modelHealth({ project, root, spawn: fakeSpawn, timeoutSeconds: 1 });
    expect(health.status).toBe("pass");
    expect(health.downloadsAttempted).toBe(false);
    expect(health.hostedGlmUsed).toBe(false);
    expect(health.probes.some((probe) => probe.status === "pass")).toBe(true);
  });

  it("validates strict worker output and rejects unsafe variants", () => {
    const valid = validWorkerOutput("demo", "PCC-001-blueprint", "dispatch-1");
    expect(
      validateWorkerOutput({
        output: valid,
        project: "demo",
        milestoneId: "PCC-001-blueprint",
        dispatchId: "dispatch-1",
        allowedWriteSurfaces: ["blueprint"],
        requiredProof: [{ name: "blueprintReceipt" }, { name: "legalBoundaryReceipt" }],
      }),
    ).toMatchObject({ status: "pass", ok: true });

    expect(
      parseAndValidateWorkerOutputText({
        text: "not json",
        project: "demo",
        milestoneId: "PCC-001-blueprint",
      }).errors,
    ).toContain("invalid-json");

    expect(
      validateWorkerOutput({
        output: { ...valid, hostedGlmUsed: true },
        project: "demo",
        milestoneId: "PCC-001-blueprint",
        dispatchId: "dispatch-1",
        allowedWriteSurfaces: ["blueprint"],
        requiredProof: [{ name: "blueprintReceipt" }, { name: "legalBoundaryReceipt" }],
      }).errors,
    ).toContain("hosted-glm-rejected");

    expect(
      validateWorkerOutput({
        output: { ...valid, writes: [{ path: "music-creator-v1/state/private-key.pem" }] },
        project: "demo",
        milestoneId: "PCC-001-blueprint",
        dispatchId: "dispatch-1",
        allowedWriteSurfaces: ["blueprint"],
        requiredProof: [{ name: "blueprintReceipt" }, { name: "legalBoundaryReceipt" }],
      }).errors,
    ).toContain("secret-like-write:music-creator-v1/state/private-key.pem");
  });

  it("invokes a real-model path through an injected local Ollama runner", () => {
    const { root, project, pccDir } = initDemo();
    let capturedPayload = "";
    const fakeSpawn = (command: string, args: string[]) => {
      if (command === "curl") {
        const dispatchId = dispatchIdFromCurlArgs(args);
        capturedPayload = args.join(" ");
        return {
          status: 0,
          stdout: apiResponse(validWorkerOutput(project, "PCC-001-blueprint", dispatchId)),
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, stdout: "", stderr: "unexpected command" } as ReturnType<
        typeof spawnSync
      >;
    };
    const dispatch = dispatchWorker({
      project,
      root,
      milestoneId: "PCC-001-blueprint",
      dryRun: false,
      localOnly: true,
      invokeLocalModels: true,
      spawn: fakeSpawn,
      timeoutSeconds: 1,
    });
    expect(dispatch.status).toBe("pass");
    expect(dispatch.dispatch.modelInvoked).toBe(true);
    expect(capturedPayload).toContain("api/generate");

    const applied = applyWorkerOutput({
      project,
      root,
      workerOutputPath: dispatch.dispatch.workerOutputPath,
    });
    expect(applied.status).toBe("pass");
    expect(applied.patch.modelInvoked).toBe(true);
    expect(
      fs.existsSync(path.join(pccDir, "receipts/PCC-001-blueprint-blueprintReceipt.json")),
    ).toBe(true);
  });

  it("repairs malformed local model output before applying it", () => {
    const { root, project } = initDemo();
    let callCount = 0;
    const fakeSpawn = (_command: string, args: string[]) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          status: 0,
          stdout: JSON.stringify({ response: "not json" }),
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        stdout: apiResponse(
          validWorkerOutput(project, "PCC-001-blueprint", dispatchIdFromCurlArgs(args)),
        ),
        stderr: "",
      } as ReturnType<typeof spawnSync>;
    };
    const dispatch = dispatchWorker({
      project,
      root,
      milestoneId: "PCC-001-blueprint",
      dryRun: false,
      localOnly: true,
      invokeLocalModels: true,
      spawn: fakeSpawn,
      timeoutSeconds: 1,
    });
    expect(dispatch.status).toBe("pass");
    expect(dispatch.dispatch.modelInvocation.attempts).toHaveLength(2);
    expect(dispatch.dispatch.modelInvocation.attempts[0].status).toBe("fail");
  });

  it("runs live PCC with real-model flag through injected local model output", () => {
    const { root, project } = initDemo();
    const fakeSpawn = (_command: string, args: string[]) =>
      ({
        status: 0,
        stdout: apiResponse(
          validWorkerOutput(project, "PCC-001-blueprint", dispatchIdFromCurlArgs(args)),
        ),
        stderr: "",
      }) as ReturnType<typeof spawnSync>;
    const live = runLivePcc({
      project,
      root,
      maxMilestones: 1,
      maxMinutes: 10,
      maxParallel: 4,
      localOnly: true,
      invokeLocalModels: true,
      spawn: fakeSpawn,
      timeoutSeconds: 1,
    });
    expect(live.status).toBe("pass");
    expect(live.invokeLocalModels).toBe(true);
    expect(live.dispatches[0].dispatch.modelInvoked).toBe(true);
    expect(live.completedMilestones).toEqual(["PCC-001-blueprint"]);
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
    for (const mode of [
      "status",
      "next",
      "validate",
      "approvals",
      "telemetry",
      "dashboard-snapshot",
      "regression-benchmark",
    ]) {
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

    const runProcess = spawnSync(
      process.execPath,
      [
        script,
        "--mode",
        "run",
        "--project",
        project,
        "--root",
        root,
        "--max-milestones",
        "1",
        "--max-minutes",
        "10",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(runProcess.status).toBe(1);
    const run = JSON.parse(runProcess.stdout);
    expect(run.status).toBe("blocked");

    const dispatch = JSON.parse(
      execFileSync(
        process.execPath,
        [
          script,
          "--mode",
          "dispatch-worker",
          "--project",
          project,
          "--milestone",
          "PCC-001-blueprint",
          "--root",
          root,
          "--dry-run",
          "--json",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(dispatch.status).toBe("pass");
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
