import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { listSkillProposals, proposeCreateSkill } from "../workshop/service.js";
import {
  buildMetaAutoProposeCandidatesFromEvidence,
  META_AUTO_PROPOSE_SIGNAL_GATE_NAME,
  runMetaAutoPropose,
  selectAutoProposeCandidates,
} from "./auto-propose.js";
import { createMetaRunStore } from "./store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_BUNDLED_SKILLS_DIR = process.env.OPENCLAW_BUNDLED_SKILLS_DIR;

function useTempStateDir(): void {
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-meta-auto-propose-state-"),
  );
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-meta-auto-propose-workspace-"));
}

function writeSkillSync(params: {
  dir: string;
  name: string;
  description: string;
  body?: string;
}): void {
  fs.mkdirSync(params.dir, { recursive: true });
  fs.writeFileSync(
    path.join(params.dir, "SKILL.md"),
    [
      "---",
      `name: ${params.name}`,
      `description: ${params.description}`,
      "---",
      "",
      params.body ?? `# ${params.name}\n`,
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  closeOpenClawStateDatabase();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  if (ORIGINAL_BUNDLED_SKILLS_DIR === undefined) {
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = ORIGINAL_BUNDLED_SKILLS_DIR;
  }
});

function recordAutoProposeSignal(params: {
  runId: string;
  evidenceId: string;
  createdAtMs: number;
  key: string;
  name: string;
  description: string;
  content: string;
  trigger: string;
  risk?: "low" | "medium" | "high";
}): void {
  const store = createMetaRunStore();
  store.recordRunStarted({
    runId: params.runId,
    skillName: "meta-auto-propose-signal",
    skillKey: "meta-auto-propose-signal",
    inputJson: { key: params.key },
    createdAtMs: params.createdAtMs,
  });
  store.recordEvidence({
    evidenceId: params.evidenceId,
    runId: params.runId,
    gateName: META_AUTO_PROPOSE_SIGNAL_GATE_NAME,
    result: "passed",
    riskLevel: params.risk ?? "low",
    evidenceJson: {
      key: params.key,
      name: params.name,
      description: params.description,
      content: params.content,
      trigger: params.trigger,
      risk: params.risk ?? "low",
    },
    createdAtMs: params.createdAtMs + 1,
  });
  store.recordRunCompleted({
    runId: params.runId,
    status: "succeeded",
    finalText: `Recorded auto-propose signal for ${params.key}.`,
    completedAtMs: params.createdAtMs + 2,
  });
}

describe("selectAutoProposeCandidates", () => {
  it("selects frequent low-risk workflow candidates", () => {
    const selected = selectAutoProposeCandidates([
      {
        key: "weekly-brief",
        count: 4,
        risk: "low",
        hasOpenProposal: false,
        triggerCollision: false,
      },
      {
        key: "dangerous-deploy",
        count: 5,
        risk: "high",
        hasOpenProposal: false,
        triggerCollision: false,
      },
      {
        key: "duplicate",
        count: 5,
        risk: "low",
        hasOpenProposal: true,
        triggerCollision: false,
      },
    ]);
    expect(selected.map((candidate) => candidate.key)).toEqual(["weekly-brief"]);
  });
});

describe("runMetaAutoPropose", () => {
  it("creates governed Skill Workshop proposals for selected workflow candidates", async () => {
    useTempStateDir();
    const workspaceDir = makeWorkspace();

    const results = await runMetaAutoPropose({
      workspaceDir,
      candidates: [
        {
          key: "weekly-brief",
          name: "Weekly Brief",
          description: "Summarize weekly project updates",
          content: "# Weekly Brief\n\nSummarize the week's project updates.\n",
          triggers: ["weekly brief"],
          count: 4,
          risk: "low",
        },
        {
          key: "dangerous-deploy",
          description: "Deploy without checks",
          content: "# Dangerous Deploy\n",
          count: 8,
          risk: "high",
        },
      ],
    });

    const proposed = results.find((result) => result.candidate.key === "weekly-brief");
    expect(proposed?.proposal?.record).toMatchObject({
      status: "pending",
      kind: "create",
      target: {
        skillKey: "weekly-brief",
      },
      scan: {
        state: "clean",
      },
      goal: "Auto-propose reusable workflow: weekly-brief",
      evidence: "auto-propose candidate key=weekly-brief count=4 risk=low triggers=weekly brief",
    });
    expect(results.find((result) => result.candidate.key === "dangerous-deploy")).toMatchObject({
      skippedReason: "not-selected",
    });
    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
  });

  it("builds candidates from durable meta evidence signals before proposing", async () => {
    useTempStateDir();
    const workspaceDir = makeWorkspace();
    const description = "Summarize recurring release readiness updates";
    const content =
      "# Release Readiness Brief\n\nSummarize release risks, owners, blockers, and launch readiness.\n";

    recordAutoProposeSignal({
      runId: "run-signal-1",
      evidenceId: "signal-1",
      createdAtMs: 1_000,
      key: "release-readiness-brief",
      name: "Release Readiness Brief",
      description,
      content,
      trigger: "release readiness brief",
      risk: "low",
    });
    recordAutoProposeSignal({
      runId: "run-signal-2",
      evidenceId: "signal-2",
      createdAtMs: 1_100,
      key: "release-readiness-brief",
      name: "Release Readiness Brief",
      description,
      content,
      trigger: "release readiness brief",
      risk: "low",
    });
    recordAutoProposeSignal({
      runId: "run-signal-3",
      evidenceId: "signal-3",
      createdAtMs: 1_200,
      key: "release-readiness-brief",
      name: "Release Readiness Brief",
      description,
      content,
      trigger: "release readiness brief",
      risk: "medium",
    });

    const candidates = buildMetaAutoProposeCandidatesFromEvidence({
      store: createMetaRunStore(),
      minCount: 3,
    });
    expect(candidates).toEqual([
      {
        key: "release-readiness-brief",
        name: "Release Readiness Brief",
        description,
        content,
        triggers: ["release readiness brief"],
        count: 3,
        risk: "medium",
      },
    ]);

    const results = await runMetaAutoPropose({
      workspaceDir,
      candidates,
    });

    expect(results[0]?.proposal?.record).toMatchObject({
      status: "pending",
      kind: "create",
      target: {
        skillKey: "release-readiness-brief",
      },
      evidence:
        "auto-propose candidate key=release-readiness-brief count=3 risk=medium triggers=release readiness brief",
    });
    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
  });

  it("skips candidates that already have pending proposals or trigger collisions", async () => {
    useTempStateDir();
    const workspaceDir = makeWorkspace();
    await proposeCreateSkill({
      workspaceDir,
      name: "Weekly Brief",
      description: "Existing pending proposal",
      content: "# Weekly Brief\n\nExisting proposal.\n",
    });

    const results = await runMetaAutoPropose({
      workspaceDir,
      existingTriggers: ["daily recap"],
      candidates: [
        {
          key: "weekly-brief",
          name: "Weekly Brief",
          description: "Duplicate proposal",
          content: "# Weekly Brief\n\nDuplicate proposal.\n",
          count: 5,
          risk: "low",
        },
        {
          key: "daily-recap",
          description: "Recap daily work",
          content: "# Daily Recap\n\nSummarize daily work.\n",
          triggers: ["Daily Recap"],
          count: 5,
          risk: "low",
        },
      ],
    });

    expect(results.map((result) => [result.candidate.key, result.skippedReason])).toEqual([
      ["weekly-brief", "open-proposal"],
      ["daily-recap", "trigger-collision"],
    ]);
    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
  });

  it("creates update proposals for selected candidates that match writable live skills", async () => {
    useTempStateDir();
    const workspaceDir = makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "weekly-brief");
    writeSkillSync({
      dir: skillDir,
      name: "weekly-brief",
      description: "Existing weekly summary",
      body: "# Weekly Brief\n\nOld workflow.\n",
    });

    const results = await runMetaAutoPropose({
      workspaceDir,
      candidates: [
        {
          key: "weekly-brief",
          name: "Weekly Brief",
          description: "Summarize weekly project updates",
          content: "# Weekly Brief\n\nSummarize updates, blockers, owners, and next actions.\n",
          count: 5,
          risk: "low",
        },
      ],
    });

    expect(results[0]?.proposal?.record).toMatchObject({
      status: "pending",
      kind: "update",
      target: {
        skillKey: "weekly-brief",
        source: "openclaw-workspace",
      },
    });
    expect(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("Old workflow.");
  });

  it("skips selected candidates that match non-writable live skills", async () => {
    useTempStateDir();
    const workspaceDir = makeWorkspace();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-meta-bundled-skills-"));
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;
    writeSkillSync({
      dir: path.join(bundledDir, "weekly-brief"),
      name: "Weekly Brief",
      description: "Bundled weekly summary",
      body: "# Weekly Brief\n\nBundled workflow.\n",
    });

    const results = await runMetaAutoPropose({
      workspaceDir,
      candidates: [
        {
          key: "weekly-brief",
          name: "Weekly Brief",
          description: "Summarize weekly project updates",
          content: "# Weekly Brief\n\nSummarize updates, blockers, owners, and next actions.\n",
          count: 5,
          risk: "low",
        },
      ],
    });

    expect(results).toEqual([
      expect.objectContaining({
        skippedReason: "non-writable-skill",
      }),
    ]);
    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
  });
});
