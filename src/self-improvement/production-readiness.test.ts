import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSelfImprovementAuditEvent } from "./audit-events.js";
import { runSelfImprovementProductionCheck } from "./production-readiness.js";

const tempDirs: string[] = [];
const now = Date.parse("2026-05-07T12:00:00.000Z");

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-self-improvement-readiness-"));
  tempDirs.push(dir);
  return dir;
}

async function appendBackgroundReady(stateDir: string) {
  await appendSelfImprovementAuditEvent({
    stateDir,
    event: {
      createdAt: now,
      actor: "governor",
      kind: "background_cycle",
      targetId: "self-improvement-background",
      summary: "Completed Self-Improvement background cycle.",
      metadata: { success: true, analysisLimit: 25 },
    },
  });
}

describe("self-improvement production readiness", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("blocks required model and reviewer proof when proof events are missing", async () => {
    const stateDir = await tempStateDir();
    await appendBackgroundReady(stateDir);

    const result = await runSelfImprovementProductionCheck({
      stateDir,
      now,
      requireModelReady: true,
      requireEvalsReady: true,
    });

    expect(result.status).toBe("blocked");
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "Model readiness proof is required, but no model preflight event exists.",
        "Reviewer eval proof is required, but no reviewer eval event exists.",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("api_key=");
  });

  it("returns ready when health, model readiness, reviewer evals, and maintenance proof are ready", async () => {
    const stateDir = await tempStateDir();
    await appendBackgroundReady(stateDir);
    await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        createdAt: now,
        actor: "gateway",
        kind: "model_preflight",
        targetId: "self-improvement-models",
        summary: "Checked Self-Improvement model readiness: ready.",
        metadata: { readiness: "ready", ready: true },
      },
    });
    await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        createdAt: now,
        actor: "governor",
        kind: "reviewer_eval_run",
        targetId: "self-improvement-reviewer",
        summary: "Ran Self-Improvement reviewer evals: ready.",
        metadata: { readiness: "ready", ready: true, passRate: 1 },
      },
    });
    await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        createdAt: now,
        actor: "cli",
        kind: "retention_maintenance",
        targetId: "self-improvement-stores",
        summary: "Applied Self-Improvement retention maintenance.",
        metadata: { totalBefore: 1, totalAfter: 1, totalPruned: 0 },
      },
    });

    const result = await runSelfImprovementProductionCheck({
      stateDir,
      now,
      requireModelReady: true,
      requireEvalsReady: true,
    });

    expect(result.status).toBe("ready");
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.evidence.map((entry) => entry.key)).toContain("maintenance");
  });
});
