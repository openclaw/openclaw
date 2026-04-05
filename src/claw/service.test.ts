import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles.js";
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
    expect(created.mission?.decisions[0]?.title).toBe("Approve unattended continuation");
    expect(created.mission?.decisions[0]?.summary).toContain("continue autonomously");
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

  it("blocks unattended continuation when the default model is missing", async () => {
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

  it("blocks unattended continuation when exec/process tool exposure is missing", async () => {
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

  it("blocks browser-required missions when browser readiness is missing", async () => {
    const inspectBrowserReadiness = vi.fn().mockResolvedValue({
      ready: false,
      summary: "Browser control did not report a ready state.",
      detail: "CDP handshake failed.",
    });
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      inspectBrowserReadiness,
    });

    const created = await service.createMission({
      goal: "Open the website in the browser, log in, and verify the result.",
    });

    expect(created.mission?.status).toBe("awaiting_setup");
    expect(created.mission?.blockedSummary).toContain("Browser control");
    expect(
      created.mission?.preflight.find((check) => check.id === "browser-runtime")?.detail,
    ).toContain("CDP handshake failed");
    expect(inspectBrowserReadiness).toHaveBeenCalledTimes(1);
  });

  it("blocks unattended continuation until required external readiness is proven and reuses it later", async () => {
    const agentDir = path.join(workspaceDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const config = createConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "main",
            default: true,
            agentDir,
          },
        ],
      },
    });
    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => config,
    });

    const blocked = await service.createMission({
      goal: "Push the branch to GitHub and open a pull request for this change.",
    });
    expect(blocked.mission?.status).toBe("awaiting_setup");
    expect(blocked.mission?.blockedSummary).toContain("GitHub");
    expect(
      blocked.mission?.preflight.find((check) => check.id === "likely-auth")?.detail,
    ).toContain("GitHub: credentials are not proven");

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "github:default": {
            type: "api_key",
            provider: "github",
            key: "ghp_test_token",
          },
        },
      },
      agentDir,
    );

    const rerun = await service.rerunPreflight(blocked.mission!.id);
    expect(rerun.mission?.status).toBe("awaiting_approval");
    expect(rerun.mission?.blockedSummary).toBeNull();
    expect(rerun.mission?.preflight.find((check) => check.id === "likely-auth")?.status).toBe(
      "ready",
    );

    const second = await service.createMission({
      goal: "Push the current branch to GitHub and open a pull request with a summary.",
    });
    expect(second.mission?.status).toBe("awaiting_approval");
    expect(second.mission?.blockedSummary).toBeNull();
    expect(
      second.mission?.preflight.find((check) => check.id === "likely-auth")?.summary,
    ).toContain("GitHub");
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

  it("claims queued missions up to claw.maxActiveMissions and keeps the cap stable", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "The runner made bounded progress.",
          currentStep: "Continue mission execution.",
          nextStep: "Advance the next repository change.",
          progress: true,
          evidence: ["Captured a bounded execution checkpoint."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () =>
        createConfig({
          claw: {
            maxActiveMissions: 2,
          },
        }),
      runEmbeddedPiAgent,
    });

    const first = await service.createMission({
      goal: "Implement the first approved Claw mission.",
    });
    const second = await service.createMission({
      goal: "Implement the second approved Claw mission.",
    });
    const third = await service.createMission({
      goal: "Implement the third approved Claw mission.",
    });
    await service.approveMissionStart(first.mission!.id);
    await service.approveMissionStart(second.mission!.id);
    await service.approveMissionStart(third.mission!.id);

    const firstDrain = await service.runMissionCycles();
    expect(firstDrain).toHaveLength(2);
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);

    const firstDashboard = await service.buildDashboard();
    expect(firstDashboard.missions.filter((mission) => mission.status === "running")).toHaveLength(
      2,
    );
    expect(firstDashboard.missions.filter((mission) => mission.status === "queued")).toHaveLength(
      1,
    );

    const secondDrain = await service.runMissionCycles();
    expect(secondDrain).toHaveLength(2);
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(4);

    const secondDashboard = await service.buildDashboard();
    expect(secondDashboard.missions.filter((mission) => mission.status === "running")).toHaveLength(
      2,
    );
    expect(secondDashboard.missions.filter((mission) => mission.status === "queued")).toHaveLength(
      1,
    );
  });

  it("uses a bounded planning pass to generate a mission-specific packet", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          summary: "Implement the requested Claw scope with a focused execution plan.",
          scopeIn: [
            "Implement the requested Claw mission behavior in the current repository.",
            "Keep the Control UI mission packet aligned with runtime progress.",
          ],
          scopeOut: ["Telegram channel work."],
          phases: [
            "Inspect the current Claw runtime and mission files.",
            "Implement the requested mission behavior and controls.",
            "Verify the result against explicit done criteria.",
          ],
          tasks: [
            "Inspect the existing Claw runtime and Control UI surfaces.",
            "Implement the requested mission behavior in the repository.",
            "Verify the outcome and record durable evidence.",
          ],
          doneCriteria: [
            "The requested Claw behavior is implemented in the repository.",
            "The mission packet and audit trail reflect the final state.",
            "A fresh verifier can confirm the requested outcome.",
          ],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () =>
        createConfig({
          claw: {
            enabled: true,
          },
        }),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Implement the requested Claw mission behavior in this repository.",
    });
    const mission = created.mission!;

    const scope = await fs.readFile(path.join(mission.missionDir, "PROJECT_SCOPE.md"), "utf-8");
    const plan = await fs.readFile(path.join(mission.missionDir, "PROJECT_PLAN.md"), "utf-8");
    const tasks = await fs.readFile(path.join(mission.missionDir, "PROJECT_TASKS.md"), "utf-8");
    const done = await fs.readFile(
      path.join(mission.missionDir, "PROJECT_DONE_CRITERIA.md"),
      "utf-8",
    );

    expect(scope).toContain("Implement the requested Claw mission behavior");
    expect(plan).toContain("focused execution plan");
    expect(tasks).toContain("Inspect the existing Claw runtime and Control UI surfaces.");
    expect(done).toContain("fresh verifier");
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(mission.status).toBe("awaiting_approval");
    expect(mission.decisions[0]?.summary).toContain("continue autonomously");

    const audit = await service.getAudit(mission.id);
    expect(audit.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        "mission.packetPlanned",
        "mission.preflighting",
        "decision.requested",
      ]),
    );
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
    expect(tasks).toContain("## Current Focus");
    expect(tasks).toContain("Continue implementing the next repository change.");
  });

  it("blocks interrupted verifier recoveries when prior mission evidence exists", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "verify",
            summary: "The runner finished the mission and requested verification.",
            currentStep: "Ready for verification.",
            nextStep: "Run the verifier.",
            progress: true,
            evidence: ["Runner completed the requested work."],
          }),
        ),
      )
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "done",
            summary: "Verification passed after recovery.",
            evidence: ["Verifier confirmed the done criteria."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Require operator confirmation before replaying interrupted verifier work.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    expect(recovered?.mission?.status).toBe("blocked");
    expect(
      recovered?.mission?.decisions.some(
        (decision) => decision.kind === "recovery_uncertain" && decision.status === "pending",
      ),
    ).toBe(true);
    expect(recovered?.mission?.blockedSummary).toContain("partially applied side effects");
  });

  it("auto-resumes untouched active missions after restart", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "Runner picked up the initial mission cycle after recovery.",
          currentStep: "Continue mission execution.",
          nextStep: "Advance the next task.",
          progress: true,
          evidence: ["Resumed the first active cycle after recovery."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Auto-resume untouched active missions after a restart.",
    });
    const missionId = created.mission!.id;
    const approved = await service.approveMissionStart(missionId);
    const statePath = path.join(approved.mission!.missionDir, "mission-state.json");
    const rawState = JSON.parse(await fs.readFile(statePath, "utf-8")) as Record<string, unknown>;
    rawState.status = "running";
    rawState.currentStep = "Mission execution cycle started.";
    rawState.startedAt = rawState.startedAt ?? new Date().toISOString();
    rawState.runCycleCount = 0;
    rawState.verifyCycleCount = 0;
    rawState.recentEvidence = [];
    rawState.lastFailureSummary = null;
    rawState.lastVerifierRejectionSignature = null;
    rawState.blockedSummary = null;
    await fs.writeFile(statePath, `${JSON.stringify(rawState, null, 2)}\n`, "utf-8");

    const recovered = await service.recoverInterruptedMissions();
    expect(recovered?.mission?.status).toBe("recovering");
    expect(
      recovered?.mission?.decisions.some(
        (decision) => decision.kind === "recovery_uncertain" && decision.status === "pending",
      ),
    ).toBe(false);

    const resumed = await service.runNextMissionCycle();
    expect(resumed?.mission?.status).toBe("running");
    expect(resumed?.mission?.currentStep).toBe("Advance the next task.");
  });

  it("blocks uncertain running recoveries and creates a recovery decision", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "The runner made progress and should keep going.",
          currentStep: "Continue mission execution.",
          nextStep: "Keep executing the next task.",
          progress: true,
          evidence: ["Updated the repository state before restart."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Block uncertain recoveries until the operator confirms continuation.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    expect(recovered?.mission?.status).toBe("blocked");
    expect(recovered?.mission?.currentStep).toBe(
      "Awaiting operator confirmation before resuming recovery.",
    );
    expect(recovered?.mission?.blockedSummary).toContain("operator confirmation");
    expect(
      recovered?.mission?.decisions.some(
        (decision) => decision.kind === "recovery_uncertain" && decision.status === "pending",
      ),
    ).toBe(true);

    const nextCycle = await service.runNextMissionCycle();
    expect(nextCycle).toBeNull();
  });

  it("lets the operator continue an uncertain recovery", async () => {
    const runEmbeddedPiAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "continue",
            summary: "The runner made progress and should keep going.",
            currentStep: "Continue mission execution.",
            nextStep: "Keep executing the next task.",
            progress: true,
            evidence: ["Updated the repository state before restart."],
          }),
        ),
      )
      .mockResolvedValueOnce(
        agentResult(
          JSON.stringify({
            outcome: "continue",
            summary: "The runner resumed after the operator approved recovery.",
            currentStep: "Continue mission execution.",
            nextStep: "Advance the next task.",
            progress: true,
            evidence: ["Resumed mission execution after confirmation."],
          }),
        ),
      );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Continue uncertain recoveries only after operator confirmation.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
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
    expect(continued.mission?.decisions.find((entry) => entry.id === decision!.id)?.status).toBe(
      "resolved",
    );

    const resumed = await service.runNextMissionCycle();
    expect(resumed?.mission?.status).toBe("running");
    expect(resumed?.mission?.currentStep).toBe("Advance the next task.");
  });

  it("lets the operator pause an uncertain recovery", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "The runner made progress and should keep going.",
          currentStep: "Continue mission execution.",
          nextStep: "Keep executing the next task.",
          progress: true,
          evidence: ["Updated the repository state before restart."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Allow the operator to pause uncertain recoveries.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    const decision = recovered?.mission?.decisions.find(
      (entry) => entry.kind === "recovery_uncertain" && entry.status === "pending",
    );
    expect(decision?.id).toBeTruthy();

    const paused = await service.replyDecision({
      missionId,
      decisionId: decision!.id,
      action: "pause",
    });
    expect(paused.mission?.status).toBe("paused");
  });

  it("lets the operator cancel an uncertain recovery", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValueOnce(
      agentResult(
        JSON.stringify({
          outcome: "continue",
          summary: "The runner made progress and should keep going.",
          currentStep: "Continue mission execution.",
          nextStep: "Keep executing the next task.",
          progress: true,
          evidence: ["Updated the repository state before restart."],
        }),
      ),
    );

    const service = createClawMissionService({
      resolveWorkspaceDir: () => workspaceDir,
      loadConfig: () => createConfig(),
      runEmbeddedPiAgent,
    });

    const created = await service.createMission({
      goal: "Allow the operator to cancel uncertain recoveries.",
    });
    const missionId = created.mission!.id;
    await service.approveMissionStart(missionId);
    await service.runNextMissionCycle();

    const recovered = await service.recoverInterruptedMissions();
    const decision = recovered?.mission?.decisions.find(
      (entry) => entry.kind === "recovery_uncertain" && entry.status === "pending",
    );
    expect(decision?.id).toBeTruthy();

    const cancelled = await service.replyDecision({
      missionId,
      decisionId: decision!.id,
      action: "cancel",
    });
    expect(cancelled.mission?.status).toBe("cancelled");
  });
});
