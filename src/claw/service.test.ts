import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { createClawMissionService } from "./service.js";

function agentResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 1,
    },
  };
}

function createMemoryTaskFlowStore(): TaskFlowRegistryStore {
  let flows = new Map<string, TaskFlowRecord>();
  return {
    loadSnapshot: () => ({
      flows: new Map([...flows.entries()].map(([flowId, flow]) => [flowId, structuredClone(flow)])),
    }),
    saveSnapshot: (snapshot) => {
      flows = new Map(
        [...snapshot.flows.entries()].map(([flowId, flow]) => [flowId, structuredClone(flow)]),
      );
    },
    upsertFlow: (flow) => {
      flows.set(flow.flowId, structuredClone(flow));
    },
    deleteFlow: (flowId) => {
      flows.delete(flowId);
    },
    close: () => {
      flows.clear();
    },
  };
}

function createConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "openai/gpt-5.4",
      },
    },
    plugins: {
      entries: {
        browser: { enabled: true },
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("createClawMissionService", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claw-service-"));
    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({ store: createMemoryTaskFlowStore() });
  });

  afterEach(async () => {
    resetTaskFlowRegistryForTests({ persist: false });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("creates a mission packet and dashboard snapshot", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
    });
    const created = await service.createMission({
      goal: "Build a goal-oriented Claw mission runner for this repository.",
    });

    expect(created.mission?.status).toBe("awaiting_approval");
    expect(created.mission?.decisions).toHaveLength(1);
    expect(created.inbox).toHaveLength(1);
    expect(created.missions).toHaveLength(1);

    const missionDir = created.mission?.missionDir;
    expect(missionDir).toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "MISSION.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "PROJECT_STATUS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "PRECHECKS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "DECISIONS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "mission-state.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(missionDir!, "AUDIT_LOG.jsonl"))).resolves.toBeTruthy();
  });

  it("transitions a mission through approve, pause, resume, and cancel", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
    });
    const created = await service.createMission({
      goal: "Continuously execute the approved mission until it is done or truly blocked.",
    });
    const missionId = created.mission?.id;
    expect(missionId).toBeTruthy();

    const approved = await service.approveMissionStart(missionId!);
    expect(approved.mission?.status).toBe("queued");
    expect(approved.mission?.startedAt).toBeNull();

    const paused = await service.pauseMission(missionId!, "Operator intervention");
    expect(paused.mission?.status).toBe("paused");

    const resumed = await service.resumeMission(missionId!);
    expect(resumed.mission?.status).toBe("queued");

    const cancelled = await service.cancelMission(missionId!, "No longer needed");
    expect(cancelled.mission?.status).toBe("cancelled");
    expect(cancelled.mission?.endedAt).toBeTruthy();

    const audit = await service.getAudit(missionId!);
    expect(audit.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "mission.created",
        "decision.requested",
        "decision.resolved",
        "mission.paused",
        "mission.resumed",
        "mission.cancelled",
      ]),
    );
  });

  it("blocks mission start when the default model is missing", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () =>
        createConfig({
          agents: {
            defaults: {
              model: undefined,
            },
          },
        }),
    });

    const created = await service.createMission({
      goal: "Run a mission only after preflight has a configured model.",
    });

    expect(created.mission?.status).toBe("awaiting_setup");
    expect(created.mission?.blockedSummary).toContain("Configure agents.defaults.model");
    expect(created.inbox).toHaveLength(1);
    expect(created.inbox[0]?.title).toBe("Resolve preflight blockers");
  });

  it("blocks mission start when exec/process tool exposure is missing", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () =>
        createConfig({
          tools: {
            deny: ["exec", "process"],
          },
        }),
    });

    const created = await service.createMission({
      goal: "Run a mission with full-access runtime tools available.",
    });

    expect(created.mission?.status).toBe("awaiting_setup");
    expect(created.mission?.blockedSummary).toContain("exec tool");
    expect(created.mission?.preflight.some((check) => check.id === "exec-tool")).toBe(true);
    expect(created.mission?.preflight.some((check) => check.id === "process-tool")).toBe(true);
  });

  it("applies global pause to active missions", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
    });

    const created = await service.createMission({
      goal: "Start a mission and verify global controls reconcile the state.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);

    await service.pauseAll();
    const pausedDashboard = await service.buildDashboard();
    expect(pausedDashboard.missions[0]?.status).toBe("paused");
    expect(pausedDashboard.missions[0]?.currentStep).toBe("Paused by global control.");

    await service.pauseAll(false);
    const resumedDashboard = await service.buildDashboard();
    expect(resumedDashboard.control.pauseAll).toBe(false);
    expect(resumedDashboard.missions[0]?.status).toBe("queued");
    expect(resumedDashboard.missions[0]?.currentStep).toBe(
      "Queued after the global control was cleared.",
    );
  });

  it("applies emergency stop to active missions", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
    });

    const created = await service.createMission({
      goal: "Start a mission and verify emergency stop reconciliation.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);

    await service.stopAllNow();
    const stoppedDashboard = await service.buildDashboard();
    expect(stoppedDashboard.missions[0]?.status).toBe("paused");
    expect(stoppedDashboard.missions[0]?.currentStep).toBe("Emergency stop requested by operator.");
  });

  it("rejects resuming a cancelled mission", async () => {
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
    });

    const created = await service.createMission({
      goal: "Reject invalid state transitions after terminal mission states.",
    });
    const missionId = created.mission!.id;
    await service.cancelMission(missionId, "No longer needed");

    await expect(service.resumeMission(missionId)).rejects.toThrow(
      'Cannot resume mission from status "cancelled".',
    );
  });

  it("runs a queued mission through the runner and verifier cycle", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "verify",
            summary: "The runner believes the mission is complete.",
            currentStep: "Ready for verification.",
            nextStep: "Run the fresh verification pass.",
            progress: true,
            evidence: ["Implemented the requested changes."],
          }),
        ),
      )
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "done",
            summary: "All explicit done criteria are satisfied.",
            evidence: ["Verified against PROJECT_DONE_CRITERIA.md."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Execute a mission end to end with a fresh verifier pass.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);

    const firstCycle = await service.runNextMissionCycle();
    expect(firstCycle?.mission?.status).toBe("verifying");

    const secondCycle = await service.runNextMissionCycle();
    expect(secondCycle?.mission?.status).toBe("done");
    expect(secondCycle?.mission?.endedAt).toBeTruthy();
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);

    const audit = await service.getAudit(missionId);
    expect(audit.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "mission.started",
        "mission.runnerCycle",
        "mission.verifying",
        "mission.verifierCycle",
        "mission.done",
      ]),
    );
  });

  it("honors claw.requiredVerifier=false and completes without a verifier run", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "verify",
          summary: "The runner completed the mission and does not need a verifier.",
          currentStep: "Ready to complete.",
          nextStep: "Mark the mission done.",
          progress: true,
          evidence: ["Completed the requested work."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () =>
        createConfig({
          claw: {
            requiredVerifier: false,
          },
        }),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Finish a mission without requiring a verifier pass.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);

    const cycle = await service.runNextMissionCycle();
    expect(cycle?.mission?.status).toBe("done");
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps plan and task files in sync with mission progress", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "The runner updated the implementation and should keep going.",
          currentStep: "Update the mission packet with the latest checkpoint.",
          nextStep: "Continue implementing the next repository change.",
          progress: true,
          evidence: ["Checkpointed the latest progress."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Keep the mission packet aligned with the current execution state.",
    });
    const mission = created.mission!;
    await service.approveMissionStart(mission.id);
    await service.runNextMissionCycle();

    const plan = await fs.readFile(path.join(mission.missionDir, "PROJECT_PLAN.md"), "utf-8");
    const tasks = await fs.readFile(path.join(mission.missionDir, "PROJECT_TASKS.md"), "utf-8");

    expect(plan).toContain("Continue implementing the next repository change.");
    expect(tasks).toContain("Execute the current mission objective");
    expect(tasks).toContain("Continue implementing the next repository change.");
  });

  it("marks running missions as recovering and resumes them on the next cycle", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValue(
        agentResult(
          JSON.stringify({
            outcome: "continue",
            summary: "The runner made progress and should keep going.",
            currentStep: "Continue mission execution.",
            nextStep: "Keep executing the next task.",
            progress: true,
            evidence: ["Recovered and continued execution."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Resume an interrupted mission safely after startup recovery.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    expect(recovered?.mission?.status).toBe("recovering");

    const resumed = await service.runNextMissionCycle();
    expect(resumed?.mission?.status).toBe("running");
    expect(resumed?.mission?.currentStep).toBe("Keep executing the next task.");
  });
});
