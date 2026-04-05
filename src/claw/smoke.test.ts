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

describe("claw smoke", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claw-smoke-"));
    resetTaskFlowRegistryForTests({ persist: false });
    configureTaskFlowRegistryRuntime({ store: createMemoryTaskFlowStore() });
  });

  afterEach(async () => {
    resetTaskFlowRegistryForTests({ persist: false });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("covers create, preflight, approve, run, verify, and control actions", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "verify",
            summary: "Runner completed the requested mission work.",
            currentStep: "Ready for verification.",
            nextStep: "Run the required verifier pass.",
            progress: true,
            evidence: ["Completed the requested repository change."],
          }),
        ),
      )
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "done",
            summary: "Verifier confirmed the done criteria.",
            evidence: ["PROJECT_DONE_CRITERIA.md is satisfied."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const controlMission = await service.createMission({
      goal: "Pause, resume, and cancel an approved Claw mission from the operator controls.",
    });
    expect(controlMission.mission?.preflight.length).toBeGreaterThan(0);
    const controlMissionId = controlMission.mission!.id;
    await service.approveMissionStart(controlMissionId);

    const paused = await service.pauseMission(controlMissionId, "Smoke pause");
    expect(paused.mission?.status).toBe("paused");

    const resumed = await service.resumeMission(controlMissionId);
    expect(resumed.mission?.status).toBe("queued");

    const cancelled = await service.cancelMission(controlMissionId, "Smoke cancel");
    expect(cancelled.mission?.status).toBe("cancelled");

    const executableMission = await service.createMission({
      goal: "Implement the requested Claw mission flow and verify the outcome.",
    });
    const missionId = executableMission.mission!.id;
    await service.approveMissionStart(missionId);

    const firstCycle = await service.runNextMissionCycle();
    expect(firstCycle?.mission?.status).toBe("verifying");

    const secondCycle = await service.runNextMissionCycle();
    expect(secondCycle?.mission?.status).toBe("done");
    expect(secondCycle?.mission?.endedAt).toBeTruthy();

    const audit = await service.getAudit(missionId);
    expect(audit.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "mission.created",
        "mission.preflighting",
        "decision.requested",
        "decision.resolved",
        "mission.started",
        "mission.runnerCycle",
        "mission.verifying",
        "mission.verifierCycle",
        "mission.done",
      ]),
    );
  });

  it("covers the recovery_uncertain path and operator continuation", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "continue",
            summary: "Runner changed repository state before restart.",
            currentStep: "Continue mission execution.",
            nextStep: "Advance the next repository change.",
            progress: true,
            evidence: ["Changed files before restart."],
          }),
        ),
      )
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "continue",
            summary: "Runner resumed after operator confirmation.",
            currentStep: "Continue mission execution.",
            nextStep: "Continue after confirmed recovery.",
            progress: true,
            evidence: ["Resumed after operator confirmation."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Resume an interrupted Claw mission only after operator confirmation when recovery is uncertain.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    expect(recovered?.mission?.status).toBe("blocked");
    const decision = recovered?.mission?.decisions.find(
      (entry) => entry.kind === "recovery_uncertain" && entry.status === "pending",
    );
    expect(decision?.id).toBeTruthy();

    const continued = await service.replyDecision({
      missionId,
      decisionId: decision!.id,
      action: "continue",
    });
    expect(continued.mission?.status).toBe("queued");

    const resumed = await service.runNextMissionCycle();
    expect(resumed?.mission?.status).toBe("running");
    expect(resumed?.mission?.currentStep).toBe("Continue after confirmed recovery.");
  });
});
