import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  createGitCommandError,
  enqueueGitRefMutation,
  GIT_TIMEOUT_MS,
} from "../../infra/git-exec.js";
import type { SandboxBackendCommandResult } from "../sandbox/backend-handle.types.js";
import { requireSandboxBackendFactory } from "../sandbox/backend.js";
import { resolveSandboxConfigForAgent } from "../sandbox/config.js";
import { resolveSandboxDockerUser } from "../sandbox/docker-user.js";
import { hashTextSha256 } from "../sandbox/hash.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import type { WorktreeGitIsolation } from "./git-isolation.js";
import {
  findGitCheckoutRoot,
  gitEnvironment,
  withWorktreeGitExecutor,
  type GitResult,
  type WorktreeGitExecutor,
} from "./git.js";
import { resolveManagedWorktreeGitMount } from "./linked-git-mount.js";
import {
  markRegistryRepositorySandboxGitByRoot,
  resolveRepositoryIsolationRoot,
} from "./repository-provenance.js";
import {
  buildProvisioningMounts,
  createProvisioningRuntimePool,
  resolveAdmittedWorktreeDestination,
  resolveOperationSnapshotMount,
} from "./sandbox-git-runtime.js";

const PROVISIONING_SCOPE_PREFIX = "worktree-provisioning";
const PROVISIONING_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export type { WorktreeGitIsolation } from "./git-isolation.js";

function limitedOutput(buffer: Buffer, maxOutputBytes?: number) {
  if (maxOutputBytes === undefined || buffer.length <= maxOutputBytes) {
    return { buffer, truncatedBytes: 0 };
  }
  return {
    buffer: buffer.subarray(buffer.length - maxOutputBytes),
    truncatedBytes: buffer.length - maxOutputBytes,
  };
}

function buildGitEnvironment(
  configured: Record<string, string> | undefined,
  requested: NodeJS.ProcessEnv | undefined,
  args: readonly string[],
): Record<string, string> {
  const explicit = Object.fromEntries(
    Object.entries(configured ?? {}).filter(([, value]) => typeof value === "string"),
  );
  const requestedGit = Object.fromEntries(
    Object.entries(requested ?? {}).filter(
      ([key, value]) => /^GIT_[A-Z0-9_]+$/.test(key) && typeof value === "string",
    ),
  );
  const hardened = gitEnvironment({ ...explicit, ...requestedGit }, args, "linux", {});
  return Object.fromEntries(
    Object.entries({ HOME: "/tmp", PATH: PROVISIONING_PATH, ...hardened }).map(([key, value]) => [
      key,
      value ?? "",
    ]),
  );
}

