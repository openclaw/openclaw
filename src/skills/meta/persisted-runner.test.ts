import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resumePersistedMetaPlan, runPersistedMetaPlan } from "./persisted-runner.js";
import { createMetaRunStore } from "./store.js";
import type { MetaPlan } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

type PersistedRunnerTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "meta_skill_steps" | "meta_skill_pauses"
>;

function useTempStateDir(): void {
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-meta-persisted-runner-"),
  );
}

function createClock(values: number[]): () => number {
  return () => {
    const value = values.shift();
    if (value === undefined) {
      throw new Error("test clock exhausted");
    }
    return value;
  };
}

function createIdFactory(values: string[]): () => string {
  return () => {
    const value = values.shift();
    if (!value) {
      throw new Error("test id factory exhausted");
    }
    return value;
  };
}

function readStepRows(runId: string) {
  const database = openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<PersistedRunnerTestDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("meta_skill_steps")
      .select([
        "step_id",
        "kind",
        "dependency_state_json",
        "status",
        "input_json",
        "output_json",
        "error_json",
        "started_at_ms",
      ])
      .where("run_id", "=", runId)
      .orderBy("step_id", "asc"),
  ).rows;
}

function readPauseRow(pauseId: string) {
  const database = openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<PersistedRunnerTestDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("meta_skill_pauses")
      .select(["pause_id", "status", "confirmed_fields_json", "resumed_at_ms"])
      .where("pause_id", "=", pauseId),
  ).rows[0];
}

afterEach(() => {
  closeOpenClawStateDatabase();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
    return;
  }
  process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
});

