import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import { readSupervisedCommandContext } from "./supervised-command-context.js";
import {
  getSupervisedCommandResources,
  startSupervisedCommandTransport,
  recordSupervisedCommandTransportExtinct,
  planSupervisedCommandResources,
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
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import {
  createSupervisedWorkspaceDirectory,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-path.js";
import { reserveSupervisedWorkspace } from "./supervised-workspace-retention.js";
import { captureSupervisedWorkspace } from "./supervised-workspace.js";

/** Kernel-bounded custodian: no direct writable bind of a host draft. */
export async function runSupervisedCommand(params: {
  execution: SupervisedOperationExecution;
  options: SupervisedWorkflowDatabaseOptions;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  if (process.platform !== "linux" || !process.getuid) {
    throw new Error("Bounded commands require Linux user namespaces and cgroup v2");
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
  const context = readSupervisedCommandContext(execution.executionId, allocationId, options);
  const databasePath =
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const parentNamespace = await fs.readlink("/proc/self/ns/mnt");
  const parentUserNamespace = await fs.readlink("/proc/self/ns/user");
  const argv = buildSupervisedCommandScopeArgv(
    execution.executionId,
    context.profile.resourceLimits,
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("supervisedCommand")),
      "--scope",
      execution.executionId,
      allocationId,
      databasePath,
      parentNamespace,
      parentUserNamespace,
    ],
  );
  assertCurrent();
  planSupervisedCommandResources(execution, Date.now(), options);
  let transportExtinct = false;
  try {
    const uid = process.getuid();
    startSupervisedCommandTransport(execution, Date.now(), options);
    const result = await runSupervisedCommandChild({
      id: `${execution.executionId}:scope`,
      argv,
      // Trusted bootstrap uses the installation's tsconfig/package context.
      // The payload's working directory is selected inside its private mount.
      cwd: path.dirname(fileURLToPath(resolveRuntimeProcessEntrypointUrl("supervisedCommand"))),
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", XDG_RUNTIME_DIR: `/run/user/${uid}` },
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
      throw new Error(`Command never established bounded custody: ${result.stderr.slice(-2048)}`);
    }
    await awaitSupervisedCommandScopeClosed(resources.identity);
    recordSupervisedCommandResourcesClosed(resources.identity, Date.now(), options);
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Command custodian failed: ${result.stderr.slice(-2048)}`);
    }
    const outcome = parseSupervisedOperationOutcome(JSON.parse(result.stdout));
    assertCurrent();
    const workspace = path.join(root, "export");
    const exported = await captureSupervisedWorkspace({ ...context.contract, workspace });
    assertCurrent();
    if (exported.hash !== outcome.facts.resultHash) {
      throw new Error("Command export differs from observed result");
    }
    return { outcome, workspace };
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
      // Cleanup-only custody, never permission for another payload. UUID scope
      // names and immutable bindings cannot be reassigned to another execution.
      await terminateSupervisedCommandScope(identity, () => {
        const current = getSupervisedCommandResources(execution.executionId, options);
        if (!current?.identity || JSON.stringify(current.identity) !== JSON.stringify(identity)) {
          throw new Error("Command cleanup custody changed");
        }
      });
      recordSupervisedCommandResourcesClosed(identity, Date.now(), options);
    }
  }
}
