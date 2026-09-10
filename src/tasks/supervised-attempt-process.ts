import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import {
  stageSupervisedAttemptCandidate,
  stageSupervisedAttemptDecision,
} from "./supervised-attempt-candidate.js";
import {
  assertSupervisedAttemptPayloadCurrent,
  assertSupervisedAttemptResourcesCurrent,
  bindSupervisedAttemptResources,
  readSupervisedAttemptContext,
  recordSupervisedAttemptFormatFailure,
  reserveSupervisedAttemptPayload,
} from "./supervised-attempt-custody.js";
import {
  harvestSupervisedAttemptWorkspace,
  prepareSupervisedAttemptWorkspace,
  supervisedAttemptWorkspacePayloadPrefix,
} from "./supervised-attempt-workspace.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import { resolveSupervisedNativeRuntimeRoot } from "./supervised-native-runtime-root.js";
import {
  readSupervisedRuntimeDiagnostic,
  supervisedRuntimeFailureDiagnostic,
} from "./supervised-runtime-diagnostic.js";
import { SupervisedDecisionFormatError } from "./supervised-task.decision.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";

const [mode, resourceId, databasePath, parentMountNamespace, parentUserNamespace] =
  process.argv.slice(2);
if (
  (mode !== "--namespace" && mode !== "--payload") ||
  !resourceId ||
  !databasePath ||
  !parentMountNamespace ||
  !parentUserNamespace ||
  process.argv.length !== 7
) {
  throw new Error("Invalid private supervised attempt invocation");
}
const options = { path: databasePath };
const context = readSupervisedAttemptContext(resourceId, options);
if (!context) {
  throw new Error("Reserved attempt context unavailable");
}
const controller = new AbortController();
const stop = () => controller.abort(new Error("Attempt custodian stopped"));
const assertCurrent = () => {
  controller.signal.throwIfAborted();
  if (mode === "--payload") {
    assertSupervisedAttemptPayloadCurrent(resourceId, options);
  } else {
    assertSupervisedAttemptResourcesCurrent(resourceId, options);
  }
};
const timer = setInterval(() => {
  try {
    assertCurrent();
  } catch (error) {
    controller.abort(error);
  }
}, 1000);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdin.once("end", stop);
process.stdin.resume();

async function disposeRuntime() {
  const { disposeRegisteredAgentHarnesses } = await import("../agents/harness/registry.js");
  await disposeRegisteredAgentHarnesses();
  const { disposeAllSessionMcpRuntimes } =
    await import("../agents/agent-bundle-mcp-manager-api.js");
  await disposeAllSessionMcpRuntimes();
  const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
  await closeMcpLoopbackServer();
}

let stage:
  | "binding"
  | "workspace"
  | "runtime_paths"
  | "payload_launch"
  | "model"
  | "runtime_join"
  | "decision"
  | "export" = "binding";

async function runPayload() {
  stage = "workspace";
  assertCurrent();
  const workspace = path.join(context!.allocationRoot, "working", "work");
  if (
    process.cwd() !== workspace ||
    (await fs.realpath(workspace)) !== workspace ||
    (await fs.readlink("/proc/self/ns/user")) === parentUserNamespace ||
    (await fs.readlink("/proc/self/ns/mnt")) === parentMountNamespace
  ) {
    throw new Error("Attempt payload lacks its exact private workspace and namespaces");
  }
  stage = "model";
  const { runSupervisedAgentPayload } = await import("./supervised-task.agent.js");
  let decision;
  let failure: Error | undefined;
  try {
    decision = await runSupervisedAgentPayload(
      context!.task,
      { signal: controller.signal, assertCurrent, options },
      workspace,
    );
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("Supervised runtime failed", { cause: error });
  }
  // A fulfilled adapter alone is not closure. Join its harness/MCP ownership
  // before recording a decision; the namespace owner still joins this process.
  stage = "runtime_join";
  await disposeRuntime();
  assertCurrent();
  if (failure) {
    stage = "model";
    if (failure instanceof SupervisedDecisionFormatError) {
      recordSupervisedAttemptFormatFailure(resourceId!, failure.detail, options);
    }
    throw failure;
  }
  stage = "decision";
  stageSupervisedAttemptDecision(resourceId!, JSON.stringify(decision), options);
}

