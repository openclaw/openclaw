import { createHash } from "node:crypto";
import os from "node:os";
import { runGitBuffered } from "../../agents/worktrees/git.js";
import { enqueueGitRefMutation, gitCommandArgv } from "../../infra/git-exec.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { StagedWorkerWorkspaceInventory } from "./workspace-result-inventory.js";

type StagedManifestReads = Map<string, Promise<StagedWorkerWorkspaceInventory>>;
const stagedManifestReads = resolveGlobalMap<AbortSignal | undefined, StagedManifestReads>(
  Symbol.for("openclaw.workspaceStagedManifestReads"),
);

/** Shares only pending reads; result-ref writers invalidate admission on both sides. */
export function joinStagedWorkspaceManifestRead(
  input: { root: string; ref: string; buildCacheInputs?: string[] },
  signal: AbortSignal | undefined,
  read: () => Promise<StagedWorkerWorkspaceInventory>,
): Promise<StagedWorkerWorkspaceInventory> {
  signal?.throwIfAborted();
  // The broker captures this environment and input synchronously at admission.
  // Hash the complete environment so Git policy differs without retaining credentials.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        process.cwd(),
        input,
        Object.entries(process.env).toSorted(([left], [right]) => left.localeCompare(right)),
      ]),
    )
    .digest("hex");
  const reads: StagedManifestReads = stagedManifestReads.get(signal) ?? new Map();
  const pending = reads.get(key);
  if (pending) {
    return pending;
  }
  const operation = read();
  stagedManifestReads.set(signal, reads);
  reads.set(key, operation);
  const settled = () => {
    reads.delete(key);
    if (reads.size === 0 && stagedManifestReads.get(signal) === reads) {
      stagedManifestReads.delete(signal);
    }
  };
  void operation.then(settled, settled);
  return operation;
}

export const WORKSPACE_RESULT_GIT_TIMEOUT_MS = 10 * 60_000;

export function workspaceResultCheckpointInitArgs(): string[] {
  return ["init", "--quiet", "--bare", "--object-format=sha1"];
}

export async function readWorkspaceResultGit(
  root: string,
  args: string[],
  options: { maxOutputBytes: number; input?: Uint8Array },
  failureMessage = `git ${args[0]} failed`,
): Promise<Buffer> {
  const result = await withGitProcessOperation(
    "workspace.result",
    () =>
      runGitBuffered(root, args, {
        timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
        ...options,
      }),
    "default",
  );
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || failureMessage);
  }
  return result.stdout;
}

export function workspaceResultGitCommand(cwd: string, args: string[]): string[] {
  return gitCommandArgv(cwd, args, [
    // The platform null device disables hooks without trusting an unowned path.
    `core.hooksPath=${os.devNull}`,
    "core.fsmonitor=false",
  ]);
}

export async function requireWorkspaceResultGit(
  cwd: string,
  args: string[],
  options: { input?: Uint8Array; baseEnv?: NodeJS.ProcessEnv; beforeInput?: () => void } = {},
): Promise<string> {
  const { runCommandWithTimeout } = await import("../../process/exec.js");
  const result = await withGitProcessOperation(
    "workspace.result",
    () =>
      runCommandWithTimeout(workspaceResultGitCommand(cwd, args), {
        timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024,
        baseEnv: options.baseEnv,
        input: options.input,
        beforeInput: options.beforeInput,
      }),
    "default",
  );
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

export async function withWorkspaceResultRefMutation<T>(
  root: string,
  operation: (baseEnv: NodeJS.ProcessEnv) => Promise<T>,
  prepared?: { commonDir?: string; baseEnv: NodeJS.ProcessEnv },
): Promise<T> {
  // Git environment can redirect discovery or a queued writer; bind both to
  // the same snapshot while keeping the worker's timeout and byte contracts.
  const baseEnv = prepared?.baseEnv ?? { ...process.env };
  const common =
    prepared?.commonDir ??
    (await requireWorkspaceResultGit(root, ["rev-parse", "--git-common-dir"], { baseEnv }));
  return await enqueueGitRefMutation(root, common, async () => {
    // Clear lookup only: admitted reads keep their outcome, but later readers must
    // observe the ref mutation, including aliases and partially failed writes.
    stagedManifestReads.clear();
    try {
      return await operation(baseEnv);
    } finally {
      stagedManifestReads.clear();
    }
  });
}

type WorkspaceResultRefUpdate = { ref: string; objectId?: string };

/** Atomically moves/deletes result refs before their caller changes its durable fence. */
export async function updateWorkspaceResultRefs(
  root: string,
  updates:
    | readonly WorkspaceResultRefUpdate[]
    | (() => readonly WorkspaceResultRefUpdate[] | Promise<readonly WorkspaceResultRefUpdate[]>),
  assertCurrent?: () => void,
): Promise<void> {
  await withWorkspaceResultRefMutation(root, async (baseEnv) => {
    assertCurrent?.();
    const current = typeof updates === "function" ? await updates() : updates;
    assertCurrent?.();
    if (current.length === 0) {
      return;
    }
    const input = current
      .map(({ ref, objectId }) =>
        objectId === undefined ? `delete ${ref}\0\0` : `update ${ref}\0${objectId}\0\0`,
      )
      .join("");
    await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], {
      input: Buffer.from(input),
      baseEnv,
      beforeInput: assertCurrent,
    });
  });
}

export async function readWorkspaceResultRefObjects(
  root: string,
  refs: readonly string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const output = await requireWorkspaceResultGit(
    root,
    ["for-each-ref", "--format=%(refname) %(objectname)", ...refs],
    { baseEnv },
  );
  const objects = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    const ref = line.slice(0, separator);
    if (refs.includes(ref)) {
      objects.set(ref, line.slice(separator + 1));
    }
  }
  return objects;
}

/** Publish immutable result identities idempotently under the existing ref-mutation owner. */
export async function publishImmutableWorkspaceResultRefs(
  root: string,
  targets: readonly (readonly [string, string | undefined])[],
  assertCurrent: () => void,
): Promise<void> {
  await withWorkspaceResultRefMutation(root, async (baseEnv) => {
    const updates: string[] = [];
    const objects = await readWorkspaceResultRefObjects(
      root,
      targets.map(([target]) => target),
      baseEnv,
    );
    for (const [target, expected] of targets) {
      const existing = objects.get(target);
      if (existing !== undefined && existing !== expected) {
        throw new Error("Repository checkpoint identity already contains a different result");
      }
      if (expected !== undefined && existing === undefined) {
        updates.push(`create ${target}\0${expected}\0`);
      }
    }
    assertCurrent();
    if (updates.length) {
      await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], {
        input: Buffer.from(updates.join("")),
        baseEnv,
        beforeInput: assertCurrent,
      });
    }
  });
}
