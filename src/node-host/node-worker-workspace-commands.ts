import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  parseRemoteWorkspaceManifestEnvelope,
  replaceWorkerWorkspaceHashMemoEntries,
  serializeRemoteWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import type { WorkspaceManifestComputationOperations } from "../gateway/worker-environments/workspace-manifest-computation.js";
import {
  computeWorkspaceManifest,
  decodeWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  createRemoteWorkspaceManifestScript,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "../gateway/worker-environments/workspace-sync-scripts.js";
import { executeGitCommandBuffered, executeGitCommandBytes } from "../infra/git-exec.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  projectNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import { AUTHENTICATED_REF_REFRESH_JS } from "../worker/workspace-git-policy.js";
import {
  withNodeWorkerFilesystemCommands,
  type NodeWorkerCommandIsolation,
} from "./node-worker-command-filesystem.js";
import { assertWorkspaceArgv } from "./node-worker-workspace-identity.js";
import type { NodeWorkerWorkspaceProcesses } from "./node-worker-workspace-processes.js";
import type { NodeWorkerWorkspaceQuiescence } from "./node-worker-workspace-quiescence.js";

export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const NODE_MANIFEST_MEMO_BYTES = NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES - 4096;
const boundedManifestScript = createRemoteWorkspaceManifestScript(NODE_MANIFEST_MEMO_BYTES);

/** Exact built-in argv retains the workspace-exec contract; other programs still run as children. */
function nodeWorkspaceManifestCapture(argv: readonly string[], workspaceDir: string) {
  if (
    argv[0] !== "node" ||
    argv[1] !== "-e" ||
    (argv[2] !== REMOTE_WORKSPACE_MANIFEST_JS && argv[2] !== boundedManifestScript) ||
    argv[3] !== workspaceDir
  ) {
    return undefined;
  }
  const baseCommit = argv[4] || null;
  if (
    baseCommit
      ? !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit) ||
        (argv[5] !== "eligible" && argv[5] !== "all")
      : argv[5] !== "all"
  ) {
    return undefined;
  }
  const memoMode = argv.at(-1) === "memo-v1";
  const priorManifestDigests = argv.slice(6, memoMode ? -1 : undefined);
  if (priorManifestDigests.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) {
    return undefined;
  }
  return {
    argv: argv.slice(3),
    maxHashMemoBytes:
      argv[2] === boundedManifestScript ? NODE_MANIFEST_MEMO_BYTES : MAX_WORKSPACE_HASH_MEMO_BYTES,
  };
}

async function runNodeWorkspaceManifestCapture(
  params: WorkspaceManifestComputationOperations["workspace.manifest.remote-capture"]["input"] & {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    isolation?: NodeWorkerCommandIsolation;
  },
): Promise<string> {
  const { env, signal, isolation, ...input } = params;
  const commandEnv = { ...workspaceCommandEnv(input.home, env), GIT_NO_LAZY_FETCH: "1" };
  return await computeWorkspaceManifest(
    { type: "workspace.manifest.remote-capture", input },
    signal,
    {
      text: (cwd, args, options) =>
        withNodeWorkerFilesystemCommands(
          { isolation, workspaceDir: cwd, homeDir: input.home, env: commandEnv, signal },
          () =>
            executeGitCommandBytes(cwd, args, { ...options, baseEnv: commandEnv, env: undefined }),
        ),
      buffered: (cwd, args, options) =>
        withNodeWorkerFilesystemCommands(
          { isolation, workspaceDir: cwd, homeDir: input.home, env: commandEnv, signal },
          () =>
            executeGitCommandBuffered(cwd, args, {
              ...options,
              baseEnv: commandEnv,
              env: undefined,
            }),
        ),
    },
  );
}

export async function readWorkspaceManifest(
  homeDir: string,
  manifestRef: string,
  signal?: AbortSignal,
) {
  const raw = await fs.readFile(
    path.join(
      homeDir,
      ".openclaw-worker",
      "manifests",
      `${manifestRef.slice("sha256:".length)}.json`,
    ),
    "utf8",
  );
  const { manifest } = await decodeWorkspaceManifest(raw, manifestRef, signal);
  return { raw, manifest };
}

/** Environment for node-owned workspace commands: pinned HOME, no credential prompts. */
export function workspaceCommandEnv(
  homeDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    HOME: homeDir,
    ...(process.platform === "linux"
      ? { PATH: path.join(homeDir, ".local", "bin") + path.delimiter + (baseEnv.PATH ?? "") }
      : {}),
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
}