async function runSandboxGit(params: {
  backend: Awaited<ReturnType<ReturnType<typeof requireSandboxBackendFactory>>>;
  configuredEnv?: Record<string, string>;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ result: GitResult; stdout: Buffer }> {
  const timeoutMs = params.timeoutMs ?? GIT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const environment = buildGitEnvironment(params.configuredEnv, params.env, params.args);
  const environmentNames = Object.keys(environment);
  const cleanEnvironment = environmentNames.map((key) => `${key}="$${key}"`).join(" ");
  let command: SandboxBackendCommandResult;
  try {
    command = await params.backend.runShellCommand({
      script: `cwd="$1"; shift; cd -- "$cwd" || exit 125; exec env -i ${cleanEnvironment} "$@"`,
      args: [params.cwd, "git", "-C", params.cwd, ...params.args],
      env: environment,
      stdin:
        typeof params.input === "string"
          ? params.input
          : params.input
            ? Buffer.from(params.input)
            : undefined,
      allowFailure: true,
      signal,
      terminateOnAbort: true,
    });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
    const timedOut = timeoutSignal.aborted && !params.signal?.aborted;
    return {
      result: {
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        killed: true,
        termination: timedOut ? "timeout" : "signal",
        timeoutMs,
      },
      stdout: Buffer.alloc(0),
    };
  }
  const stdout = limitedOutput(command.stdout, params.maxOutputBytes);
  const stderr = limitedOutput(command.stderr, params.maxOutputBytes);
  return {
    result: {
      stdout: stdout.buffer.toString("utf8"),
      stderr: stderr.buffer.toString("utf8"),
      ...(stdout.truncatedBytes ? { stdoutTruncatedBytes: stdout.truncatedBytes } : {}),
      ...(stderr.truncatedBytes ? { stderrTruncatedBytes: stderr.truncatedBytes } : {}),
      code: command.code,
      signal: null,
      killed: false,
      termination: "exit",
      timeoutMs,
    },
    stdout: stdout.buffer,
  };
}

/**
 * Builds the Git executor for a sandbox-writable session source.
 * Trusted/non-sandboxed sources return undefined and retain host Git behavior.
 */
export async function createWorktreeGitExecutor(params: {
  isolation?: WorktreeGitIsolation;
  repoRoot: string;
  worktreeRoot?: string;
  allocationRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WorktreeGitExecutor | undefined> {
  const isolation = params.isolation;
  if (!isolation) {
    return undefined;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: isolation.config,
    agentId: isolation.agentId,
    sessionKey: isolation.sessionKey,
  });
  const configured = resolveSandboxConfigForAgent(isolation.config, runtime.agentId);
  if (
    !isolation.required &&
    (!runtime.sandboxed || (configured.workspaceAccess !== "rw" && !runtime.sandboxRequired))
  ) {
    return undefined;
  }
  const backendId = configured.backend.trim().toLowerCase();
  if (backendId !== "docker" && backendId !== "podman") {
    throw new Error(
      `Managed worktree Git requires a local container sandbox for sandbox-writable source metadata; backend ${configured.backend} cannot provide that boundary.`,
    );
  }
  if (process.platform === "win32") {
    throw new Error(
      "Managed worktree Git for sandbox-writable source metadata is not available on Windows because linked-worktree path identity cannot be preserved safely.",
    );
  }

  const env = params.env ?? process.env;
  const repoRoot = await fs.realpath(params.repoRoot);
  const checkoutRoot = findGitCheckoutRoot(repoRoot);
  if (!checkoutRoot) {
    throw new Error(`Managed worktree source is not a Git checkout: ${params.repoRoot}`);
  }
  const canonicalCheckoutRoot = await fs.realpath(checkoutRoot);
  const repositoryIsolationRoot = await resolveRepositoryIsolationRoot(canonicalCheckoutRoot);
  if (!repositoryIsolationRoot) {
    throw new Error(`Managed worktree source has no canonical repository identity: ${repoRoot}`);
  }
  const worktreeRoot = path.resolve(
    params.allocationRoot ??
      params.worktreeRoot ??
      isolation.config.worktreeRoot ??
      path.join(resolveStateDir(env), "worktrees"),
  );
  const tempRoot = path.join(resolveStateDir(env), "worktree-tmp");
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  const canonicalWorktreeRoot = await fs.realpath(worktreeRoot);
  const canonicalTempRoot = await fs.realpath(tempRoot);
  const linkedGitMount = await resolveManagedWorktreeGitMount({
    workspaceDir: canonicalCheckoutRoot,
    env,
    writableBySessionKey: isolation.sessionKey,
  });
  markRegistryRepositorySandboxGitByRoot({ env, repoRoot: repositoryIsolationRoot, isolation });
  const docker = await resolveSandboxDockerUser({
    backend: backendId,
    docker: configured.docker,
    workspaceDir: canonicalCheckoutRoot,
  });
  const cfg = {
    ...configured,
    backend: backendId,
    scope: "session" as const,
    workspaceAccess: "rw" as const,
    browser: { ...configured.browser, enabled: false },
    docker: {
      ...docker,
      // Provisioning receives only core-selected filesystem paths. Operator-provided
      // sandbox env remains the explicit credential/transport grant for this agent.
      binds: undefined,
    },
  };
  const baseMounts = [canonicalCheckoutRoot].map((hostPath) => ({
    hostPath,
    containerPath: hostPath,
    readOnly: false,
  }));
  if (linkedGitMount) {
    baseMounts.push(linkedGitMount);
  }
  const executorNonce = randomUUID();
  const runtimePool = createProvisioningRuntimePool({
    backendId: cfg.backend,
    async create(mounts, generation) {
      // Mount identity is part of the scope: a hot discovery runtime cannot be
      // reused under the wider final allocation grant.
      const scopeHash = hashTextSha256(
        `${runtime.agentId}\n${isolation.sessionKey}\n${executorNonce}\n${generation}\n${mounts
          .map((mount) => `${mount.hostPath}:${mount.containerPath}:${mount.readOnly}`)
          .join("\n")}`,
      ).slice(0, 16);
      return await requireSandboxBackendFactory(cfg.backend)({
        sessionKey: isolation.sessionKey,
        scopeKey: `${PROVISIONING_SCOPE_PREFIX}:${scopeHash}`,
        workspaceDir: canonicalCheckoutRoot,
        agentWorkspaceDir: canonicalCheckoutRoot,
        cfg,
        requireCurrentConfig: true,
        internalMounts: mounts,
      });
    },
  });
  const createBackend = (mounts: Parameters<typeof runtimePool.create>[0]) =>
    runtimePool.create(mounts);
  const disposeBackends = () => runtimePool.dispose();
  try {
    const discoveryBackend = await createBackend(baseMounts);
    const commonResult = await runSandboxGit({
      backend: discoveryBackend,
      configuredEnv: cfg.docker.env,
      cwd: repoRoot,
      args: ["rev-parse", "--git-common-dir"],
    });
    if (commonResult.result.code !== 0 || commonResult.result.termination !== "exit") {
      throw createGitCommandError("git rev-parse --git-common-dir", commonResult.result);
    }
    const commonRaw = commonResult.result.stdout.trim();
    const commonDir = await fs.realpath(
      path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw),
    );
    const originResult = await runSandboxGit({
      backend: discoveryBackend,
      configuredEnv: cfg.docker.env,
      cwd: repoRoot,
      args: ["config", "--get", "remote.origin.url"],
    });
    if (
      originResult.result.termination !== "exit" ||
      (originResult.result.code !== 0 && originResult.result.code !== 1)
    ) {
      throw createGitCommandError("git config --get remote.origin.url", originResult.result);
    }
    const fingerprint = hashTextSha256(
      `${commonDir}\n${originResult.result.code === 0 ? originResult.result.stdout.trim() : ""}`,
    ).slice(0, 16);
    const repositoryAllocationRoot = path.join(canonicalWorktreeRoot, fingerprint);
    let backend = discoveryBackend;
    let admittedDestination: string | undefined;
    let admittedSnapshotDir: string | undefined;
    const currentMounts = () =>
      buildProvisioningMounts(baseMounts, admittedDestination, admittedSnapshotDir);
    const admitDestination = async (destination: string) => {
      admittedDestination = await resolveAdmittedWorktreeDestination({
        destination,
        allocationRoot: params.allocationRoot,
        repositoryAllocationRoot,
        env,
        repoRoot: repositoryIsolationRoot,
      });
      backend = await createBackend(currentMounts());
    };
    if (params.allocationRoot) {
      await admitDestination(params.allocationRoot);
    }

    const admitWorktreeAdd = async (args: readonly string[]) => {
      if (params.allocationRoot || args[0] !== "worktree" || args[1] !== "add") {
        return;
      }
      const separator = args.lastIndexOf("--");
      const destination = separator >= 0 ? args[separator + 1] : undefined;
      if (!destination) {
        throw new Error("Managed worktree add is missing its admitted destination.");
      }
      await admitDestination(destination);
    };

    const admitSnapshotIndex = async (requestedEnv: NodeJS.ProcessEnv | undefined) => {
      const snapshotDir = await resolveOperationSnapshotMount({
        requestedEnv,
        canonicalTempRoot,
      });
      if (!snapshotDir) {
        return;
      }
      if (snapshotDir === admittedSnapshotDir) {
        return;
      }
      admittedSnapshotDir = snapshotDir;
      backend = await createBackend(currentMounts());
    };

    return {
      async run(cwd, args, options) {
        await admitWorktreeAdd(args);
        await admitSnapshotIndex(options?.env);
        if (args[0] === "worktree" && args[1] === "remove") {
          options?.signal?.throwIfAborted();
          const destination = path.resolve(args.at(-1) ?? "");
          if (!admittedDestination || destination !== admittedDestination) {
            throw new Error("Managed worktree removal escaped its admitted destination.");
          }
          await fs.rm(admittedDestination, { recursive: true, force: true });
          backend = await createBackend(baseMounts);
          return (
            await runSandboxGit({
              backend,
              configuredEnv: cfg.docker.env,
              cwd,
              args: ["worktree", "remove", "--force", "--", destination],
              ...options,
            })
          ).result;
        }
        const execute = async () =>
          (
            await runSandboxGit({
              backend,
              configuredEnv: cfg.docker.env,
              cwd,
              args,
              ...options,
            })
          ).result;
        const mutatesRefs =
          args[0] === "fetch" ||
          args[0] === "update-ref" ||
          (args[0] === "branch" &&
            args.some((arg) => arg === "-d" || arg === "-D" || arg === "--delete"));
        return mutatesRefs
          ? await enqueueGitRefMutation(canonicalCheckoutRoot, commonDir, execute)
          : await execute();
      },
      async runBuffer(cwd, args, options) {
        await admitSnapshotIndex(options?.env);
        const executed = await runSandboxGit({
          backend,
          configuredEnv: cfg.docker.env,
          cwd,
          args,
          ...options,
        });
        if (executed.result.code !== 0 || executed.result.termination !== "exit") {
          throw createGitCommandError(`git ${args.join(" ")}`, executed.result);
        }
        if (executed.result.stdoutTruncatedBytes) {
          throw new Error(`git ${args.join(" ")} exceeded its output limit`);
        }
        return executed.stdout;
      },
      dispose: disposeBackends,
    };
  } catch (error) {
    try {
      await disposeBackends();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Managed worktree Git setup and sandbox cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Execute a complete worktree operation inside its provenance-selected Git boundary. */
export async function withWorktreeGitIsolation<T>(
  params: Parameters<typeof createWorktreeGitExecutor>[0],
  run: () => Promise<T>,
): Promise<T> {
  const executor = await createWorktreeGitExecutor(params);
  return await withWorktreeGitExecutor(executor, run);
}
