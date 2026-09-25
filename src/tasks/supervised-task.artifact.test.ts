import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { inspectSupervisedArtifact } from "./supervised-task.artifact.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  assertSupervisedAttemptCurrent,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  ensureSupervisedAttemptSource,
  getSupervisedWorkspaceHead,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-versions.js";
const dirs = createTempDirTracker();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
async function fixture() {
  const root = dirs.make("task-artifact-");
  const workspace = `${root}/input`;
  await fs.mkdir(workspace);
  const content = Buffer.from("verified output\n".repeat(10_000));
  await fs.writeFile(`${workspace}/answer.txt`, content);
  const options = { path: `${root}/state.sqlite` };
  const goal = {
    objective: "Review exact output",
    success: [{ id: "correct", description: "Reviewed" }],
    partial: [],
  };
  const contract = encodeSupervisedWorkflowContract(
    {
      version: 1,
      workspace,
      profiles: [],
      acceptance: [{ kind: "operator", criterionId: "correct" }],
    },
    goal,
  ).contract;
  heartbeatTaskSupervisor("native", 1000, 60_000, options);
  createSupervisedTask(
    {
      flowId: "work",
      agentId: "poc",
      model: "openai/test",
      runtime: "codex",
      prompt: "Review",
      goal,
      policy: { deadlineAt: 60_000, maxAttempts: 4, attemptTimeoutMs: 10_000 },
      workflow: contract,
    },
    "native",
    1000,
    options,
  );
  const task = reserveSupervisedDispatch(
    claimSupervisedTask("work", "native", 1000, options)!,
    1000,
    options,
  );
  await ensureSupervisedAttemptSource(task, contract, options, () =>
    assertSupervisedAttemptCurrent(task, 1000, options),
  );
  const head = getSupervisedWorkspaceHead("work", 1, options)!;
  const request = { flowId: "work", versionId: head.version_id, sourceHash: head.source_hash };
  return {
    options,
    request,
    content,
    workspace: supervisedWorkspaceVersionPath(head.version_id, options),
  };
}
it("returns verified bounded chunks from the retained version, not the mutable input", async () => {
  const f = await fixture();
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const result = await inspectSupervisedArtifact(
      { ...f.request, path: "answer.txt", offset },
      () => {},
      f.options,
    );
    expect(result.sourceHash).toBe(f.request.sourceHash);
    if (!("file" in result)) {
      throw new Error("Expected file chunk");
    }
    const bytes = Buffer.from(result.file.base64, "base64");
    expect(bytes.length).toBeLessThanOrEqual(65536);
    chunks.push(bytes);
    if (result.file.nextOffset === undefined) {
      break;
    }
    expect(result.file.nextOffset).toBe(offset + bytes.length);
    offset = result.file.nextOffset;
  }
  expect(Buffer.concat(chunks)).toEqual(f.content);
});
it("rejects traversal, another flow's version, a changed digest, and altered frozen bytes", async () => {
  const f = await fixture();
  for (const request of [
    { ...f.request, path: "../state.sqlite" },
    { ...f.request, flowId: "other" },
    { ...f.request, sourceHash: "f".repeat(64) },
  ]) {
    await expect(inspectSupervisedArtifact(request, () => {}, f.options)).rejects.toThrow();
  }
  await fs.chmod(`${f.workspace}/answer.txt`, 0o600);
  await fs.writeFile(`${f.workspace}/answer.txt`, "changed");
  await expect(inspectSupervisedArtifact(f.request, () => {}, f.options)).rejects.toThrow(
    /changed/,
  );
});
it("rechecks source access after awaited manifest IO before returning any artifact", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    inspectSupervisedArtifact(
      f.request,
      () => {
        if (++checks > 1) {
          throw new Error("Session access revoked");
        }
      },
      f.options,
    ),
  ).rejects.toThrow("Session access revoked");
  expect(checks).toBe(2);
});