/** Runs one workspace-scoped command, requiring successful exit and complete stdout. */
export async function runWorkspaceCommand(params: {
  workspaceDir: string;
  homeDir: string;
  argv: string[];
  input?: string | Uint8Array;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  isolation?: NodeWorkerCommandIsolation;
  outputDirectories?: readonly string[];
}): Promise<string> {
  const maxOutputBytes = params.maxOutputBytes ?? 128 * 1024;
  const baseEnv = workspaceCommandEnv(params.homeDir);
  const result = await withNodeWorkerFilesystemCommands({ ...params, env: baseEnv }, () =>
    runCommandWithTimeout(params.argv, {
      executionIntent: "gateway-internal",
      cwd: params.workspaceDir,
      baseEnv,
      ...(params.input === undefined ? {} : { input: params.input }),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      signal: params.signal,
      maxOutputBytes,
      maxCombinedOutputBytes: maxOutputBytes + 128 * 1024,
    }),
  );
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || result.stdout).trim()}`);
  }
  if (result.stdoutTruncatedBytes || result.outputLimitExceeded) {
    throw new Error("workspace transfer apply failed: command output was truncated");
  }
  return result.stdout;
}

export async function captureManifest(params: {
  mode: "eligible" | "all";
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  referenceManifestRef: string;
  baseManifestRef?: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
  isolation?: NodeWorkerCommandIsolation;
}): Promise<string> {
  const priorManifestDigests = [
    ...new Set(
      [
        params.referenceManifestRef,
        ...(params.baseManifestRef ? [params.baseManifestRef] : []),
      ].map((ref) => ref.slice("sha256:".length)),
    ),
  ];
  const input =
    params.hashMemo === undefined ? undefined : serializeRemoteWorkspaceHashMemo(params.hashMemo);
  const stdout = (
    await runNodeWorkspaceManifestCapture({
      argv: [
        params.workspaceDir,
        params.baseCommit ?? "",
        params.mode,
        ...priorManifestDigests,
        ...(input === undefined ? [] : ["memo-v1"]),
      ],
      home: params.manifestHome,
      memo: input,
      maxHashMemoBytes: MAX_WORKSPACE_HASH_MEMO_BYTES,
      isolation: params.isolation,
      signal: AbortSignal.any([
        ...(params.signal ? [params.signal] : []),
        AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      ]),
    })
  ).trim();
  if (params.hashMemo === undefined) {
    return stdout;
  }
  const envelope = parseRemoteWorkspaceManifestEnvelope(stdout);
  replaceWorkerWorkspaceHashMemoEntries(params.hashMemo, envelope.memo);
  return envelope.manifestRef;
}

export function projectWorkspaceOperationResult(
  workspaceDir: string,
  stdout: string,
  argv?: readonly string[],
): NodeWorkerWorkspaceExecResult {
  return projectNodeWorkerWorkspaceExecResult(
    workspaceDir,
    {
      stdout,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    },
    argv,
  );
}

/** Dispatch node-owned workspace commands through the existing process and manifest owners. */
export async function executeNodeWorkerWorkspaceCommand(params: {
  input: NodeWorkerWorkspaceExecInput;
  workspaceDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  isolation?: NodeWorkerCommandIsolation;
  signal?: AbortSignal;
  timeoutMs: number;
  assertCurrent: () => void;
  retainWorkspace: () => () => void;
  processes: NodeWorkerWorkspaceProcesses;
  quiescence: NodeWorkerWorkspaceQuiescence;
}): Promise<NodeWorkerWorkspaceExecResult> {
  const { input, workspaceDir, homeDir, env, isolation, signal, timeoutMs } = params;
  const trustedGitRefresh =
    input.argv.length === 3 &&
    input.argv[0] === "node" &&
    input.argv[1] === "-e" &&
    input.argv[2] === AUTHENTICATED_REF_REFRESH_JS;
  const commandEnv = workspaceCommandEnv(homeDir, env);
  if (trustedGitRefresh) {
    // A model-writable HOME must not choose the program receiving a GitHub token.
    commandEnv.PATH = env.PATH;
  }
  if (input.quiescence) {
    if (input.argv[1] !== workspaceDir) {
      throw new Error("INVALID_REQUEST: workspace quiescence root does not match its owner");
    }
    const stdout = await params.quiescence.execute(
      { input, workspaceDir, env: commandEnv, retainWorkspace: params.retainWorkspace },
      signal,
    );
    return projectWorkspaceOperationResult(workspaceDir, stdout);
  }
  assertWorkspaceArgv(workspaceDir, input.argv);
  const capture = input.process
    ? undefined
    : nodeWorkspaceManifestCapture(input.argv, workspaceDir);
  if (capture) {
    const stdout = await runNodeWorkspaceManifestCapture({
      ...capture,
      home: homeDir,
      memo: input.input,
      env,
      isolation,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    });
    return projectWorkspaceOperationResult(workspaceDir, stdout, input.argv);
  }
  const output = await params.processes.execute({
    input: trustedGitRefresh
      ? { ...input, argv: [process.execPath, ...input.argv.slice(1)] }
      : input,
    ...(trustedGitRefresh ? { temporaryHome: true as const } : {}),
    assertCurrent: params.assertCurrent,
    workspaceDir,
    env: commandEnv,
    homeDir,
    isolation,
    signal,
    timeoutMs,
    retainWorkspace: params.retainWorkspace,
  });
  return input.process ? output : projectNodeWorkerWorkspaceExecResult(workspaceDir, output);
}
