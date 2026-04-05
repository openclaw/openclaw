import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { createClawMissionService } from "./service.js";

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
    expect(approved.mission?.status).toBe("running");
    expect(approved.mission?.startedAt).toBeTruthy();

    const paused = await service.pauseMission(missionId!, "Operator intervention");
    expect(paused.mission?.status).toBe("paused");

    const resumed = await service.resumeMission(missionId!);
    expect(resumed.mission?.status).toBe("running");

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
    expect(resumedDashboard.missions[0]?.status).toBe("running");
    expect(resumedDashboard.missions[0]?.currentStep).toBe(
      "Mission execution resumed after global control was cleared.",
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
});
