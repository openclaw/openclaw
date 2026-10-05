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
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  projectNodeWorkerWorkspaceExecResult,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
export function projectWorkspaceOperationResult(
  workspaceDir: string,
  stdout: string,
  argv?: readonly string[],
): NodeWorkerWorkspaceExecResult {
  return projectNodeWorkerWorkspaceExecResult(
    workspaceDir,
    { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" },
    argv,
  );
}

export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const commandLog = createSubsystemLogger("node-host/worker-workspace");
const NODE_MANIFEST_MEMO_BYTES = NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES - 4096;
const boundedManifestScript = createRemoteWorkspaceManifestScript(NODE_MANIFEST_MEMO_BYTES);

/** Exact built-in argv retains the workspace-exec contract; other programs still run as children. */
export function nodeWorkspaceManifestCapture(argv: readonly string[], workspaceDir: string) {
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
      ? !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit) || argv[5] !== "eligible"
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

export async function runNodeWorkspaceManifestCapture(
  params: WorkspaceManifestComputationOperations["workspace.manifest.remote-capture"]["input"] & {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<string> {
  const { env, signal, ...input } = params;
  const commandEnv = workspaceCommandEnv(input.home, env);
  return await computeWorkspaceManifest(
    { type: "workspace.manifest.remote-capture", input },
    signal,
    {
      text: (cwd, args, options) =>
        executeGitCommandBytes(cwd, args, { ...options, baseEnv: commandEnv, env: undefined }),
      buffered: (cwd, args, options) =>
        executeGitCommandBuffered(cwd, args, { ...options, baseEnv: commandEnv, env: undefined }),
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
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
}

/** Runs one workspace-scoped command and returns stdout, failing on nonzero exit. */
export async function runWorkspaceCommand(params: {
  workspaceDir: string;
  homeDir: string;
  argv: string[];
  input?: string | Uint8Array;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}): Promise<string> {
  const maxOutputBytes = params.maxOutputBytes ?? 128 * 1024;
  const result = await runCommandWithTimeout(params.argv, {
    cwd: params.workspaceDir,
    baseEnv: workspaceCommandEnv(params.homeDir),
    ...(params.input === undefined ? {} : { input: params.input }),
    timeoutMs: TRANSFER_TIMEOUT_MS,
    signal: params.signal,
    maxOutputBytes,
    maxCombinedOutputBytes: maxOutputBytes + 128 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export async function captureManifest(params: {
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  referenceManifestRef: string;
  baseManifestRef?: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
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
        params.baseCommit ? "eligible" : "all",
        ...priorManifestDigests,
        ...(input === undefined ? [] : ["memo-v1"]),
      ],
      home: params.manifestHome,
      memo: input,
      maxHashMemoBytes: MAX_WORKSPACE_HASH_MEMO_BYTES,
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
  commandLog.debug("node worker manifest capture completed", {
    workspaceDir: params.workspaceDir,
    ...envelope.metrics,
  });
  return envelope.manifestRef;
}
