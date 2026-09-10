import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { planSupervisedCommandResources } from "./supervised-command-custody.js";
import {
  assertSupervisedOperationCurrent,
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  recordSupervisedOperationOutcome,
} from "./supervised-operation.store.js";
import {
  assertSupervisedAttemptCurrent,
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  resumeSupervisedTask,
  settleSupervisedDecision,
} from "./supervised-task.store.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  getSupervisedWorkspaceHead,
  prepareSupervisedAttemptWorkspace,
  prepareSupervisedOperationWorkspace,
} from "./supervised-workspace-versions.js";

const dirs = createTempDirTracker();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1003);
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

function fixture() {
  const root = fs.realpathSync(dirs.make("supervised-workspace-ownership-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const options = { path: path.join(root, "state.sqlite") };
  const policy = { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 };
  heartbeatTaskSupervisor("owner", 1000, 10_000, options);
  function admit(flowId: string, selected = workspace) {
    return createSupervisedTask(
      {
        flowId,
        agentId: "poc",
        runtime: "codex",
        model: "openai/test",
        prompt: "Use the accepted workspace",
        goal: {
          objective: "Produce an accepted artifact",
          success: [{ id: "correct", description: "The host accepts the artifact" }],
          partial: [],
        },
        workflow: encodeSupervisedWorkflowContract({
          version: 1,
          workspace: selected,
          profiles: [
            {
              kind: "command",
              id: "check",
              executable: process.execPath,
              executableSha256: "0".repeat(64),
              argv: ["--version"],
              timeoutMs: 1000,
            },
          ],
          acceptance: [{ kind: "operator", criterionId: "correct" }],
        }).contract,
        policy,
      },
      "owner",
      1000,
      options,
    );
  }
  const claim = (flowId: string) =>
    reserveSupervisedDispatch(claimSupervisedTask(flowId, "owner", 1001, options)!, 1002, options);
  return { root, workspace, options, policy, admit, claim };
}

it.each(["missing", "file", "symlink", "parent-symlink", "dot-segment"] as const)(
  "rejects a %s root without admitting a task or changing the accepted path",
  (kind) => {
    const f = fixture();
    let selected = path.join(f.root, kind);
    if (kind === "file") {
      fs.writeFileSync(selected, "not a directory");
    }
    if (kind === "symlink") {
      fs.symlinkSync(f.workspace, selected, "dir");
    }
    if (kind === "parent-symlink") {
      fs.symlinkSync(f.root, selected, "dir");
      selected = path.join(selected, "workspace");
    }
    if (kind === "dot-segment") {
      selected = `${f.workspace}/../workspace`;
    }
    expect(() => f.admit("rejected", selected)).toThrow(/workspace.*(canonical|directory|exist)/i);
    expect(getSupervisedTask("rejected", f.options)).toBeUndefined();
  },
);

it.each([
  ["attempt", "before", "directory"],
  ["attempt", "after", "directory"],
  ["operation", "before", "directory"],
  ["operation", "after", "directory"],
  ["attempt", "before", "contract"],
  ["attempt", "after", "contract"],
  ["operation", "before", "contract"],
  ["operation", "after", "contract"],
] as const)(
  "rejects root retargeting for %s %s initial copy via %s",
  async (owner, when, mutation) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "answer.txt"), "accepted input");
    f.admit("first");
    const task = f.claim("first");
    const contract = getSupervisedWorkflowContract("first", 1, f.options)!.contract;
    const replaceRoot = () => {
      if (mutation === "directory") {
        fs.renameSync(f.workspace, `${f.workspace}-original`);
        fs.mkdirSync(f.workspace);
        fs.writeFileSync(path.join(f.workspace, "answer.txt"), "replacement input");
      } else {
        contract.workspace = path.join(f.root, "unaccepted-input");
        fs.mkdirSync(contract.workspace);
        fs.writeFileSync(path.join(contract.workspace, "answer.txt"), "replacement input");
      }
    };
    let replaceAfterCopy = when === "after";
    const afterCopy = () => {
      if (replaceAfterCopy) {
        replaceAfterCopy = false;
        replaceRoot();
      }
    };
    if (when === "before") {
      replaceRoot();
    }
    let prepare: Promise<unknown>;
    if (owner === "attempt") {
      prepare = prepareSupervisedAttemptWorkspace(task, contract, f.options, () => {
        assertSupervisedAttemptCurrent(task, Date.now(), f.options);
        afterCopy();
      });
    } else {
      const operation = enqueueSupervisedOperation(
        task,
        {
          key: "check",
          kind: "command",
          profile: "check",
          input: {},
        },
        1003,
        f.options,
      );
      const execution = claimSupervisedOperation(operation.operationId, "runner", 1003, f.options)!;
      prepare = prepareSupervisedOperationWorkspace(execution, contract, f.options, false, () => {
        assertSupervisedOperationCurrent(execution, Date.now(), f.options);
        afterCopy();
      });
    }
    await expect(prepare).rejects.toThrow(/workspace.*(identity|root).*changed/i);
    expect(getSupervisedWorkspaceHead("first", 1, f.options)).toBeUndefined();
    expect(fs.readFileSync(path.join(f.workspace, "answer.txt"), "utf8")).toBe(
      mutation === "directory" ? "replacement input" : "accepted input",
    );
  },
);

