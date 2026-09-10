import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { runSupervisedCommandChild } from "./supervised-command-child.js";
import { readSupervisedCommandContext } from "./supervised-command-context.js";
import { bindSupervisedCommandResources } from "./supervised-command-custody.js";
import { inspectSupervisedCommandScope } from "./supervised-command-resources.js";
import {
  harvestSupervisedCommandWorkspace,
  prepareSupervisedCommandWorkspace,
  supervisedCommandWorkspaceMountArgs,
} from "./supervised-command-workspace.js";
import {
  assertSupervisedOperationCurrent,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import {
  parseSupervisedOperationOutcome,
  type SupervisedOperationOutcome,
} from "./supervised-operation.types.js";

function parseInvocation() {
  const [mode, executionId, allocationId, databasePath, parentMountNamespace, parentUserNamespace] =
    process.argv.slice(2);
  if (
    (mode !== "--scope" && mode !== "--namespace") ||
    !executionId ||
    !allocationId ||
    !databasePath ||
    !parentMountNamespace ||
    !parentUserNamespace ||
    process.argv.length !== 8
  ) {
    throw new Error("Invalid private command invocation");
  }
  return {
    mode,
    executionId,
    allocationId,
    databasePath,
    parentMountNamespace,
    parentUserNamespace,
  };
}
const { mode, executionId, allocationId, databasePath, parentMountNamespace, parentUserNamespace } =
  parseInvocation();
const options = { path: databasePath };
const context = readSupervisedCommandContext(executionId, allocationId, options);
const controller = new AbortController();
const stop = () => controller.abort(new Error("Command custodian stopped"));
const assertCurrent = () => {
  controller.signal.throwIfAborted();
  assertSupervisedOperationCurrent(context.execution, Date.now(), options);
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

async function run(): Promise<SupervisedOperationOutcome> {
  if (mode === "--scope") {
    // Inspect before mapping UID 0 in the private namespace: user-manager
    // identity belongs to the original host process, not the mapped UID.
    const identity = await inspectSupervisedCommandScope({
      executionId,
      limits: {
        memoryBytes: context.profile.resourceLimits.memoryBytes,
        tasks: context.profile.resourceLimits.tasks,
      },
      expectedProcess: requireNodeWorkerProcessIdentity(process.pid),
      assertCurrent,
    });
    assertCurrent();
    bindSupervisedCommandResources(context.execution, identity, Date.now(), options);
    const argv = [
      "/usr/bin/unshare",
      "--user",
      "--map-root-user",
      "--mount",
      "--fork",
      "--kill-child",
      process.execPath,
      ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("supervisedCommand")),
      "--namespace",
      executionId,
      allocationId,
      databasePath,
      parentMountNamespace,
      parentUserNamespace,
    ];
    const result = await runSupervisedCommandChild({
      id: `${executionId}:namespace`,
      argv,
      cwd: path.dirname(fileURLToPath(resolveRuntimeProcessEntrypointUrl("supervisedCommand"))),
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeoutMs: Math.max(1, context.operation.deadlineAt - Date.now()),
      keepInputOpen: true,
      outputLimit: 32768,
      signal: controller.signal,
      assertCurrent,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Command namespace did not finish: ${result.stderr.slice(-2048)}`);
    }
    assertCurrent();
    return parseSupervisedOperationOutcome(JSON.parse(result.stdout));
  }
  const userNamespace = await fs.readlink("/proc/self/ns/user");
  assertCurrent();
  if (!/^user:\[\d+\]$/.test(parentUserNamespace) || userNamespace === parentUserNamespace) {
    throw new Error("Command namespace limit requires a verified private user namespace");
  }
  // Linux charges descendant namespaces recursively to this private ancestor.
  // Reserve its sole child for bwrap; payload cannot add mounts in a new user
  // namespace to bypass the working tmpfs cap. Never changes the host setting.
  await fs.writeFile("/proc/sys/user/max_user_namespaces", "1");
  assertCurrent();
  if ((await fs.readFile("/proc/sys/user/max_user_namespaces", "utf8")).trim() !== "1") {
    throw new Error("Command descendant namespace bound was not installed");
  }
  const prepared = await prepareSupervisedCommandWorkspace({
    ...context,
    allocationId,
    parentMountNamespace,
    workingBytes: context.profile.resourceLimits.workingBytes,
    workingInodes: context.profile.resourceLimits.workingInodes,
    assertCurrent,
  });
  const argv = [
    "/usr/bin/bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop",
    "ALL",
  ];
  for (const root of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
    try {
      await fs.access(root);
      argv.push("--ro-bind", root, root);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  argv.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...supervisedCommandWorkspaceMountArgs(prepared),
    "--setenv",
    "PATH",
    "/runtime:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/home/worker",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--chdir",
    prepared.cwd,
    "/runtime/command",
    ...context.profile.argv,
  );
  assertCurrent();
  reserveSupervisedOperationDispatch(context.execution, Date.now(), options);
  const result = await runSupervisedCommandChild({
    id: `${executionId}:payload`,
    argv,
    cwd: prepared.workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    timeoutMs: context.profile.timeoutMs,
    signal: controller.signal,
    assertCurrent,
  });
  assertCurrent();
  // runSupervisedCommandChild resolves only after required-all extinction.
  const exported = await harvestSupervisedCommandWorkspace({
    prepared,
    assertPayloadExtinct: async () => {},
    assertCurrent,
  });
  return {
    status: result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed",
    summary: result.exitCode === 0 ? "Accepted command completed" : "Accepted command did not pass",
    facts: {
      exitCode: String(result.exitCode),
      signal: String(result.exitSignal),
      timedOut: String(result.timedOut),
      sourceHash: prepared.before.hash,
      commandInputHash: prepared.commandInputHash,
      resultHash: exported.snapshot.hash,
      stdout: result.stdout.slice(-6000),
      stderr: result.stderr.slice(-6000),
      cleanup: "observed",
      outputPolicy: "bounded-tail-6000-characters",
      workingBytes: String(prepared.workingBytes),
      workingInodes: String(prepared.workingInodes),
    },
    artifacts: [],
  };
}
try {
  process.stdout.write(JSON.stringify(parseSupervisedOperationOutcome(await run())));
} catch (error) {
  process.stderr.write(
    error instanceof Error ? error.message.slice(0, 4096) : "Command custodian failed",
  );
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  process.stdin.off("end", stop);
  process.stdin.pause();
}
