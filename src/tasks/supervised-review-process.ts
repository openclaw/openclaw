import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";
import { withOwnedRuntimeProcess } from "../infra/owned-runtime-process-context.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import {
  bindSupervisedCommandResources,
  getSupervisedCommandResources,
} from "./supervised-command-custody.js";
import { inspectSupervisedCommandScope } from "./supervised-command-resources.js";
import { resolveSupervisedNativeRuntimeRoot } from "./supervised-native-runtime-root.js";
import {
  assertSupervisedOperationCurrent,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import { parseSupervisedOperationOutcome } from "./supervised-operation.types.js";
import { assertSupervisedProcessScopeMember } from "./supervised-process-resources.js";
import { readSupervisedReviewContext } from "./supervised-review-context.js";
import { SUPERVISED_REVIEW_LIMITS, SUPERVISED_REVIEW_STORAGE } from "./supervised-review-policy.js";
import {
  prepareSupervisedRuntimeWorkspace,
  supervisedRuntimeWorkspacePayloadPrefix,
} from "./supervised-runtime-workspace.js";
import { getSupervisedTask } from "./supervised-task.store.js";

const [mode, executionId, allocationId, databasePath, parentMountNamespace, parentUserNamespace] =
  process.argv.slice(2);
if (
  (mode !== "--namespace" && mode !== "--payload") ||
  !executionId ||
  !allocationId ||
  !databasePath ||
  !parentMountNamespace ||
  !parentUserNamespace ||
  process.argv.length !== 8
) {
  throw new Error("Invalid private review invocation");
}
const options = { path: databasePath };
const context = readSupervisedReviewContext(executionId, allocationId, options);
const controller = new AbortController();
const stop = () => controller.abort(new Error("Review custodian stopped"));
const assertCurrent = () => {
  controller.signal.throwIfAborted();
  assertSupervisedOperationCurrent(context.execution, Date.now(), options);
  if (mode === "--payload") {
    const resource = getSupervisedCommandResources(executionId, options);
    if (resource?.state !== "bound" || !resource.identity) {
      throw new Error("Review scope binding unavailable");
    }
    const { executionId: resourceId, ...identity } = resource.identity;
    assertSupervisedProcessScopeMember(
      { resourceId, ...identity },
      requireNodeWorkerProcessIdentity(process.pid),
    );
  }
};
const heartbeat = setInterval(() => {
  try {
    assertCurrent();
  } catch (error) {
    controller.abort(error);
  }
}, 1000);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
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

async function runPayload() {
  assertCurrent();
  const workspace = path.join(context.reservedRoot, "working", "work");
  if (
    process.cwd() !== workspace ||
    (await fs.realpath(workspace)) !== workspace ||
    (await fs.readlink("/proc/self/ns/user")) === parentUserNamespace ||
    (await fs.readlink("/proc/self/ns/mnt")) === parentMountNamespace
  ) {
    throw new Error("Review payload lacks its exact private runtime workspace");
  }
  const task = getSupervisedTask(context.operation.flowId, options, context.operation.episode);
  if (!task) {
    throw new Error("Review lost its accepted task request");
  }
  let outcome;
  try {
    const { runSupervisedReview } = await import("./supervised-operation.review.js");
    outcome = await withOwnedRuntimeProcess(() =>
      runSupervisedReview({
        contract: context.contract,
        task,
        profile: context.profile,
        runtimeWorkspaceDir: workspace,
        signal: controller.signal,
        assertCurrent,
        reserveDispatch: () =>
          reserveSupervisedOperationDispatch(context.execution, Date.now(), options),
      }),
    );
  } finally {
    await disposeRuntime();
  }
  assertCurrent();
  return parseSupervisedOperationOutcome(outcome);
}

async function runNamespace() {
  const identity = await inspectSupervisedCommandScope({
    executionId: executionId!,
    limits: SUPERVISED_REVIEW_LIMITS,
    expectedProcess: requireNodeWorkerProcessIdentity(process.pid),
    assertCurrent,
  });
  assertCurrent();
  bindSupervisedCommandResources(context.execution, identity, Date.now(), options);
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Review authentication owner unavailable");
  }
  // Preserve inherited auth environment; refuse an unsupported writable scratch
  // override instead of silently routing temporary bytes outside the private cap.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    const root = process.env[key];
    if (
      root &&
      !["/tmp", "/var/tmp", "/dev/shm"].some((base) => root === base || root.startsWith(`${base}/`))
    ) {
      throw new Error("Review requires a private-bound temporary root");
    }
  }
  const prepared = await prepareSupervisedRuntimeWorkspace({
    plan: {
      resourceId: executionId!,
      allocationId: allocationId!,
      storage: SUPERVISED_REVIEW_STORAGE,
      workspace: null,
    },
    allocationId: allocationId!,
    reservedRoot: context.reservedRoot,
    sourceWorkspace: null,
    sourcePaths: [],
    parentMountNamespace: parentMountNamespace!,
    parentUserNamespace: parentUserNamespace!,
    hostUid: uid,
    hostGid: gid,
    ...SUPERVISED_REVIEW_STORAGE,
    assertCurrent,
  });
  const config = getRuntimeConfig();
  const roots = new Set([
    path.dirname(databasePath!),
    path.dirname(resolveAgentDir(config, context.profile.agentId)),
    path.dirname(resolveDefaultAgentDir(config)),
  ]);
  const nativeRoot = resolveSupervisedNativeRuntimeRoot(context.profile.runtime);
  if (nativeRoot) {
    try {
      await fs.access(nativeRoot);
      roots.add(nativeRoot);
    } catch {
      /* No selected existing native store. */
    }
  }
  for (const root of roots) {
    assertCurrent();
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
  const prefix = await supervisedRuntimeWorkspacePayloadPrefix({
    prepared,
    writableRuntimePaths: [...roots],
    readOnlyRuntimeFiles,
    assertCurrent,
  });
  const entrypoint = resolveRuntimeProcessEntrypointUrl("supervisedReview");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const result = await runSupervisedCommandChild({
    id: `${executionId}:review-payload`,
    argv: [
      ...prefix,
      process.execPath,
      ...resolveRuntimeWorkerArgv(entrypoint),
      "--payload",
      executionId!,
      allocationId!,
      databasePath!,
      prepared.mountNamespace,
      prepared.userNamespace,
    ],
    cwd: path.resolve(path.dirname(fileURLToPath(entrypoint)), "../.."),
    env,
    timeoutMs: Math.max(1, context.operation.deadlineAt - Date.now()),
    signal: controller.signal,
    keepInputOpen: true,
    outputLimit: 32768,
    assertCurrent,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("Review payload failed");
  }
  assertCurrent();
  return parseSupervisedOperationOutcome(JSON.parse(result.stdout));
}
try {
  process.stdout.write(
    JSON.stringify(mode === "--payload" ? await runPayload() : await runNamespace()),
  );
} catch {
  // No provider exception, model raw text or protected environment on control stderr.
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  process.stdin.off("end", stop);
  process.stdin.pause();
}