it.each(["same", "ancestor", "descendant"] as const)(
  "rejects a %s competing root across SQLite reopen",
  (kind) => {
    const f = fixture();
    const nested = path.join(f.workspace, "nested");
    fs.mkdirSync(nested);
    f.admit("first", kind === "ancestor" ? nested : f.workspace);
    closeOpenClawStateDatabaseForTest();
    expect(() => f.admit("second", kind === "descendant" ? nested : f.workspace)).toThrow(
      /active supervised writer/,
    );
    expect(getSupervisedTask("first", f.options)?.phase).toBe("ready");
    expect(getSupervisedTask("second", f.options)).toBeUndefined();
  },
);

it("admits distinct sibling roots despite a shared string prefix", () => {
  const f = fixture();
  const sibling = `${f.workspace}-other`;
  fs.mkdirSync(sibling);
  f.admit("first");
  expect(f.admit("second", sibling).phase).toBe("ready");
});

it("retains ownership of a directory renamed to a different canonical path", () => {
  const f = fixture();
  f.admit("first");
  const renamed = path.join(f.root, "renamed");
  fs.renameSync(f.workspace, renamed);
  closeOpenClawStateDatabaseForTest();
  expect(() => f.admit("second", renamed)).toThrow(/active supervised writer/);
  expect(getSupervisedTask("second", f.options)).toBeUndefined();
});

it("requires custody reconciliation when a moved root's overlap cannot be disproved", () => {
  const f = fixture();
  f.admit("first");
  const parent = path.join(f.root, "relocated-parent");
  fs.mkdirSync(parent);
  fs.renameSync(f.workspace, path.join(parent, "child"));
  closeOpenClawStateDatabaseForTest();
  expect(() => f.admit("second", parent)).toThrow(/root custody reconciliation required/);
  expect(getSupervisedTask("second", f.options)).toBeUndefined();
  fs.renameSync(path.join(parent, "child"), f.workspace);
  expect(f.admit("second", parent).phase).toBe("ready");
});

it("retains an unresolved input root but transfers it through an explicit same-flow resume", () => {
  const f = fixture();
  f.admit("first");
  settleSupervisedDecision(
    f.claim("first"),
    {
      kind: "input_required",
      reason: "Need a host choice",
      question: "Which artifact?",
    },
    1003,
    f.options,
  );
  closeOpenClawStateDatabaseForTest();
  expect(() => f.admit("second")).toThrow(/active supervised writer/);
  expect(
    resumeSupervisedTask("first", 1, "Continue", f.policy, "owner", 1004, f.options).episode,
  ).toBe(2);
  cancelSupervisedTask("first", 1005, f.options);
  // The old input_required episode must not permanently own a finished flow.
  expect(f.admit("second").phase).toBe("ready");
});

it("resumes from the accepted private head after the original input root disappears", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.workspace, "answer.txt"), "accepted input");
  f.admit("first");
  const first = f.claim("first");
  const contract = getSupervisedWorkflowContract("first", 1, f.options)!.contract;
  await prepareSupervisedAttemptWorkspace(first, contract, f.options, () =>
    assertSupervisedAttemptCurrent(first, Date.now(), f.options),
  );
  settleSupervisedDecision(
    first,
    {
      kind: "input_required",
      reason: "Need a host choice",
      question: "Which artifact?",
    },
    1003,
    f.options,
  );
  fs.renameSync(f.workspace, `${f.workspace}-original`);
  closeOpenClawStateDatabaseForTest();
  resumeSupervisedTask("first", 1, "Continue", f.policy, "owner", 1004, f.options);
  vi.setSystemTime(1005);
  const next = reserveSupervisedDispatch(
    claimSupervisedTask("first", "owner", 1005, f.options)!,
    1005,
    f.options,
  );
  const draft = await prepareSupervisedAttemptWorkspace(next, contract, f.options, () =>
    assertSupervisedAttemptCurrent(next, Date.now(), f.options),
  );
  expect(fs.readFileSync(path.join(draft.workspace, "answer.txt"), "utf8")).toBe("accepted input");
  expect(fs.existsSync(f.workspace)).toBe(false);
});

it.each(["queued", "resource-custody"] as const)(
  "does not release a cancelled task root with retained %s",
  (kind) => {
    const f = fixture();
    f.admit("first");
    const operation = enqueueSupervisedOperation(
      f.claim("first"),
      {
        key: "check",
        kind: "command",
        profile: "check",
        input: {},
      },
      1003,
      f.options,
    );
    if (kind === "resource-custody") {
      const execution = claimSupervisedOperation(operation.operationId, "runner", 1004, f.options)!;
      planSupervisedCommandResources(execution, 1005, f.options);
      recordSupervisedOperationOutcome(
        execution,
        {
          status: "failed",
          summary: "Preparation failed; resource reconciliation is pending",
          facts: {},
          artifacts: [],
        },
        1006,
        f.options,
      );
    }
    cancelSupervisedTask("first", 1007, f.options);
    closeOpenClawStateDatabaseForTest();
    expect(() => f.admit("second")).toThrow(/active supervised writer/);
    expect(getSupervisedTask("second", f.options)).toBeUndefined();
  },
);
