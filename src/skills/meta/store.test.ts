import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createMetaRunStore } from "./store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

type MetaStoreTestDatabase = Pick<OpenClawStateKyselyDatabase, "meta_skill_steps">;

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-meta-store-"));
}

function useTempStateDir(): string {
  const stateDir = createTempStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return stateDir;
}

function recordStartedRunWithStep(
  store: ReturnType<typeof createMetaRunStore>,
  params: {
    runId: string;
    stepId: string;
    sessionKey?: string;
    createdAtMs: number;
  },
): void {
  store.recordRunStarted({
    runId: params.runId,
    skillName: "meta-demo",
    skillKey: "meta-demo",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    inputJson: { runId: params.runId },
    createdAtMs: params.createdAtMs,
  });
  store.recordStepFinished({
    runId: params.runId,
    stepId: params.stepId,
    kind: "user_input",
    status: "paused",
    inputJson: { runId: params.runId },
    outputJson: {},
    updatedAtMs: params.createdAtMs + 1,
  });
}

afterEach(() => {
  closeOpenClawStateDatabase();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    return;
  }
  process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
});

describe("meta run store", () => {
  it("records runs, steps, pauses, and evidence and reads them back", () => {
    useTempStateDir();
    const store = createMetaRunStore();

    store.recordRunStarted({
      runId: "run-1",
      skillName: "meta-demo",
      skillKey: "meta-demo",
      agentId: "agent-a",
      sessionKey: "session-1",
      agentRunId: "agent-run-1",
      channelTargetJson: { provider: "telegram", to: "chat-1" },
      workspaceContextJson: { workspaceDir: "/workspace/openclaw", cwd: "/workspace/openclaw" },
      inputJson: { task: "draft summary" },
      triggerJson: { pattern: "/meta-demo" },
      originalInputSummary: "draft summary",
      finalMode: "step:ask-user",
      createdAtMs: 1_000,
    });

    store.recordStepFinished({
      runId: "run-1",
      stepId: "classify",
      kind: "llm_classify",
      dependencyStateJson: { dependsOn: [], state: "succeeded" },
      status: "succeeded",
      inputJson: { task: "draft summary" },
      outputJson: { route: "ask-user" },
      startedAtMs: 1_050,
      updatedAtMs: 1_100,
    });

    store.recordStepFinished({
      runId: "run-1",
      stepId: "classify",
      kind: "llm_classify",
      dependencyStateJson: { dependsOn: [], state: "succeeded", satisfied: [] },
      status: "succeeded",
      inputJson: { task: "draft summary" },
      outputJson: { route: "ask-user", confidence: 0.9 },
      updatedAtMs: 1_200,
    });

    store.recordStepFinished({
      runId: "run-1",
      stepId: "ask-user",
      kind: "user_input",
      dependencyStateJson: { dependsOn: ["classify"], state: "paused", satisfied: ["classify"] },
      status: "paused",
      inputJson: { question: "Which section matters most?" },
      outputJson: { fields: ["audience"] },
      updatedAtMs: 1_250,
    });

    store.recordPause({
      pauseId: "pause-1",
      runId: "run-1",
      stepId: "ask-user",
      schemaJson: { type: "object", required: ["audience"] },
      sessionKey: "session-1",
      expiresAtMs: 5_000,
      createdAtMs: 1_300,
      prefillJson: { audience: "engineering" },
      confirmedFieldsJson: { audience: true },
      channelBindingJson: { provider: "telegram", to: "chat-1" },
    });

    store.recordEvidence({
      evidenceId: "evidence-2",
      runId: "run-1",
      gateName: "proposal-score",
      result: "pass",
      evidenceJson: { score: 0.94 },
      createdAtMs: 1_401,
    });

    store.recordEvidence({
      evidenceId: "evidence-1",
      runId: "run-1",
      stepId: "classify",
      proposalId: "proposal-1",
      gateName: "router-check",
      result: "warn",
      riskLevel: "medium",
      evidenceJson: { reason: "needs clarification" },
      artifactRefsJson: { proposalId: "proposal-1", stepId: "classify" },
      createdAtMs: 1_400,
    });

    store.recordRunCompleted({
      runId: "run-1",
      status: "paused",
      finalText: "Waiting for user input.",
      completedAtMs: 1_500,
    });

    expect(store.readRun("run-1")).toEqual({
      runId: "run-1",
      skillName: "meta-demo",
      skillKey: "meta-demo",
      agentId: "agent-a",
      sessionKey: "session-1",
      agentRunId: "agent-run-1",
      channelTargetJson: { provider: "telegram", to: "chat-1" },
      workspaceContextJson: { workspaceDir: "/workspace/openclaw", cwd: "/workspace/openclaw" },
      status: "paused",
      triggerJson: { pattern: "/meta-demo" },
      inputJson: { task: "draft summary" },
      originalInputSummary: "draft summary",
      finalMode: "step:ask-user",
      finalText: "Waiting for user input.",
      createdAtMs: 1_000,
      updatedAtMs: 1_500,
      completedAtMs: 1_500,
    });

    expect(store.readPendingPauseForSession("session-1", 1_350)).toEqual({
      pauseId: "pause-1",
      runId: "run-1",
      stepId: "ask-user",
      schemaJson: { type: "object", required: ["audience"] },
      prefillJson: { audience: "engineering" },
      confirmedFieldsJson: { audience: true },
      channelBindingJson: { provider: "telegram", to: "chat-1" },
      sessionKey: "session-1",
      status: "pending",
      expiresAtMs: 5_000,
      createdAtMs: 1_300,
      resumedAtMs: null,
    });

    expect(store.listSteps("run-1")).toEqual([
      {
        runId: "run-1",
        stepId: "classify",
        kind: "llm_classify",
        dependencyStateJson: { dependsOn: [], state: "succeeded", satisfied: [] },
        status: "succeeded",
        inputJson: { task: "draft summary" },
        outputJson: { route: "ask-user", confidence: 0.9 },
        errorJson: null,
        startedAtMs: 1_050,
        updatedAtMs: 1_200,
        completedAtMs: 1_200,
      },
      {
        runId: "run-1",
        stepId: "ask-user",
        kind: "user_input",
        dependencyStateJson: { dependsOn: ["classify"], state: "paused", satisfied: ["classify"] },
        status: "paused",
        inputJson: { question: "Which section matters most?" },
        outputJson: { fields: ["audience"] },
        errorJson: null,
        startedAtMs: null,
        updatedAtMs: 1_250,
        completedAtMs: 1_250,
      },
    ]);

    store.markPauseResumed({
      pauseId: "pause-1",
      confirmedFieldsJson: { audience: "platform engineers" },
      resumedAtMs: 1_600,
    });
    expect(store.readPendingPauseForSession("session-1", 1_650)).toBeNull();

    expect(store.listEvidence("run-1")).toEqual([
      {
        evidenceId: "evidence-1",
        runId: "run-1",
        stepId: "classify",
        proposalId: "proposal-1",
        gateName: "router-check",
        result: "warn",
        riskLevel: "medium",
        evidenceJson: { reason: "needs clarification" },
        artifactRefsJson: { proposalId: "proposal-1", stepId: "classify" },
        createdAtMs: 1_400,
      },
      {
        evidenceId: "evidence-2",
        runId: "run-1",
        stepId: null,
        proposalId: null,
        gateName: "proposal-score",
        result: "pass",
        riskLevel: null,
        evidenceJson: { score: 0.94 },
        artifactRefsJson: null,
        createdAtMs: 1_401,
      },
    ]);
    expect(store.listEvidenceByGate("router-check")).toEqual([
      {
        evidenceId: "evidence-1",
        runId: "run-1",
        stepId: "classify",
        proposalId: "proposal-1",
        gateName: "router-check",
        result: "warn",
        riskLevel: "medium",
        evidenceJson: { reason: "needs clarification" },
        artifactRefsJson: { proposalId: "proposal-1", stepId: "classify" },
        createdAtMs: 1_400,
      },
    ]);

    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<MetaStoreTestDatabase>(database.db);
    const stepRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("meta_skill_steps")
        .select(["run_id", "step_id", "status", "output_json", "updated_at_ms", "completed_at_ms"])
        .where("run_id", "=", "run-1")
        .where("step_id", "=", "classify"),
    );

    expect(stepRow).toMatchObject({
      run_id: "run-1",
      step_id: "classify",
      status: "succeeded",
      output_json: JSON.stringify({ route: "ask-user", confidence: 0.9 }),
      updated_at_ms: 1_200,
      completed_at_ms: 1_200,
    });
  });

  it("returns the latest unexpired pending pause for a session", () => {
    useTempStateDir();
    const store = createMetaRunStore();

    for (const [index, pair] of [
      ["run-1", "ask-a"],
      ["run-2", "ask-b"],
      ["run-3", "ask-c"],
    ].entries()) {
      const [runId, stepId] = pair;
      recordStartedRunWithStep(store, {
        runId,
        stepId,
        sessionKey: "session-1",
        createdAtMs: index + 1,
      });
    }

    store.recordPause({
      pauseId: "pause-expired",
      runId: "run-1",
      stepId: "ask-a",
      schemaJson: { type: "object" },
      sessionKey: "session-1",
      expiresAtMs: 150,
      createdAtMs: 100,
    });

    store.recordPause({
      pauseId: "pause-live-older",
      runId: "run-2",
      stepId: "ask-b",
      schemaJson: { type: "object", title: "older" },
      sessionKey: "session-1",
      expiresAtMs: 500,
      createdAtMs: 200,
    });

    store.recordPause({
      pauseId: "pause-live-latest",
      runId: "run-3",
      stepId: "ask-c",
      schemaJson: { type: "object", title: "latest" },
      sessionKey: "session-1",
      expiresAtMs: 700,
      createdAtMs: 300,
    });

    expect(store.readPendingPauseForSession("session-1", 250)?.pauseId).toBe("pause-live-latest");
    expect(store.readPendingPauseForSession("session-1", 650)?.pauseId).toBe("pause-live-latest");
    expect(store.readPendingPauseForSession("session-1", 750)).toBeNull();
  });

  it("rejects dangling step references for pauses and evidence", () => {
    useTempStateDir();
    const store = createMetaRunStore();
    store.recordRunStarted({
      runId: "run-1",
      skillName: "meta-demo",
      inputJson: {},
      createdAtMs: 100,
    });

    expect(() =>
      store.recordPause({
        pauseId: "pause-1",
        runId: "run-1",
        stepId: "missing-step",
        schemaJson: {},
        sessionKey: "session-1",
        expiresAtMs: 1_000,
        createdAtMs: 110,
      }),
    ).toThrow();

    expect(() =>
      store.recordEvidence({
        evidenceId: "evidence-1",
        runId: "run-1",
        stepId: "missing-step",
        gateName: "runtime_e2e",
        result: "failed",
        evidenceJson: {},
        createdAtMs: 120,
      }),
    ).toThrow();
  });

  it("does not rewrite immutable run, step, pause, or evidence identities", () => {
    useTempStateDir();
    const store = createMetaRunStore();
    recordStartedRunWithStep(store, {
      runId: "run-1",
      stepId: "ask-user",
      sessionKey: "session-1",
      createdAtMs: 100,
    });

    expect(() =>
      store.recordRunStarted({
        runId: "run-1",
        skillName: "different-meta",
        inputJson: { changed: true },
        createdAtMs: 200,
      }),
    ).toThrow();

    expect(() =>
      store.recordStepFinished({
        runId: "run-1",
        stepId: "ask-user",
        kind: "llm_chat",
        status: "succeeded",
        outputJson: { text: "changed" },
        updatedAtMs: 210,
      }),
    ).toThrow('cannot change step "ask-user" kind');

    store.recordPause({
      pauseId: "pause-1",
      runId: "run-1",
      stepId: "ask-user",
      schemaJson: {},
      sessionKey: "session-1",
      expiresAtMs: 1_000,
      createdAtMs: 220,
    });
    expect(() =>
      store.recordPause({
        pauseId: "pause-1",
        runId: "run-1",
        stepId: "ask-user",
        schemaJson: { changed: true },
        sessionKey: "session-2",
        expiresAtMs: 2_000,
        createdAtMs: 230,
      }),
    ).toThrow();

    store.recordEvidence({
      evidenceId: "evidence-1",
      runId: "run-1",
      stepId: "ask-user",
      gateName: "runtime_e2e",
      result: "passed",
      evidenceJson: {},
      createdAtMs: 240,
    });
    expect(() =>
      store.recordEvidence({
        evidenceId: "evidence-1",
        runId: "run-1",
        stepId: "ask-user",
        gateName: "runtime_e2e",
        result: "failed",
        evidenceJson: { changed: true },
        createdAtMs: 250,
      }),
    ).toThrow();

    expect(store.readRun("run-1")?.skillName).toBe("meta-demo");
    expect(store.readPendingPauseForSession("session-1", 300)?.pauseId).toBe("pause-1");
    expect(store.listEvidence("run-1")).toHaveLength(1);
  });
});
