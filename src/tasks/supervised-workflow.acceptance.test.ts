import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  recordSupervisedOperationOutcome,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import {
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
} from "./supervised-task.store.js";
import type { SupervisedDecision } from "./supervised-task.types.js";
import { verifySupervisedWorkflowAcceptance } from "./supervised-workflow.acceptance.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { captureSupervisedWorkspace } from "./supervised-workspace.js";

// Stable ascending UUIDs expose the same-timestamp order rather than letting a
// random operation UUID decide whether the regression happens to pass.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  let next = 0;
  return {
    ...actual,
    randomUUID: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  };
});

const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
const claimedSuccess = {
  kind: "succeeded",
  summary: "The model says it worked",
  evidence: [{ criterionId: "correct", observation: "Trust me" }],
} satisfies SupervisedDecision;
async function fixture(kind: "artifact" | "receipts" | "operator" | "json" = "artifact") {
  const root = dirs.make("openclaw-workflow-acceptance-");
  const workspace = `${root}/work`;
  await fs.mkdir(workspace);
  await fs.writeFile(`${workspace}/answer.txt`, "host-expected\n");
  const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
  const goal = {
    objective: "Produce the accepted artifact",
    success: [{ id: "correct", description: "The actual host check passes" }],
    partial: [],
  };
  const workflow = encodeSupervisedWorkflowContract(
    {
      version: 1,
      workspace,
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
      acceptance: [
        kind === "artifact"
          ? {
              kind,
              criterionId: "correct",
              path: "answer.txt",
              sha256: createHash("sha256").update("host-expected\n").digest("hex"),
            }
          : kind === "receipts"
            ? { kind, criterionId: "correct", profiles: ["check"] }
            : kind === "json"
              ? { kind, criterionId: "correct", path: "answer.txt", fields: { correct: true } }
              : { kind, criterionId: "correct" },
      ],
    },
    goal,
  ).contract;
  heartbeatTaskSupervisor("owner", 1000, 10_000, options);
  const task = createSupervisedTask(
    {
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Do it",
      goal,
      workflow,
      policy: { deadlineAt: 60_000, maxAttempts: 5, attemptTimeoutMs: 10_000 },
    },
    "owner",
    1000,
    options,
  );
  const expected = reserveSupervisedDispatch(
    claimSupervisedTask(task.flowId, "owner", 1001, options)!,
    1002,
    options,
  );
  return { workspace, options, expected, workflow };
}

async function receiptHistory(
  first: "succeeded" | "failed",
  second: "succeeded" | "failed" | "pending" | "unidentified",
  secondAt = 1003,
) {
  const f = await fixture("receipts");
  const sourceHash = (await captureSupervisedWorkspace(f.workflow)).hash;
  const finish = (
    task: typeof f.expected,
    key: string,
    at: number,
    status: typeof first | "unidentified",
  ) => {
    const operation = enqueueSupervisedOperation(
      task,
      { key, kind: "command", profile: "check", input: {} },
      at,
      f.options,
    );
    const execution = claimSupervisedOperation(
      operation.operationId,
      `runner-${key}`,
      at,
      f.options,
    )!;
    reserveSupervisedOperationDispatch(execution, at, f.options);
    recordSupervisedOperationOutcome(
      execution,
      {
        status: status === "unidentified" ? "failed" : status,
        summary: "Observed host check",
        facts: status === "unidentified" ? {} : { sourceHash, resultHash: sourceHash },
        artifacts: [],
      },
      at,
      f.options,
    );
  };
  const nextAttempt = (at = 1003) =>
    reserveSupervisedDispatch(
      claimSupervisedTask(f.expected.flowId, "owner", at, f.options)!,
      at,
      f.options,
    );
  finish(f.expected, "first", 1003, first);
  const secondAttempt = nextAttempt();
  if (second === "pending") {
    enqueueSupervisedOperation(
      secondAttempt,
      { key: "second", kind: "command", profile: "check", input: {} },
      secondAt,
      f.options,
    );
    return { ...f, expected: secondAttempt };
  }
  finish(secondAttempt, "second", secondAt, second);
  return { ...f, expected: nextAttempt(Math.max(1003, secondAt)) };
}

