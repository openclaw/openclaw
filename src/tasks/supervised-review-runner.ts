import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import {
  getSupervisedCommandResources,
  startSupervisedCommandTransport,
  recordSupervisedCommandTransportExtinct,
  planSupervisedReviewResources,
  recordSupervisedCommandResourcesClosed,
  sealSupervisedCommandPlan,
  recordSealedSupervisedCommandClosed,
} from "./supervised-command-custody.js";
import {
  awaitSupervisedCommandScopeClosed,
  buildSupervisedCommandScopeArgv,
  terminateSupervisedCommandScope,
  isSealedSupervisedCommandScopeAbsent,
} from "./supervised-command-resources.js";
import {
  parseSupervisedOperationOutcome,
  type SupervisedOperationExecution,
} from "./supervised-operation.types.js";
import { readSupervisedReviewContext } from "./supervised-review-context.js";
import { SUPERVISED_REVIEW_LIMITS } from "./supervised-review-policy.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import {
  createSupervisedWorkspaceDirectory,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-path.js";
import { reserveSupervisedWorkspace } from "./supervised-workspace-retention.js";
import { captureSupervisedWorkspace } from "./supervised-workspace.js";

/** Outer receipt owner. Only its private scoped payload loads/runs a model. */
export async function runScopedSupervisedReview(params: {
  execution: SupervisedOperationExecution;
  options: SupervisedWorkflowDatabaseOptions;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  if (process.platform !== "linux" || !process.getuid) {
    throw new Error("Bounded reviews require Linux user namespaces and cgroup v2");
  }
  const { execution, options, assertCurrent } = params;
  const allocationId = reserveSupervisedWorkspace(
    { kind: "operation", execution },
    "draft",
    Date.now(),
    options,
  );
  const root = supervisedWorkspaceVersionPath(allocationId, options);
  await createSupervisedWorkspaceDirectory(root);
  assertCurrent();
  const context = readSupervisedReviewContext(execution.executionId, allocationId, options);
  const database =
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const [mountNamespace, userNamespace] = await Promise.all([
    fs.readlink("/proc/self/ns/mnt"),
    fs.readlink("/proc/self/ns/user"),
  ]);
  const entrypoint = resolveRuntimeProcessEntrypointUrl("supervisedReview");
  const argv = buildSupervisedCommandScopeArgv(execution.executionId, SUPERVISED_REVIEW_LIMITS, [
    "/usr/bin/unshare",
    "--user",
    "--map-current-user",
    "--mount",
    "--keep-caps",
    "--fork",
    "--kill-child",
    process.execPath,
    ...resolveRuntimeWorkerArgv(entrypoint),
    "--namespace",
    execution.executionId,
    allocationId,
    database,
    mountNamespace,
    userNamespace,
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  assertCurrent();
  planSupervisedReviewResources(execution, Date.now(), options);
  let transportExtinct = false;
  try {
    startSupervisedCommandTransport(execution, Date.now(), options);
    const result = await runSupervisedCommandChild({
      id: `${execution.executionId}:review-scope`,
      argv,
      cwd: path.resolve(path.dirname(fileURLToPath(entrypoint)), "../.."),
      env,
      timeoutMs: Math.max(1, context.operation.deadlineAt - Date.now()),
      keepInputOpen: true,
      signal: params.signal,
      assertCurrent,
      outputLimit: 32768,
      onTransportExtinct: () => {
        transportExtinct = true;
        recordSupervisedCommandTransportExtinct(execution, Date.now(), options);
      },
    });
    const resources = getSupervisedCommandResources(execution.executionId, options);
    if (!resources?.identity) {
      throw new Error("Review did not establish bounded runtime custody");
    }
    await awaitSupervisedCommandScopeClosed(resources.identity);
    recordSupervisedCommandResourcesClosed(resources.identity, Date.now(), options);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error("Scoped review did not complete cleanly");
    }
    const outcome = parseSupervisedOperationOutcome(JSON.parse(result.stdout));
    assertCurrent();
    const source = await captureSupervisedWorkspace(context.contract);
    assertCurrent();
    if (source.hash !== outcome.facts.sourceHash || source.hash !== outcome.facts.resultHash) {
      throw new Error("Review retained source changed before receipt");
    }
    return outcome;
  } finally {
    if (
      sealSupervisedCommandPlan(execution, Date.now(), options) &&
      transportExtinct &&
      (await isSealedSupervisedCommandScopeAbsent(execution.executionId))
    ) {
      recordSealedSupervisedCommandClosed(execution, Date.now(), options);
    }
    const resources = getSupervisedCommandResources(execution.executionId, options);
    if (resources?.identity && resources.state !== "closed") {
      const identity = resources.identity;
      await terminateSupervisedCommandScope(identity, () => {
        const current = getSupervisedCommandResources(execution.executionId, options);
        if (!current?.identity || JSON.stringify(current.identity) !== JSON.stringify(identity)) {
          throw new Error("Review cleanup custody changed");
        }
      });
      recordSupervisedCommandResourcesClosed(identity, Date.now(), options);
    }
  }
}