describe("runPersistedMetaPlan", () => {
  it("records completed runs and final step outputs in SQLite", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "meta-demo",
      description: "Demo",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}}",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Publish {{draft.text}}",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "publish" },
    } satisfies MetaPlan;

    const result = await runPersistedMetaPlan({
      store,
      runId: "run-1",
      agentId: "agent-main",
      sessionKey: "session-1",
      agentRunId: "agent-run-1",
      channelTargetJson: { provider: "telegram", to: "chat-1" },
      workspaceContextJson: { workspaceDir: "/workspace/openclaw" },
      triggerJson: { pattern: "demo" },
      nowMs: createClock([1_000, 1_500]),
      plan,
      input: { request: "Draft a SQLite note", topic: "SQLite" },
      executors: {
        llm_chat: () => ({ text: "Drafted SQLite" }),
        tool_call: ({ renderedPrompt }) => ({ text: renderedPrompt }),
      },
    });

    expect(result).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      finalText: "Publish Drafted SQLite",
    });
    expect(store.readRun("run-1")).toEqual({
      runId: "run-1",
      skillName: "meta-demo",
      skillKey: "meta-demo",
      agentId: "agent-main",
      sessionKey: "session-1",
      agentRunId: "agent-run-1",
      channelTargetJson: { provider: "telegram", to: "chat-1" },
      workspaceContextJson: { workspaceDir: "/workspace/openclaw" },
      status: "succeeded",
      triggerJson: { pattern: "demo" },
      inputJson: { request: "Draft a SQLite note", topic: "SQLite" },
      originalInputSummary: "Draft a SQLite note",
      finalMode: "step:publish",
      finalText: "Publish Drafted SQLite",
      createdAtMs: 1_000,
      updatedAtMs: 1_500,
      completedAtMs: 1_500,
    });
    expect(readStepRows("run-1")).toEqual([
      {
        step_id: "draft",
        kind: "llm_chat",
        dependency_state_json: JSON.stringify({
          dependsOn: [],
          state: "succeeded",
          satisfied: [],
        }),
        status: "succeeded",
        input_json: JSON.stringify({ prompt: "Draft SQLite" }),
        output_json: JSON.stringify({ text: "Drafted SQLite" }),
        error_json: null,
        started_at_ms: 1_000,
      },
      {
        step_id: "publish",
        kind: "tool_call",
        dependency_state_json: JSON.stringify({
          dependsOn: ["draft"],
          state: "succeeded",
          satisfied: ["draft"],
        }),
        status: "succeeded",
        input_json: JSON.stringify({ prompt: "Publish Drafted SQLite" }),
        output_json: JSON.stringify({ text: "Publish Drafted SQLite" }),
        error_json: null,
        started_at_ms: 1_000,
      },
    ]);
  });

  it("records failover recovery metadata in step error JSON", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "meta-failover",
      description: "Failover lifecycle",
      triggers: [],
      steps: [
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: [],
          toolName: "primary_publish",
          prompt: "Publish {{input.topic}}",
          onFailure: {
            kind: "failover",
            maxAttempts: 1,
            attempts: [
              {
                toolName: "backup_publish",
                prompt: "Backup {{input.topic}}",
              },
            ],
          },
        },
      ],
      finalTextMode: { kind: "step", stepId: "publish" },
    } satisfies MetaPlan;

    const result = await runPersistedMetaPlan({
      store,
      runId: "run-failover",
      nowMs: createClock([1_700, 1_800]),
      plan,
      input: { topic: "SQLite" },
      executors: {
        tool_call: ({ step, renderedPrompt }) => {
          if (step.toolName === "primary_publish") {
            throw new Error("primary failed");
          }
          return { text: renderedPrompt };
        },
      },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      finalText: "Backup SQLite",
    });
    expect(readStepRows("run-failover")).toEqual([
      {
        step_id: "publish",
        kind: "tool_call",
        dependency_state_json: JSON.stringify({
          dependsOn: [],
          state: "succeeded",
          satisfied: [],
        }),
        status: "succeeded",
        input_json: JSON.stringify({ prompt: "Backup SQLite" }),
        output_json: JSON.stringify({ text: "Backup SQLite" }),
        error_json: JSON.stringify({
          message: "primary failed",
          recovery: "failover",
        }),
        started_at_ms: 1_700,
      },
    ]);
  });

  it("records paused user_input runs with resumable pause state", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "clarify",
      description: "Collect missing details",
      triggers: [],
      steps: [
        {
          id: "ask",
          kind: "user_input",
          dependsOn: [],
          schema: { type: "object", required: ["topic"] },
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "ask" },
    } satisfies MetaPlan;

    const result = await runPersistedMetaPlan({
      store,
      runId: "run-paused",
      sessionKey: "session-clarify",
      channelBindingJson: { provider: "discord", to: "thread-1" },
      nowMs: createClock([2_000, 2_100]),
      createId: createIdFactory(["pause-1"]),
      pauseTtlMs: 500,
      plan,
      input: { topic: "prefilled" },
      executors: {
        user_input: () => ({
          __meta_pause__: true,
          schema: { type: "object", required: ["topic"] },
          prefill: { topic: "prefilled" },
        }),
      },
    });

    expect(result.status).toBe("paused");
    expect(store.readRun("run-paused")).toMatchObject({
      status: "paused",
      finalText: expect.stringContaining("paused"),
      completedAtMs: 2_100,
    });
    expect(store.readPendingPauseForSession("session-clarify", 2_200)).toEqual({
      pauseId: "pause-pause-1",
      runId: "run-paused",
      stepId: "ask",
      schemaJson: { type: "object", required: ["topic"] },
      prefillJson: { topic: "prefilled" },
      confirmedFieldsJson: null,
      channelBindingJson: { provider: "discord", to: "thread-1" },
      sessionKey: "session-clarify",
      status: "pending",
      expiresAtMs: 2_600,
      createdAtMs: 2_100,
      resumedAtMs: null,
    });
    expect(readStepRows("run-paused")).toMatchObject([
      {
        step_id: "ask",
        kind: "user_input",
        status: "paused",
      },
    ]);
  });

  it("records gate evidence for completed persisted runs", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "meta-gated",
      description: "Gated run",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}}",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "draft" },
    } satisfies MetaPlan;

    await runPersistedMetaPlan({
      store,
      runId: "run-gated",
      gateProposalId: "proposal-1",
      gateResults: [
        {
          name: "lint",
          result: "passed",
          summary: "no diagnostics",
          evidenceJson: { diagnostics: 0 },
        },
        {
          name: "runtime_e2e",
          result: "skipped",
          riskLevel: "medium",
          evidenceJson: { reason: "no interactive harness" },
          artifactRefsJson: { invocation: "manual://runtime-e2e/skipped" },
        },
      ],
      nowMs: createClock([4_000, 4_100]),
      createId: createIdFactory(["lint-1", "runtime-1"]),
      plan,
      input: { topic: "evidence" },
      executors: {
        llm_chat: () => ({ text: "Drafted evidence" }),
      },
    });

    expect(store.listEvidence("run-gated")).toEqual([
      {
        evidenceId: "gate-lint-1",
        runId: "run-gated",
        stepId: null,
        proposalId: "proposal-1",
        gateName: "lint",
        result: "passed",
        riskLevel: null,
        evidenceJson: {
          result: "passed",
          summary: "no diagnostics",
          diagnostics: 0,
        },
        artifactRefsJson: null,
        createdAtMs: 4_100,
      },
      {
        evidenceId: "gate-runtime-1",
        runId: "run-gated",
        stepId: null,
        proposalId: "proposal-1",
        gateName: "runtime_e2e",
        result: "skipped",
        riskLevel: "medium",
        evidenceJson: {
          result: "skipped",
          reason: "no interactive harness",
        },
        artifactRefsJson: { invocation: "manual://runtime-e2e/skipped" },
        createdAtMs: 4_100,
      },
    ]);
  });

  it("records gate evidence derived from completed run outputs", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "meta-derived-gates",
      description: "Derived gate run",
      triggers: [],
      steps: [
        {
          id: "proposal",
          kind: "tool_call",
          dependsOn: [],
          toolName: "skill_workshop",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "proposal" },
    } satisfies MetaPlan;

    await runPersistedMetaPlan({
      store,
      runId: "run-derived-gated",
      nowMs: createClock([4_200, 4_300]),
      createId: createIdFactory(["scan-1"]),
      plan,
      input: {},
      executors: {
        tool_call: () => ({
          text: "Created proposal",
          result: {
            details: {
              id: "proposal-derived",
              scanState: "clean",
            },
          },
        }),
      },
      deriveGateEvidence: ({ result }) => {
        const proposal = result.outputs.proposal;
        const toolResult = proposal?.result;
        const details =
          toolResult && typeof toolResult === "object" && !Array.isArray(toolResult)
            ? (toolResult as { details?: { id?: string; scanState?: string } }).details
            : undefined;
        if (!details?.id || !details.scanState) {
          return undefined;
        }
        return {
          proposalId: details.id,
          results: [
            {
              name: "skill_workshop_scan",
              result: "passed",
              evidenceJson: { scanState: details.scanState },
            },
          ],
        };
      },
    });

    expect(store.listEvidence("run-derived-gated")).toEqual([
      {
        evidenceId: "gate-scan-1",
        runId: "run-derived-gated",
        stepId: null,
        proposalId: "proposal-derived",
        gateName: "skill_workshop_scan",
        result: "passed",
        riskLevel: null,
        evidenceJson: {
          result: "passed",
          scanState: "clean",
        },
        artifactRefsJson: null,
        createdAtMs: 4_300,
      },
    ]);
  });

  it("leaves unexecuted downstream steps pending when a persisted run fails early", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "meta-fails-early",
      description: "Failure lifecycle",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft",
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["draft"],
          prompt: "Publish {{draft.text}}",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "publish" },
    } satisfies MetaPlan;

    const result = await runPersistedMetaPlan({
      store,
      runId: "run-fails-early",
      nowMs: createClock([4_400, 4_500]),
      plan,
      input: { topic: "lifecycle" },
      executors: {
        llm_chat: () => {
          throw new Error("draft failed");
        },
        tool_call: () => ({ text: "should not run" }),
      },
    });

    expect(result.status).toBe("failed");
    expect(readStepRows("run-fails-early")).toEqual([
      {
        step_id: "draft",
        kind: "llm_chat",
        dependency_state_json: JSON.stringify({ dependsOn: [], state: "failed", satisfied: [] }),
        status: "failed",
        input_json: JSON.stringify({ prompt: "Draft" }),
        output_json: null,
        error_json: JSON.stringify({ message: "draft failed" }),
        started_at_ms: 4_400,
      },
      {
        step_id: "publish",
        kind: "tool_call",
        dependency_state_json: JSON.stringify({ dependsOn: ["draft"], state: "pending" }),
        status: "pending",
        input_json: JSON.stringify({ topic: "lifecycle" }),
        output_json: null,
        error_json: null,
        started_at_ms: null,
      },
    ]);
  });

  it("resumes a paused run for the same session without rerunning prior steps", async () => {
    useTempStateDir();
    const store = createMetaRunStore();
    const plan = {
      name: "clarify-and-publish",
      description: "Draft, clarify, and publish",
      triggers: [],
      steps: [
        {
          id: "draft",
          kind: "llm_chat",
          dependsOn: [],
          prompt: "Draft {{input.topic}}",
          onFailure: { kind: "fail" },
        },
        {
          id: "ask",
          kind: "user_input",
          dependsOn: ["draft"],
          schema: { type: "object", required: ["audience"] },
          onFailure: { kind: "fail" },
        },
        {
          id: "publish",
          kind: "tool_call",
          dependsOn: ["draft", "ask"],
          prompt: "Publish {{draft.text}} for {{ask.audience}}",
          onFailure: { kind: "fail" },
        },
      ],
      finalTextMode: { kind: "step", stepId: "publish" },
    } satisfies MetaPlan;

    const first = await runPersistedMetaPlan({
      store,
      runId: "run-resume",
      sessionKey: "session-resume",
      nowMs: createClock([3_000, 3_100]),
      createId: createIdFactory(["ask-1"]),
      pauseTtlMs: 1_000,
      plan,
      input: { topic: "SQLite" },
      executors: {
        llm_chat: () => ({ text: "Drafted SQLite" }),
        user_input: () => ({
          __meta_pause__: true,
          schema: { type: "object", required: ["audience"] },
          prefill: { audience: "engineering" },
        }),
        tool_call: () => ({ text: "should not publish before resume" }),
      },
    });
    expect(first.status).toBe("paused");
    expect(store.readPendingPauseForSession("session-resume", 3_200)?.pauseId).toBe("pause-ask-1");

    const llmChat = vi.fn(() => ({ text: "should not rerun draft" }));
    const resumed = await resumePersistedMetaPlan({
      store,
      sessionKey: "session-resume",
      nowMs: createClock([3_200, 3_300]),
      plan,
      input: { audience: "platform engineers" },
      executors: {
        llm_chat: llmChat,
        user_input: ({ input }) => ({ audience: String(input.audience) }),
        tool_call: ({ renderedPrompt }) => ({ text: renderedPrompt }),
      },
    });

    expect(llmChat).not.toHaveBeenCalled();
    expect(resumed).toMatchObject({
      runId: "run-resume",
      status: "succeeded",
      finalText: "Publish Drafted SQLite for platform engineers",
      outputs: {
        draft: { text: "Drafted SQLite" },
        ask: { audience: "platform engineers" },
        publish: { text: "Publish Drafted SQLite for platform engineers" },
      },
    });
    expect(store.readRun("run-resume")).toMatchObject({
      status: "succeeded",
      finalText: "Publish Drafted SQLite for platform engineers",
      completedAtMs: 3_300,
    });
    expect(store.readPendingPauseForSession("session-resume", 3_400)).toBeNull();
    expect(readPauseRow("pause-ask-1")).toEqual({
      pause_id: "pause-ask-1",
      status: "resumed",
      confirmed_fields_json: JSON.stringify({ audience: "platform engineers" }),
      resumed_at_ms: 3_300,
    });
    expect(readStepRows("run-resume")).toEqual([
      {
        step_id: "ask",
        kind: "user_input",
        dependency_state_json: JSON.stringify({
          dependsOn: ["draft"],
          state: "succeeded",
          satisfied: ["draft"],
        }),
        status: "succeeded",
        input_json: JSON.stringify({}),
        output_json: JSON.stringify({ audience: "platform engineers" }),
        error_json: null,
        started_at_ms: 3_200,
      },
      {
        step_id: "draft",
        kind: "llm_chat",
        dependency_state_json: JSON.stringify({
          dependsOn: [],
          state: "succeeded",
          satisfied: [],
        }),
        status: "succeeded",
        input_json: JSON.stringify({ prompt: "Draft SQLite" }),
        output_json: JSON.stringify({ text: "Drafted SQLite" }),
        error_json: null,
        started_at_ms: 3_000,
      },
      {
        step_id: "publish",
        kind: "tool_call",
        dependency_state_json: JSON.stringify({
          dependsOn: ["draft", "ask"],
          state: "succeeded",
          satisfied: ["draft", "ask"],
        }),
        status: "succeeded",
        input_json: JSON.stringify({
          prompt: "Publish Drafted SQLite for platform engineers",
        }),
        output_json: JSON.stringify({ text: "Publish Drafted SQLite for platform engineers" }),
        error_json: null,
        started_at_ms: 3_200,
      },
    ]);
  });
});