it.each([
  ["failed", 1003],
  ["failed", 1002],
  ["unidentified", 1004],
  ["pending", 1004],
] as const)("does not accept older success over a newer %s check at %i", async (status, at) => {
  const f = await receiptHistory("succeeded", status, at);
  expect(
    await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options),
  ).toMatchObject({ kind: "rejected", operatorRequired: false });
  expect(getSupervisedTask(f.expected.flowId, f.options)?.endpoint).toBeNull();
});

it("accepts a later repaired check even when both admissions share a timestamp", async () => {
  const f = await receiptHistory("failed", "succeeded");
  const checked = await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options);
  expect(checked.kind).toBe("verified");
  if (checked.kind !== "verified") {
    throw new Error("Expected host proof");
  }
  expect(
    settleSupervisedDecision(f.expected, claimedSuccess, 1004, f.options, checked.proof).phase,
  ).toBe("succeeded");
});

it("rejects both model-only completion and a forged host-proof-shaped object", async () => {
  const f = await fixture();
  expect(() => settleSupervisedDecision(f.expected, claimedSuccess, 1003, f.options)).toThrow(
    /controller verification/,
  );
  expect(() =>
    settleSupervisedDecision(f.expected, claimedSuccess, 1003, f.options, {
      kind: "host-verified-workflow",
    }),
  ).toThrow(/host acceptance proof/);
  expect(getSupervisedTask(f.expected.flowId, f.options)?.endpoint).toBeNull();
});
it("accepts verified bytes and replaces self-reported evidence with host observations", async () => {
  const f = await fixture();
  const checked = await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options);
  expect(checked.kind).toBe("verified");
  if (checked.kind !== "verified") {
    throw new Error("Expected host proof");
  }
  const result = settleSupervisedDecision(
    f.expected,
    claimedSuccess,
    1003,
    f.options,
    checked.proof,
  );
  expect(result.endpoint).toMatchObject({ kind: "succeeded", acceptedBy: "supervisor" });
  expect(result.endpoint?.evidence[0]?.observation).toContain("SHA-256");
  expect(result.endpoint?.evidence[0]?.observation).not.toContain("Trust me");
});
it("does not let a stale verified callback overwrite cancellation", async () => {
  const f = await fixture();
  const checked = await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options);
  if (checked.kind !== "verified") {
    throw new Error("Expected host proof");
  }
  const cancelled = cancelSupervisedTask(f.expected.flowId, 1003, f.options);
  expect(() =>
    settleSupervisedDecision(f.expected, claimedSuccess, 1004, f.options, checked.proof),
  ).toThrow(/no longer/);
  expect(getSupervisedTask(f.expected.flowId, f.options)).toEqual(cancelled);
});
it("rejects altered bytes despite a persuasive model success report", async () => {
  const f = await fixture();
  await fs.writeFile(`${f.workspace}/answer.txt`, "wrong\n");
  expect(
    await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options),
  ).toMatchObject({ kind: "rejected", operatorRequired: false });
});
it("schedules a missing accepted check instead of treating model prose as its result", async () => {
  const f = await fixture("receipts");
  const checked = await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options);
  expect(checked).toMatchObject({ kind: "check", profile: { kind: "command", id: "check" } });
});
it("does not automate subjective operator-only acceptance", async () => {
  const f = await fixture("operator");
  expect(
    await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options),
  ).toMatchObject({ kind: "rejected", operatorRequired: true });
});

it("reports invalid JSON as repairable rejection without losing the owned attempt", async () => {
  const f = await fixture("json");
  const before = getSupervisedTask(f.expected.flowId, f.options);
  expect(
    await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options),
  ).toMatchObject({
    kind: "rejected",
    reason: expect.stringContaining("not valid JSON"),
    operatorRequired: false,
  });
  expect(getSupervisedTask(f.expected.flowId, f.options)).toEqual(before);
  await fs.writeFile(`${f.workspace}/answer.txt`, '{"correct":true}');
  expect(
    await verifySupervisedWorkflowAcceptance(f.expected, claimedSuccess, f.options),
  ).toMatchObject({ kind: "verified" });
});
