import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { agentCommandFromSystem } from "../agents/agent-command.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listSupervisedOperations } from "./supervised-operation.store.js";
import { runSupervisedAgentPayload } from "./supervised-task.agent.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";
import { releaseSupervisedWorkspaceOwner } from "./supervised-workspace-retention.js";
import {
  prepareSupervisedAttemptWorkspace,
  acceptSupervisedAttemptWorkspace,
  resolveSupervisedWorkflowWorkspace,
} from "./supervised-workspace-versions.js";
// Composed producer/recovery test. Kernel custody and candidate transactions
// have separate suites; this host adapter joins its mocked file writer locally.
const runSupervisedAgentAttempt = async (
  task: Parameters<typeof runSupervisedAgentPayload>[0],
  context: Parameters<typeof runSupervisedAgentPayload>[1],
) => {
  const options = context.options ?? {};
  const contract = getSupervisedWorkflowContract(task.flowId, task.episode, options)!.contract;
  const draft = await prepareSupervisedAttemptWorkspace(
    task,
    contract,
    options,
    context.assertCurrent,
  );
  const decision = await runSupervisedAgentPayload(task, context, draft.workspace);
  await acceptSupervisedAttemptWorkspace(task, contract, draft, options, context.assertCurrent);
  releaseSupervisedWorkspaceOwner("attempt", task.attempt!.id, Date.now(), options);
  return decision;
};
import { createSupervisedTask, getSupervisedTask } from "./supervised-task.store.js";
import { startSupervisedTaskWorker } from "./supervised-task.worker.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

const command = vi.hoisted(() => vi.fn<typeof agentCommandFromSystem>());
vi.mock("../agents/agent-command.js", () => ({ agentCommandFromSystem: command }));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    agents: {
      defaults: { models: { "anthropic/fixture": { agentRuntime: { id: "claude-cli" } } } },
    },
  }),
}));
// This boundary ends at durable enqueue, not execution of a reviewer subprocess.
vi.mock("./supervised-operation.dispatcher.js", () => ({
  startSupervisedOperationDispatcher: () => ({ stop: () => {} }),
}));

const dirs = createTempDirTracker();
let worker: ReturnType<typeof startSupervisedTaskWorker> | undefined;
beforeEach(() => {
  command.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  worker?.stop();
  worker = undefined;
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

it.each([false, true])(
  "recovers decision format without installing rejected drafts or extending budgets (repeated=%s)",
  async (repeated) => {
    const root = dirs.make("decision-recovery-");
    const options = { path: `${root}/state.sqlite` };
    const workspace = `${root}/input`;
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/answer.txt`, "accepted input");
    const contract = encodeSupervisedWorkflowContract({
      version: 1,
      workspace,
      profiles: [
        {
          kind: "review",
          id: "review",
          agentId: "poc",
          runtime: "claude-cli",
          model: "anthropic/fixture",
          instructions: "Inspect answer",
          paths: ["answer.txt"],
          timeoutMs: 1000,
        },
      ],
      acceptance: [{ kind: "receipts", criterionId: "correct", profiles: ["review"] }],
      maxRecoveryAttempts: 1,
    }).contract;
    const operation = {
      kind: "operation",
      operation: { key: "review-answer", kind: "review", profile: "review", input: {} },
    };
    const rejected = `Both modules are written.\n\n\`\`\`json\n${JSON.stringify(operation)}\n\`\`\``;
    const inputBytes: string[] = [];
    command.mockImplementation(async (params) => {
      const draft = params.workspaceDir!;
      inputBytes.push(await fs.readFile(`${draft}/answer.txt`, "utf8"));
      await fs.writeFile(
        `${draft}/answer.txt`,
        inputBytes.length === 1 ? "rejected draft" : "valid repair",
      );
      const terminal = repeated || inputBytes.length === 1 ? rejected : JSON.stringify(operation);
      return {
        payloads: [{ mediaUrl: null, text: `Earlier tool commentary.\n${terminal}` }],
        meta: {
          durationMs: 1,
          finalAssistantRawText: `Earlier tool commentary.\n${terminal}`,
          cliTerminalResultText: terminal,
          executionTrace: {
            runner: "cli",
            winnerProvider: "claude-cli",
            winnerModel: "fixture",
            attempts: [],
            fallbackUsed: false,
          },
          agentMeta: { sessionId: params.sessionId!, provider: "claude-cli", model: "fixture" },
        },
      };
    });
    const errors: unknown[] = [];
    worker = startSupervisedTaskWorker({
      runAttempt: runSupervisedAgentAttempt,
      options,
      onlyFlowId: "format",
      onError: (error) => errors.push(error),
    });
    createSupervisedTask(
      {
        flowId: "format",
        agentId: "poc",
        runtime: "claude-cli",
        model: "anthropic/fixture",
        prompt: "Repair answer",
        goal: {
          objective: "Repair answer",
          success: [{ id: "correct", description: "Reviewed answer" }],
          partial: [],
        },
        policy: { deadlineAt: 60_000, maxAttempts: 8, attemptTimeoutMs: 10_000 },
        workflow: contract,
      },
      worker.ownerId,
      Date.now(),
      options,
    );
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5000 });
    const recovery = getSupervisedTask("format", options)!;
    expect(recovery).toMatchObject({ phase: "ready", attempts: 1, endpoint: null });
    expect(recovery.next).toContain("Previous terminal response was not a valid task decision");
    expect(recovery.next).toContain("no prose");
    expect(recovery.next).not.toContain("Both modules are written");
    expect(listSupervisedOperations(options, "format", 1)).toEqual([]);
    const accepted = resolveSupervisedWorkflowWorkspace(contract, "format", 1, options);
    expect(await fs.readFile(`${accepted.workspace}/answer.txt`, "utf8")).toBe("accepted input");
    vi.setSystemTime(recovery.dueAt);
    await vi.waitFor(
      () =>
        expect(getSupervisedTask("format", options)?.phase).toBe(
          repeated ? "input_required" : "waiting",
        ),
      { timeout: 5000 },
    );
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[1]![0].message).toContain(
      "Previous terminal response was not a valid task decision",
    );
    expect(inputBytes).toEqual(["accepted input", "accepted input"]);
    expect(getSupervisedTask("format", options)?.attempts).toBe(2);
    expect(listSupervisedOperations(options, "format", 1)).toHaveLength(repeated ? 0 : 1);
    const final = resolveSupervisedWorkflowWorkspace(contract, "format", 1, options);
    expect(await fs.readFile(`${final.workspace}/answer.txt`, "utf8")).toBe(
      repeated ? "accepted input" : "valid repair",
    );
    if (repeated) {
      expect(getSupervisedTask("format", options)?.endpoint?.reason).toContain("task decision");
    }
    expect(await fs.readFile(`${workspace}/answer.txt`, "utf8")).toBe("accepted input");
  },
);