async function runNamespace() {
  // Bind THIS namespace/export custodian, not an outer transport's PID.
  await bindSupervisedAttemptResources(resourceId!, options);
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Attempt UID unavailable");
  }
  const workflow = getSupervisedWorkflowContract(
    context!.task.flowId,
    context!.task.episode,
    options,
  );
  stage = "workspace";
  const prepared = await prepareSupervisedAttemptWorkspace({
    plan: context!.plan,
    allocationId: context!.plan.allocationId,
    reservedRoot: context!.allocationRoot,
    sourceWorkspace: context!.sourceWorkspace,
    sourcePaths: workflow?.contract.sourcePaths ?? [],
    parentMountNamespace: parentMountNamespace!,
    parentUserNamespace: parentUserNamespace!,
    hostUid: uid,
    hostGid: gid,
    ...context!.plan.storage,
    assertCurrent,
  });
  stage = "runtime_paths";
  const config = getRuntimeConfig();
  const roots = new Set([
    path.dirname(databasePath!),
    path.dirname(resolveAgentDir(config, context!.task.agentId)),
    path.dirname(resolveDefaultAgentDir(config)),
  ]);
  // Keep native runtime auth at its existing owner/path. These stores have
  // separate retention policies; the working tmpfs is not an all-host-disk quota.
  const nativeRoot = resolveSupervisedNativeRuntimeRoot(context!.task.runtime);
  if (nativeRoot) {
    try {
      await fs.access(nativeRoot);
      roots.add(nativeRoot);
    } catch {
      /* No native store selected. */
    }
  }
  for (const root of roots) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const configFile = resolveConfigPath();
  const readOnlyRuntimeFiles = await fs.access(configFile).then(
    () => [configFile],
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  const prefix = await supervisedAttemptWorkspacePayloadPrefix({
    prepared,
    writableRuntimePaths: [...roots],
    readOnlyRuntimeFiles,
    assertCurrent,
  });
  const entrypoint = resolveRuntimeProcessEntrypointUrl("supervisedAttempt");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  stage = "payload_launch";
  reserveSupervisedAttemptPayload(resourceId!, options);
  let joined = false;
  const result = await runSupervisedCommandChild({
    id: `${resourceId}:model-payload`,
    argv: [
      ...prefix,
      process.execPath,
      ...resolveRuntimeWorkerArgv(entrypoint),
      "--payload",
      resourceId!,
      databasePath!,
      prepared.mountNamespace,
      prepared.userNamespace,
    ],
    cwd: path.resolve(path.dirname(fileURLToPath(entrypoint)), "../.."),
    env,
    timeoutMs: Math.max(1, context!.plan.expiresAt - Date.now()),
    signal: controller.signal,
    keepInputOpen: true,
    assertCurrent,
    onTransportExtinct: () => {
      joined = true;
    },
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const runtimeDiagnostic = readSupervisedRuntimeDiagnostic(result.stderr);
    if (runtimeDiagnostic) {
      process.stderr.write(`${runtimeDiagnostic}\n`);
    }
    const nested = result.stderr.match(
      /supervised-attempt:payload:(binding|workspace|runtime_paths|payload_launch|model|runtime_join|decision|export)\b/,
    )?.[0];
    if (nested) {
      process.stderr.write(`${nested}\n`);
    } else {
      const failure = result.stderr.includes("bwrap:") ? "namespace_launcher" : "payload_bootstrap";
      const detail =
        result.stderr.includes("No such file or directory") || result.stderr.includes("ENOENT")
          ? "missing_path"
          : result.stderr.includes("Operation not permitted") || result.stderr.includes("EPERM")
            ? "not_permitted"
            : result.stderr.includes("Permission denied") || result.stderr.includes("EACCES")
              ? "access_denied"
              : "unclassified";
      process.stderr.write(`supervised-attempt:namespace:payload_launch:${failure}:${detail}\n`);
    }
    throw new Error("Attempt model payload failed");
  }
  stage = "export";
  await harvestSupervisedAttemptWorkspace({
    prepared,
    assertCurrent,
    assertPayloadExtinct: async () => {
      if (!joined) {
        throw new Error("Attempt payload descendants have not joined");
      }
    },
  });
  await stageSupervisedAttemptCandidate(resourceId!, options);
}

try {
  if (mode === "--payload") {
    await runPayload();
  } else {
    await runNamespace();
  }
} catch (error) {
  process.stderr.write(`${supervisedRuntimeFailureDiagnostic(error)}\n`);
  // Decisions/fixed parser diagnostics are durable. Never echo provider errors,
  // auth-bearing environment or arbitrary model text through the control pipe.
  process.stderr.write(
    `supervised-attempt:${mode === "--payload" ? "payload" : "namespace"}:${stage}\n`,
  );
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.stdin.off("end", stop);
  process.stdin.pause();
}
