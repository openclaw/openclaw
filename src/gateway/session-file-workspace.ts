import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxSession } from "../agents/sandbox/session-selection.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionMutationForbiddenError } from "./session-mutation-authorization-error.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import type { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";

/** File readers consume sandbox selection without preparing or provisioning its workspace. */
export async function prepareSessionFileWorkspace(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
  entry: Partial<InternalSessionEntry>,
  message?: { entryId: string; storePath: string },
  options: { inheritWorkspace?: boolean } = {},
) {
  if (entry.inheritedWorktreeId && !entry.worktree?.id && !options.inheritWorkspace) {
    throw sessionMutationForbiddenError(
      "This operation requires its own workspace; open the source conversation's workspace instead.",
    );
  }
  const policy = (config: OpenClawConfig, current: Partial<InternalSessionEntry>) => ({
    roots: resolveSessionWorkspaceRoots(config, agentId, current),
    runtime: resolveSandboxRuntimeStatus({
      cfg: config,
      agentId,
      sessionKey,
      preparedSessionEntry: current,
    }),
    sandbox: resolveSandboxConfigForAgent(config, agentId),
    librarySelections: current.skillsSnapshot?.librarySelections,
    worktreeId: current.worktree?.id,
    inheritedWorktreeId: current.inheritedWorktreeId,
  });
  const selection = (value: ReturnType<typeof policy>) => ({
    roots: value.roots,
    agentId: value.runtime.agentId,
    sandboxed: value.runtime.sandboxed,
    sandboxRequired: value.runtime.sandboxRequired,
    isolationSubject: value.runtime.isolationSubject,
    effectiveAccess: value.runtime.workspaceAccess,
    backend: value.sandbox.backend,
    scope: value.sandbox.scope,
    workspaceAccess: value.sandbox.workspaceAccess,
    workspaceRoot: value.sandbox.workspaceRoot,
    librarySelections: value.librarySelections,
    worktreeId: value.worktreeId,
    inheritedWorktreeId: value.inheritedWorktreeId,
  });
  const prior =
    entry.priorWorkspace?.worktreeId === entry.worktree?.id ? entry.priorWorkspace : undefined;
  let historical = false;
  if (message && prior && entry.sessionId) {
    const { anchors } = await readSessionTranscriptAnchorsAsync(
      {
        agentId,
        sessionKey,
        sessionId: entry.sessionId,
        storePath: message.storePath,
      },
      { entryIds: [message.entryId] },
    );
    const anchor = anchors[0];
    // Rewrites re-append messages under new ids; a reloaded conversation links the current ids.
    if (!anchor) {
      throw sessionMutationForbiddenError(
        "This message is no longer in the conversation; reload the conversation to open its files.",
      );
    }
    // Transcript writers keep the boundary current; a stale one means it could not be kept.
    if (
      prior.sessionId === entry.sessionId &&
      prior.through.maxSeq !== null &&
      anchor.generation !== prior.through.generation
    ) {
      throw sessionMutationForbiddenError(
        "This message's file links are no longer available; open the file from this conversation's file list.",
      );
    }
    historical =
      prior.sessionId === entry.sessionId &&
      anchor.generation === prior.through.generation &&
      prior.through.maxSeq !== null &&
      anchor.rawSeq <= prior.through.maxSeq;
  }
  const sourceEntry = (current: Partial<InternalSessionEntry>) =>
    historical && prior
      ? {
          ...current,
          worktree: undefined,
          sessionRoot: prior.workspaceDir,
          spawnedCwd: undefined,
          spawnedWorkspaceDir: prior.workspaceDir,
        }
      : current;
  const selectedEntry = sourceEntry(entry);
  const selected = policy(cfg, selectedEntry);
  const expected = structuredClone(selection(selected));
  const expectedCurrent = historical ? structuredClone(selection(policy(cfg, entry))) : expected;
  let roots = selected.roots;
  let inherited: Awaited<ReturnType<typeof resolveLocalWorkspaceOwner>>;
  if (
    options.inheritWorkspace &&
    !historical &&
    selectedEntry.inheritedWorktreeId &&
    !selectedEntry.worktree?.id
  ) {
    if (!roots.root || selectedEntry.repositoryWorkspaceId || selectedEntry.execNode) {
      throw sessionMutationForbiddenError("The inherited workspace is no longer available.");
    }
    try {
      const { resolveLocalWorkspaceOwner } =
        await import("./worker-environments/local-workspace-projection.js");
      inherited = await resolveLocalWorkspaceOwner({
        cfg,
        agentId,
        sessionKey,
        workspaceDir: roots.root,
        inheritWorkspace: true,
      });
    } catch {
      inherited?.[Symbol.dispose]();
      throw sessionMutationForbiddenError("The inherited workspace is no longer available.");
    }
    if (!inherited) {
      throw sessionMutationForbiddenError("The inherited workspace is no longer available.");
    }
  }
  if (inherited) {
    const cwd = path.resolve(inherited.worktree.path, inherited.workspaceRelativePath);
    roots = {
      ...roots,
      root: cwd,
      spawnedCwd: cwd,
      diffCwd: cwd,
      readScope: "root",
    };
  }
  // Managed projects retain their established checkpoint/publication owner.
  // Explicit ro/rw already admits the selected agent workspace to the sandbox.
  if (
    roots.root &&
    !inherited &&
    !selectedEntry.worktree?.id &&
    !selectedEntry.repositoryWorkspaceId &&
    !selectedEntry.execNode &&
    selected.runtime.sandboxed &&
    (selected.runtime.sandboxRequired
      ? selected.runtime.workspaceAccess
      : selected.sandbox.workspaceAccess) === "none"
  ) {
    const local = selected.sandbox.backend === "docker" || selected.sandbox.backend === "podman";
    const sandbox = local
      ? await resolveSandboxSession({
          config: cfg,
          agentId,
          sessionKey,
          skillsSnapshot: entry.skillsSnapshot,
          preparedRuntimeStatus: selected.runtime,
        })
      : null;
    const root = sandbox
      ? resolveSandboxWorkspaceLayoutPaths({
          cfg: sandbox.cfg,
          rawSessionKey: sandbox.rawSessionKey,
          agentId: sandbox.runtime.agentId,
          isolationSubject: sandbox.runtime.isolationSubject,
          workspaceDir: roots.diffCwd,
        }).workspaceDir
      : undefined;
    // Private files are admitted, but their Git metadata is not a host checkout grant.
    roots = { ...roots, root, spawnedCwd: undefined, diffCwd: undefined, readScope: "root" };
  }
  if (historical && roots.root !== prior?.fileRoot) {
    throw sessionMutationForbiddenError(
      "The original file source is no longer admitted by this conversation's policy.",
    );
  }
  return {
    ...roots,
    historical,
    inheritedWorkspaceId: inherited?.worktree.id,
    sourceSessionKeys: inherited?.sourceSessionKeys ?? [],
    [Symbol.dispose]() {
      inherited?.[Symbol.dispose]();
    },
    async settle(assertCurrent: () => void) {
      const owner = inherited;
      if (!owner) {
        return;
      }
      const { withSettledLocalWorkspace } =
        await import("./worker-environments/local-workspace-projection.js");
      const assertOwnerCurrent = () => {
        assertCurrent();
        owner.assertCurrent();
      };
      await withSettledLocalWorkspace(
        {
          worktree: owner.worktree,
          env: owner.env,
          assertCurrent: assertOwnerCurrent,
          workerAuthority: { ...owner.workerAuthority, assertCurrent: assertOwnerCurrent },
        },
        async () => {},
      );
      assertOwnerCurrent();
    },
    unscopedHostRoot: Boolean(
      roots.root &&
      !selectedEntry.repositoryWorkspaceId &&
      !selectedEntry.execNode &&
      (!selected.runtime.sandboxed || Boolean(selectedEntry.worktree?.id) || Boolean(inherited)),
    ),
    assertCurrent(config: OpenClawConfig, current: Partial<InternalSessionEntry>) {
      try {
        inherited?.assertCurrent();
      } catch {
        throw sessionMutationForbiddenError("The inherited workspace changed during file access.");
      }
      if (
        !isDeepStrictEqual(expectedCurrent, selection(policy(config, current))) ||
        !isDeepStrictEqual(entry.priorWorkspace, current.priorWorkspace) ||
        (historical &&
          !isDeepStrictEqual(expected, selection(policy(config, sourceEntry(current)))))
      ) {
        throw sessionMutationForbiddenError("Session workspace changed during file access");
      }
    },
  };
}
