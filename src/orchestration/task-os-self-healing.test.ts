import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { createCanonicalTaskWork } from "./task-os-arbitration.js";
import {
  buildSelfHealingPacket,
  decideSelfHealing,
  executeSelfHealingPacket,
  recordSelfHealingDecision,
} from "./task-os-self-healing.js";

async function writeControlPlaneFixture(home: string, options?: { allowCode?: boolean }) {
  const policyDir = path.join(home, "control-plane");
  const approvalMatrixPath = path.join(home, "approval-matrix.json");
  const rolloutFlagsPath = path.join(home, "rollout-flags.json");
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, "channel-policy.json"),
    JSON.stringify(
      { schema_version: 1, stage: "topology", policy_version: "test", channels: [] },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(policyDir, "trigger-ranking.json"),
    JSON.stringify(
      { schema_version: 1, stage: "topology", policy_version: "test", signals: [] },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(policyDir, "persona-routing.json"),
    JSON.stringify(
      { schema_version: 1, stage: "topology", policy_version: "test", personas: [] },
      null,
      2,
    ),
  );
  await fs.writeFile(
    approvalMatrixPath,
    JSON.stringify(
      {
        schema_version: 1,
        stage: "topology",
        policy_version: "test",
        entries: [
          {
            action_class: "execute",
            decision: options?.allowCode ? "allow" : "approve",
            approval_route: options?.allowCode ? "none" : "telegram_approval",
          },
        ],
        system_authority_matrix: [
          {
            id: "github",
            actions: [
              {
                id: "code",
                action_class: "execute",
                decision: options?.allowCode ? "allow" : "approve",
                approval_route: options?.allowCode ? "none" : "telegram_approval",
              },
            ],
          },
        ],
        source_of_truth: {
          precedence: ["ledger", "execution_state", "external_artifact_links", "raw_source_events"],
          layers: [],
          systems: [
            {
              id: "github",
              layer: "external_artifact_links",
              reconciliation_mode: "linked_issue",
              promote_to_task_truth: false,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    rolloutFlagsPath,
    JSON.stringify(
      {
        policy_version: "test",
        lanes: [
          { id: "self_healing", enabled: true },
          { id: "artifact_adapters", enabled: false },
          { id: "approval_inbox", enabled: true },
        ],
      },
      null,
      2,
    ),
  );
  return {
    OPENCLAW_CONTROL_PLANE_DIR: policyDir,
    OPENCLAW_APPROVAL_MATRIX_PATH: approvalMatrixPath,
    OPENCLAW_PROJECTS_ROOT: home,
    OPENCLAW_ROLLOUT_FLAGS_PATH: rolloutFlagsPath,
  };
}

function buildTask() {
  const now = "2026-04-09T12:00:00.000Z";
  return {
    id: "task-self-heal",
    title: "Fix task os collector drift",
    status: "pending" as const,
    dependencies: [],
    acceptanceCriteria: [],
    evidence: [],
    verificationHistory: [],
    canonicalWork: createCanonicalTaskWork(
      {
        source: {
          sourceKind: "github",
          signalKind: "review_requested",
          sourceId: "openclaw/openclaw#500",
          idempotencyKey: "github-500",
          title: "Fix task os collector drift",
          summary: "task os collector failure needs triage",
          confidence: { score: 0.9, reason: "ci issue" },
          observedAt: now,
        },
      },
      now,
    ),
    createdAt: now,
    updatedAt: now,
  };
}

describe("task-os self healing", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CONTROL_PLANE_DIR;
    delete process.env.OPENCLAW_APPROVAL_MATRIX_PATH;
    delete process.env.OPENCLAW_PROJECTS_ROOT;
    delete process.env.OPENCLAW_ROLLOUT_FLAGS_PATH;
    delete process.env.OPENCLAW_SELF_HEAL_TIMEOUT_MS;
  });

  it("builds a bounded diagnostic packet for eligible failures", async () => {
    await withTempHome(async (home) => {
      Object.assign(process.env, await writeControlPlaneFixture(home));
      const packet = buildSelfHealingPacket(buildTask(), {
        taskId: "task-self-heal",
        title: "Fix task os collector drift",
        persona: "cto",
        urgency: "high",
        cadence: "daily",
        score: 88,
        signalId: "goal_deadline",
        sourceKind: "github",
        confidence: { score: 0.9, label: "high" },
        whyNow: "Deadline-oriented work is still open",
        followUp: "Draft the implementation plan",
        notification: {
          status: "ready",
          lowValue: false,
          key: "k",
          fingerprint: "f",
          dedupeSeconds: 1,
          reason: "ok",
        },
      } as const);

      expect(packet.fixClass).toBe("rerun_task_os_tests");
      expect(packet.command).toEqual([
        "pnpm",
        "test",
        "--",
        "src/orchestration/task-os-store.test.ts",
        "src/orchestration/task-os-live-collector.test.ts",
      ]);
      expect(packet.approval.decision).toBe("approve");
    });
  });

  it("escalates when the repo is already red for unrelated failures", async () => {
    await withTempHome(async (home) => {
      Object.assign(process.env, await writeControlPlaneFixture(home));
      const decision = decideSelfHealing({
        task: buildTask(),
        priority: {
          taskId: "task-self-heal",
          title: "Fix task os collector drift",
          persona: "cto",
          urgency: "high",
          cadence: "daily",
          score: 88,
          signalId: "goal_deadline",
          sourceKind: "github",
          confidence: { score: 0.9, label: "high" },
          whyNow: "Deadline-oriented work is still open",
          followUp: "Draft the implementation plan",
          notification: {
            status: "ready",
            lowValue: false,
            key: "k",
            fingerprint: "f",
            dedupeSeconds: 1,
            reason: "ok",
          },
        } as const,
        unrelatedRepoRed: true,
        repeatedFailures: 0,
      });

      expect(decision.outcome).toBe("escalate");
      expect(decision.reason).toContain("unrelated failures");
    });
  });

  it("auto-executes only when policy explicitly allows the bounded fix class", async () => {
    await withTempHome(async (home) => {
      const env = await writeControlPlaneFixture(home, { allowCode: true });
      Object.assign(process.env, env);
      vi.resetModules();
      const storeModule = await import("./task-os-store.js");
      const storePath = storeModule.resolveTaskOsStorePath();
      const fixtureTask = buildTask();
      const fixtureSource = fixtureTask.canonicalWork.sources[0];
      if (!fixtureSource) {
        throw new Error("fixture source missing");
      }
      const task = await storeModule.createTask({
        id: fixtureTask.id,
        title: fixtureTask.title,
        canonicalWork: { source: fixtureSource },
      });
      const decision = decideSelfHealing({
        task,
        priority: {
          taskId: task.id,
          title: task.title,
          persona: "cto",
          urgency: "high",
          cadence: "daily",
          score: 88,
          signalId: "goal_deadline",
          sourceKind: "github",
          confidence: { score: 0.9, label: "high" },
          whyNow: "Deadline-oriented work is still open",
          followUp: "Draft the implementation plan",
          notification: {
            status: "ready",
            lowValue: false,
            key: "k",
            fingerprint: "f",
            dedupeSeconds: 1,
            reason: "ok",
          },
        } as const,
        unrelatedRepoRed: false,
        repeatedFailures: 0,
        env,
      });

      expect(decision.outcome).toBe("auto_execute");
      await recordSelfHealingDecision({ task, decision, storePath });

      const reloaded = await storeModule.loadTaskOsStore(storePath);
      expect(
        reloaded.tasks[0]?.evidence.some((entry) => entry.kind === "self_healing_packet"),
      ).toBe(true);
    });
  });

  it("times out bounded commands instead of hanging forever", async () => {
    const previous = process.env.OPENCLAW_SELF_HEAL_TIMEOUT_MS;
    process.env.OPENCLAW_SELF_HEAL_TIMEOUT_MS = "50";
    try {
      const result = await executeSelfHealingPacket({
        taskId: "task-timeout",
        signalId: "service_anomaly",
        fixClass: "rerun_openclaw_build",
        summary: "timeout test",
        whyNow: "timeout test",
        followUp: "none",
        command: ["node", "-e", "setTimeout(()=>{}, 1000)"],
        cwd: process.cwd(),
        auditKey: "self-healing:timeout",
        rollbackKey: "rollback:self-healing:timeout",
        approval: { decision: "allow" },
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("timed out after");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_SELF_HEAL_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_SELF_HEAL_TIMEOUT_MS = previous;
      }
    }
  });
});
