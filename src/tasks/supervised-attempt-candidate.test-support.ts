import fs from "node:fs/promises";
import path from "node:path";
import {
  acceptSupervisedAttemptCandidate,
  stageSupervisedAttemptCandidate,
  stageSupervisedAttemptDecision,
} from "./supervised-attempt-candidate.js";
import {
  beginSupervisedAttemptLaunch,
  bindSupervisedAttemptResources,
  closeSupervisedAttemptResources,
  recordSupervisedAttemptLauncherJoined,
  reserveSupervisedAttemptPayload,
  reserveSupervisedAttemptResources,
  revokeSupervisedAttemptResources,
} from "./supervised-attempt-custody.js";
import type { SupervisedDecision, SupervisedTask } from "./supervised-task.types.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import type { SupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  ensureSupervisedAttemptSource,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-versions.js";
import { captureSupervisedWorkspace } from "./supervised-workspace.js";

export async function prepareAttemptCandidateFixture(
  task: SupervisedTask,
  contract: SupervisedWorkflowContract,
  options: SupervisedWorkflowDatabaseOptions,
  assertCurrent: () => void,
) {
  const head = await ensureSupervisedAttemptSource(task, contract, options, assertCurrent);
  const plan = reserveSupervisedAttemptResources(
    task,
    { memoryBytes: 2 * 1024 ** 3, tasks: 128 },
    options,
  );
  beginSupervisedAttemptLaunch(plan.resourceId, options);
  await bindSupervisedAttemptResources(plan.resourceId, options);
  reserveSupervisedAttemptPayload(plan.resourceId, options);
  const workspace = path.join(supervisedWorkspaceVersionPath(plan.allocationId, options), "export");
  // Materialize a writable synthetic payload export. This is fixture IO, not
  // the production namespace adapter; candidate staging owns the frozen copy.
  const source = supervisedWorkspaceVersionPath(head.version_id, options);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.cp(source, workspace, { recursive: true });
  for (const file of (await captureSupervisedWorkspace({ ...contract, workspace })).files) {
    await fs.chmod(path.join(workspace, file.path), file.executable ? 0o700 : 0o600);
  }
  assertCurrent();
  return {
    plan,
    workspace,
    stage: async (decision: SupervisedDecision) => {
      stageSupervisedAttemptDecision(plan.resourceId, JSON.stringify(decision), options);
      await stageSupervisedAttemptCandidate(plan.resourceId, options);
    },
    close: async () => {
      revokeSupervisedAttemptResources(plan.resourceId, options);
      recordSupervisedAttemptLauncherJoined(plan.resourceId, options);
      return closeSupervisedAttemptResources(plan.resourceId, options);
    },
    accept: () => acceptSupervisedAttemptCandidate(task, plan.resourceId, options),
  };
}
