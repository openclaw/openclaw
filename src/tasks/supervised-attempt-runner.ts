import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acceptSupervisedAttemptCandidate } from "./supervised-attempt-candidate.js";
import {
  assertSupervisedAttemptResourcesCurrent,
  beginSupervisedAttemptLaunch,
  closeSupervisedAttemptResources,
  getSupervisedAttemptResources,
  recordSupervisedAttemptLauncherJoined,
  reserveSupervisedAttemptResources,
  revokeSupervisedAttemptResources,
} from "./supervised-attempt-custody.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import { buildSupervisedProcessScopeArgv } from "./supervised-process-resources.js";
import { readSupervisedRuntimeDiagnostic } from "./supervised-runtime-diagnostic.js";
import { SupervisedDecisionFormatError } from "./supervised-task.decision.js";
import type { SupervisedAttemptRunner } from "./supervised-task.worker.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";
import {
  createSupervisedWorkspaceDirectory,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-path.js";
import { ensureSupervisedAttemptSource } from "./supervised-workspace-versions.js";

/** The controller never runs model/file tools. One SQL reservation owns both
 * their trusted host and native runtime descendants inside a kernel scope. */
export const runScopedSupervisedAttempt: SupervisedAttemptRunner = async (task, context) => {
  const options = context.options ?? {};
  const workflow = getSupervisedWorkflowContract(task.flowId, task.episode, options);
  if (workflow) {
    await ensureSupervisedAttemptSource(task, workflow.contract, options, context.assertCurrent);
  }
  context.assertCurrent();
  const plan = reserveSupervisedAttemptResources(
    task,
    { memoryBytes: 2 * 1024 ** 3, tasks: 256 },
    options,
  );
  const database =
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const allocation = supervisedWorkspaceVersionPath(plan.allocationId, options);
  let joined = false;
  let launchFailure: Error | undefined;
  let result: Awaited<ReturnType<typeof runSupervisedCommandChild>> | undefined;
  try {
    await createSupervisedWorkspaceDirectory(allocation);
    const [mountNamespace, userNamespace] = await Promise.all([
      fs.readlink("/proc/self/ns/mnt"),
      fs.readlink("/proc/self/ns/user"),
    ]);
    const entrypoint = resolveRuntimeProcessEntrypointUrl("supervisedAttempt");
    const argv = buildSupervisedProcessScopeArgv(plan.resourceId, plan.limits, [
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
      plan.resourceId,
      database,
      mountNamespace,
      userNamespace,
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    context.assertCurrent();
    beginSupervisedAttemptLaunch(plan.resourceId, options);
    result = await runSupervisedCommandChild({
      id: `${plan.resourceId}:attempt`,
      argv,
      cwd: path.resolve(path.dirname(fileURLToPath(entrypoint)), "../.."),
      env,
      timeoutMs: Math.max(1, plan.expiresAt - Date.now()),
      signal: context.signal,
      keepInputOpen: true,
      assertCurrent: () => {
        context.assertCurrent();
        assertSupervisedAttemptResourcesCurrent(plan.resourceId, options);
      },
      onTransportExtinct: () => {
        joined = true;
      },
    });
  } catch (error) {
    launchFailure =
      error instanceof Error ? error : new Error("Attempt launch failed", { cause: error });
  }
  // Source revocation must never suppress cleanup. A launch failure is surfaced
  // only after exact physical closure; unresolved cleanup takes precedence.
  revokeSupervisedAttemptResources(plan.resourceId, options);
  if (joined) {
    recordSupervisedAttemptLauncherJoined(plan.resourceId, options);
  }
  if (!(await closeSupervisedAttemptResources(plan.resourceId, options))) {
    throw new Error("Attempt physical resource closure remains unresolved", {
      cause: launchFailure,
    });
  }
  if (launchFailure) {
    throw launchFailure;
  }
  const resource = getSupervisedAttemptResources(plan.resourceId, options);
  if (
    resource?.failure_code === "invalid_json" ||
    resource?.failure_code === "invalid_shape" ||
    resource?.failure_code === "oversized"
  ) {
    throw new SupervisedDecisionFormatError(resource.failure_code);
  }
  if (!result || result.exitCode !== 0 || result.timedOut) {
    // Only fixed host stage codes cross this boundary; never include child stderr.
    const runtimeDiagnostic = readSupervisedRuntimeDiagnostic(result?.stderr ?? "");
    const diagnostic = result?.stderr.match(
      /supervised-attempt:(namespace|payload):(binding|workspace|runtime_paths|payload_launch|model|runtime_join|decision|export)(?::(?:namespace_launcher|payload_bootstrap):(?:missing_path|not_permitted|access_denied|unclassified))?\b/,
    )?.[0];
    throw new Error(
      `Scoped attempt payload did not complete cleanly${diagnostic ? ` (${diagnostic})` : ""}${runtimeDiagnostic ? ` (${runtimeDiagnostic})` : ""}`,
    );
  }
  return acceptSupervisedAttemptCandidate(task, plan.resourceId, options);
};
