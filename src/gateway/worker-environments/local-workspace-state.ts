import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { requireGit, runGit } from "../../agents/worktrees/git.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  assertLocalWorkspaceDirectory,
  initializeLocalWorkspaceProjection,
  localWorkspaceProjectionPath,
} from "./local-workspace-checkout.js";
import {
  pendingLocalWorkspaceDirection as pendingDirection,
  prepareLocalWorkspaceCheckpoint,
  selectLocalWorkspaceCheckpoint,
  stageLocalWorkspaceCheckpoint,
  type LocalWorkspaceSyncTarget as Direction,
} from "./local-workspace-checkpoint.js";
import {
  admitLocalWorkspaceSourcePaths,
  captureLocalWorkspaceArchiveBaseline,
  parseLocalWorkspaceSourcePaths,
  prepareLocalWorkspaceBuildInputs,
  selectLocalWorkspaceCanonicalPaths,
} from "./local-workspace-inventory.js";
import type {
  LocalWorkspaceManifestAction,
  LocalWorkspaceManifestCheckpoint,
} from "./local-workspace-manifest-scan.js";
import { assertLocalWorkspaceProjectionOwner } from "./local-workspace-owner-identity.js";
import type { LocalWorkspaceStore, LocalWorkspaceProjection } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  captureWorkspaceManifestDocument,
  workspaceManifestPaths,
} from "./workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
} from "./workspace-manifest.js";
import { buildCacheInputPaths } from "./workspace-path-exclusions.js";
import {
  applyStagedWorkerWorkspace,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
  withStagedWorkerWorkspaceResult,
  deleteStagedWorkerWorkspaceResult,
  readStagedWorkerWorkspaceResult,
} from "./workspace-result-staging.js";

const log = createSubsystemLogger("agents/worktrees");

export function projectionOperations(
  owner: LocalWorkspaceOwner,
  store: LocalWorkspaceStore,
  initialRow: LocalWorkspaceProjection | undefined,
) {
  const signal = store.signal;
  const projectionPath = localWorkspaceProjectionPath(owner);
  let row = initialRow;
  const selectCurrent = (assertCurrent: (() => void) | undefined) => {
    if (!row) {
      throw new Error("Local workspace binding is missing");
    }
    assertCurrent?.();
    assertLocalWorkspaceProjectionOwner(row, owner);
    if (row.projection_path !== projectionPath || store.get()?.revision !== row.revision) {
      throw new Error("Local workspace binding changed");
    }
    return row;
  };
  const current = () => selectCurrent(owner.assertCurrent);
  // Subprocess input admission requires an undefined result.
  const assertCurrent = () => void current();
  const workerAuthority: WorktreeWorkerAuthority = {
    ...store.workerAuthority,
    predicates: owner.workerAuthority?.predicates ?? store.workerAuthority.predicates,
    assertCurrent: () => {
      selectCurrent(
        owner.workerAuthority ? owner.workerAuthority.assertCurrent : owner.assertCurrent,
      );
    },
  };
  const update = async (
    patch: Parameters<typeof store.update>[1],
    manifest?: Parameters<typeof store.update>[3],
  ) => {
    row = await store.update(current(), patch, owner.workerAuthority, manifest);
  };
  const repairBaseline = async () => {
    const repair = await store.manifest(current(), {
      kind: "repair",
      canonicalRoot: owner.worktree.path,
    });
    if (repair.kind !== "replace") {
      throw new Error("Local workspace baseline repair is missing");
    }
    row = await store.accept(repair.update, owner.workerAuthority);
  };
  const readManifest = async (action: LocalWorkspaceManifestAction) => {
    try {
      return await store.manifest(current(), action);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("Local workspace baseline nodes are missing")
      ) {
        throw error;
      }
      // Repair older missing packs only from a verified baseline or checkpoint;
      // divergent files must never replace the merge base.
      await repairBaseline();
      return await store.manifest(current(), action);
    }
  };
  const baselineDocument = async () => {
    const document = await readManifest({ kind: "materialize" });
    current();
    if (document.kind !== "materialize") {
      throw new Error("Local workspace baseline materialization is missing");
    }
    return document;
  };
  // Full documents cross this boundary only for initial creation and old receipts,
  // or when an archive/publication explicitly needs the complete inventory.
  const replaceBaseline = async (
    raw: string,
    ref: string,
    patch: Parameters<typeof store.update>[1] = {},
  ) => {
    await update(patch, {
      rawManifest: raw,
      manifestRef: ref,
      buildCacheInputs: await buildCacheInputs(),
    });
  };
  const sourcePath = (target: Direction) =>
    target === "canonical" ? current().projection_path : owner.worktree.path;
  const targetPath = (target: Direction) =>
    target === "canonical" ? owner.worktree.path : current().projection_path;
  let inputPaths: Promise<string[]> | undefined;
  let preparedInputPaths: Set<string> | undefined;
  const buildCacheInputs = () =>
    (inputPaths ??= prepareLocalWorkspaceBuildInputs({
      worktree: owner.worktree,
      projection: current(),
      signal,
      assertCurrent,
      retainSourcePaths: (sourcePaths) => update({ source_paths_json: sourcePaths }),
    }).then((inventory) => {
      preparedInputPaths = inventory.paths;
      return inventory.retained;
    }));
  const canonicalPaths = async () => {
    const retained = await buildCacheInputs();
    const selected = current();
    const document = selected.baseline_ref ? await baselineDocument() : undefined;
    return await selectLocalWorkspaceCanonicalPaths({
      root: owner.worktree.path,
      admittedPaths: selected.source_paths_json,
      preparedPaths: preparedInputPaths,
      signal,
      assertCurrent,
      baselinePaths: document
        ? await workspaceManifestPaths(document, retained, signal)
        : undefined,
    });
  };
  const capture = async (target: Direction, preserveDirectories?: ReadonlySet<string>) => {
    const selected = current();
    const root = sourcePath(target);
    await assertLocalWorkspaceDirectory(root);
    current();
    // Never inspect guest Git metadata on the host. Canonical inventory uses only
    // the trusted managed worktree; ignored host files cannot enter the projection.
    const includePaths = target === "projection" ? await canonicalPaths() : undefined;
    const snapshot = await captureWorkspaceManifestDocument({
      root,
      baseCommit: selected.base_commit,
      includePaths,
      buildCacheInputs: new Set(await buildCacheInputs()),
      preserveDirectories,
      signal,
    });
    current();
    return snapshot;
  };
  const scan = async (target: Direction): Promise<LocalWorkspaceManifestCheckpoint> => {
    if (owner.worktree.snapshotRef) {
      await buildCacheInputs();
    }
    await assertLocalWorkspaceDirectory(sourcePath(target));
    const snapshot = await readManifest({
      kind: "scan",
      target,
      canonicalRoot: owner.worktree.path,
    });
    current();
    if (snapshot.kind !== "scan") {
      throw new Error("Local workspace checkpoint scan is missing");
    }
    const { observation, ...checkpoint } = snapshot;
    if (observation) {
      // Admit host paths and unchanged-file identities without materializing the tree here.
      row = await store.accept(observation, owner.workerAuthority);
    }
    inputPaths = Promise.resolve(snapshot.buildCacheInputs);
    preparedInputPaths = undefined;
    return checkpoint;
  };
  const recover = async () => {
    const selected = current();
    if (!selected.journal_json) {
      return;
    }
    if (!selected.journal_pack || !pendingDirection(selected.pending_target)) {
      throw new Error("Local workspace recovery metadata is incomplete");
    }
    // A base refresh keeps its receipt and paused runtime until both sides accept it, so an
    // interrupted application resumes from the files it already wrote. Restoring them would
    // discard that progress, and a refresh longer than one turn's deadline could never finish.
    if (!isLocalWorkspaceBaseRefreshRef(selected.pending_ref)) {
      const plan = parseWorkerWorkspaceReconciliationPlan(selected.journal_json);
      await recoverWorkerWorkspaceReconciliation({
        root: targetPath(pendingDirection(selected.pending_target)!),
        journal: { ...plan, basePack: selected.journal_pack },
        buildCacheInputs: await buildCacheInputs(),
        assertCurrent,
      });
    }
    await update({ journal_json: null, journal_pack: null });
  };
  const cleanupAccepted = async () => {
    const selected = current();
    if (!selected.pending_ref || selected.pending_target) {
      return;
    }
    await deleteStagedWorkerWorkspaceResult({
      root: owner.worktree.repoRoot,
      stagedResultRef: selected.pending_ref,
      assertCurrent,
    });
    await update({
      pending_ref: null,
      checkpoint_json: null,
      ...(selected.tree_root_digest ? { baseline_json: null } : {}),
    });
  };
  const settle = async (
    retainAccepted = false,
    preparedSnapshot?: LocalWorkspaceManifestCheckpoint,
  ) => {
    await recover();
    const conversionSource = current();
    if (conversionSource.baseline_ref && !conversionSource.tree_root_digest) {
      const prepared = await readManifest({ kind: "convert" });
      if (prepared.kind === "rescan") {
        log.warn(
          "Local workspace baseline conversion changed its reference; preserved source data and requesting full-scan baseline repair",
        );
        // The existing full-scan repair accepts only the exact saved baseline;
        // source data stays intact until that replacement is accepted.
        await repairBaseline();
      } else if (prepared.kind === "replace") {
        row = await store.accept(prepared.update, owner.workerAuthority);
      } else {
        throw new Error("Local workspace conversion preparation is missing");
      }
    }
    if (!retainAccepted) {
      await cleanupAccepted();
    }
    const selected = current();
    if (!selected.pending_ref) {
      return;
    }
    const { target, refresh } = selectLocalWorkspaceCheckpoint(selected, selected.pending_ref);
    // Reservation precedes staging. A crash before its Git effect leaves the
    // source bytes untouched and resumes capture into this exact reserved ref.
    if (
      !(await hasWorkerWorkspaceResultRef({
        root: owner.worktree.path,
        stagedResultRef: selected.pending_ref,
      }))
    ) {
      if (refresh) {
        throw new Error(
          "Workspace integration source is unavailable; retry github_publish prepare_pr for an imported PR, or refresh_base for the selected project. Saved work was preserved.",
        );
      }
      let snapshot = preparedSnapshot;
      if (!snapshot && selected.checkpoint_json) {
        // No Git receipt owns these bytes yet. After interruption, recapture the
        // still-owned source into the same reservation before staging its delta.
        snapshot = await scan(target);
        await update({ checkpoint_json: JSON.stringify(snapshot) });
      }
      const baseline = snapshot ? undefined : await baselineDocument();
      const baselineManifest =
        baseline &&
        parseWorkerWorkspaceManifest(
          baseline.rawManifest,
          baseline.manifestRef,
          await buildCacheInputs(),
        );
      const legacy =
        baselineManifest && (await capture(target, new Set(baselineManifest.directories)));
      // Eviction can retain an archive reservation after staging fails. The
      // restored Git snapshot omits the accepted overlay, unlike the saved baseline.
      const stagingBase =
        baselineManifest && owner.worktree.removedAt !== undefined && owner.worktree.snapshotRef
          ? await captureLocalWorkspaceArchiveBaseline({
              root: owner.worktree.repoRoot,
              snapshotCommit: await requireGit(
                owner.worktree.repoRoot,
                ["rev-parse", `${owner.worktree.snapshotRef}^{commit}`],
                { signal, beforeRun: assertCurrent },
              ),
              manifest: baselineManifest,
              signal,
              assertCurrent,
            })
          : baseline;
      await stageLocalWorkspaceCheckpoint(
        {
          root: owner.worktree.path,
          stagingRoot: sourcePath(target),
          stagedResultRef: selected.pending_ref,
          baseManifestRef: snapshot?.baseManifestRef ?? stagingBase!.manifestRef,
          currentManifestRef: snapshot?.currentManifestRef ?? legacy!.manifestRef,
          baseManifestRaw: snapshot?.baseManifestRaw ?? stagingBase!.rawManifest,
          currentManifestRaw: snapshot?.currentManifestRaw ?? legacy!.rawManifest,
          buildCacheInputs: snapshot?.buildCacheInputs ?? (await buildCacheInputs()),
          assertCurrent,
        },
        { target, refresh, snapshot, current, signal },
      );
      current();
    }
    const checkpoint = current().checkpoint_json
      ? (JSON.parse(current().checkpoint_json!) as LocalWorkspaceManifestCheckpoint) // SAFETY: Owner-written checkpoint.
      : undefined;
    if (checkpoint && checkpoint.previousRoot !== selected.baseline_ref) {
      throw new Error("Local workspace checkpoint no longer matches its baseline");
    }
    const refreshBaseline = refresh ? await baselineDocument() : undefined;
    let conflictPaths: string[] | undefined;
    await withStagedWorkerWorkspaceResult(
      {
        root: owner.worktree.path,
        stagedResultRef: selected.pending_ref,
        buildCacheInputs: checkpoint?.buildCacheInputs ?? (await buildCacheInputs()),
      },
      async (snapshot) => {
        current();
        if (
          refresh &&
          (!snapshot.current.baseCommit ||
            snapshot.baseManifestRef !== refreshBaseline!.manifestRef)
        ) {
          throw new Error("Local workspace result no longer matches its accepted baseline");
        }
        if (
          checkpoint &&
          (snapshot.baseManifestRef !== checkpoint.baseManifestRef ||
            snapshot.currentManifestRef !== checkpoint.currentManifestRef)
        ) {
          throw new Error("Local workspace checkpoint payload changed");
        }
        await applyStagedWorkerWorkspace({
          root: targetPath(target),
          stagingRoot: snapshot.stagingRoot,
          baseManifestRef: snapshot.baseManifestRef,
          currentManifestRef: snapshot.currentManifestRef,
          base: snapshot.base,
          current: snapshot.current,
          assertCurrent,
          journal: {
            load: async () => undefined,
            begin: async (journal) => {
              await update({
                journal_json: serializeWorkerWorkspaceReconciliationPlan(journal),
                journal_pack: journal.basePack,
              });
            },
            abort: async () => {
              await update({ journal_json: null, journal_pack: null });
            },
            commit: async () => {
              if (!conflictPaths) {
                throw new Error("Local workspace acceptance is missing");
              }
              // A conflicting result remains a durable pending receipt. No guest
              // bytes are discarded or silently replaced by the canonical side.
              try {
                if (conflictPaths.length) {
                  await update({ journal_json: null, journal_pack: null });
                } else if (refresh && target === "canonical") {
                  await update({
                    pending_target: "projection",
                    journal_json: null,
                    journal_pack: null,
                  });
                } else {
                  const patch = {
                    ...(refresh ? { base_commit: snapshot.current.baseCommit! } : {}),
                    pending_target: null,
                    journal_json: null,
                    journal_pack: null,
                  };
                  if (checkpoint) {
                    await update(patch, checkpoint);
                  } else {
                    await replaceBaseline(
                      snapshot.currentManifestRaw,
                      snapshot.currentManifestRef,
                      patch,
                    );
                  }
                }
              } catch (error) {
                throw new AcceptedWorkspacePublicationIndeterminateError("commit", error);
              }
            },
          },
          acceptance: {
            kind: "reconcile",
            publish: async (value) => {
              current();
              conflictPaths = value.conflictPaths;
            },
          },
        });
      },
    );
    if (refresh && target === "canonical" && current().pending_target === "projection") {
      await settle(retainAccepted);
      return;
    }
    if (current().pending_target) {
      throw new Error(
        "Local sandbox edits conflict with the managed workspace; pending changes were preserved. Resolve the workspace conflicts before retrying.",
      );
    }
    if (!retainAccepted) {
      await cleanupAccepted();
    }
  };
  const synchronize = async (target: Direction) => {
    await settle();
    const snapshot = await scan(target);
    if (snapshot.resultingRoot !== snapshot.previousRoot) {
      await update({
        pending_ref: workerWorkspaceResultRef(randomUUID()),
        pending_target: target,
        checkpoint_json: JSON.stringify(snapshot),
      });
      await settle(false, snapshot);
    }
  };
  const prepare = async (dependencies?: {
    sandbox: SandboxConfig;
    allocation: WorktreeAllocationGuard;
  }) => {
    if (!row) {
      const baseCommit = await requireGit(
        owner.worktree.path,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { signal, beforeRun: owner.assertCurrent },
      );
      const sourcePaths = await admitLocalWorkspaceSourcePaths({
        root: owner.worktree.path,
        signal,
        assertCurrent: owner.assertCurrent,
      });
      owner.assertCurrent();
      row = await store.create(
        {
          worktree_id: owner.worktree.id,
          agent_id: owner.agentId,
          session_key: owner.sessionKey,
          session_id: owner.sessionId,
          lifecycle_revision: owner.lifecycleRevision,
          projection_path: projectionPath,
          base_commit: baseCommit,
          source_paths_json: sourcePaths,
          baseline_json: null,
          baseline_ref: null,
          tree_root_digest: null,
          source_paths_digest: null,
          canonical_fingerprints: null,
          projection_fingerprints: null,
          checkpoint_json: null,
          pending_ref: null,
          pending_target: null,
          journal_json: null,
          journal_pack: null,
          paused_runtimes_json: null,
          created_at_ms: Date.now(),
        },
        owner.workerAuthority,
      );
    }
    const selected = current();
    if (!selected.baseline_ref) {
      const initial = await initializeLocalWorkspaceProjection({
        owner,
        projectionPath: selected.projection_path,
        baseCommit: selected.base_commit,
        signal,
        assertCurrent,
        buildCacheInputs,
        dependencies,
      });
      await replaceBaseline(initial.rawManifest, initial.manifestRef);
    }
    return await prepareLocalWorkspaceCheckpoint({
      baselineRef: selected.baseline_ref,
      synchronize,
      current,
      signal,
    });
  };
  return {
    current,
    workerAuthority,
    canonicalPaths,
    buildCacheInputs,
    baselineDocument,
    prepare,
    reuse: async () => (row?.baseline_ref ? await prepare() : undefined),
    synchronize,
    settle,
    recover,
    applyBaseRefresh: async (stagedResultRef: string) => {
      if (!isLocalWorkspaceBaseRefreshRef(stagedResultRef)) {
        throw new Error("Workspace base refresh requires its own source result");
      }
      await settle();
      // The host snapshot admits selected source and retained cache inputs, including unchanged files.
      const snapshot = await readStagedWorkerWorkspaceResult(owner.worktree.path, stagedResultRef);
      const incoming = buildCacheInputPaths(snapshot.current.entries.map((entry) => entry.path));
      const selected = current();
      const admitted = parseLocalWorkspaceSourcePaths(selected.source_paths_json);
      const sourcePaths = JSON.stringify([...new Set([...admitted, ...incoming])]);
      // Admission and its pending fence settle together, including after a restart.
      await update({
        pending_ref: stagedResultRef,
        pending_target: "canonical",
        ...(sourcePaths === selected.source_paths_json ? {} : { source_paths_json: sourcePaths }),
      });
      inputPaths = undefined;
      preparedInputPaths = undefined;
      await settle();
    },
    restoreSnapshot: async () => {
      await buildCacheInputs();
      await recover();
      const selected = current();
      if (!selected.pending_ref) {
        return;
      }
      if (!selected.pending_target) {
        // A failed restore may have applied the overlay before its checkout was
        // rolled back. Retain and replay the same accepted receipt on retry.
        const receipt = await readStagedWorkerWorkspaceResult(
          owner.worktree.repoRoot,
          selected.pending_ref,
          await buildCacheInputs(),
        );
        current();
        const baseline = await baselineDocument();
        if (receipt.currentManifestRef !== baseline.manifestRef) {
          throw new Error("Archive restore receipt changed");
        }
        await replaceBaseline(receipt.baseManifestRaw, receipt.baseManifestRef, {
          pending_target: "canonical",
          checkpoint_json: null,
        });
      }
      await settle(true);
    },
    finishRestore: cleanupAccepted,
    prepareArchive: async (snapshotCommit: string) => {
      await settle();
      const merge = await runGit(
        owner.worktree.path,
        ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
        { signal, beforeRun: assertCurrent },
      );
      if (merge.code !== 1) {
        throw new Error(
          "Workspace integration is pending; finish the original github_publish prepare_pr or refresh_base action before archiving this worktree. Saved files and merge state were preserved.",
        );
      }
      const baseline = await baselineDocument();
      const manifest = parseWorkerWorkspaceManifest(
        baseline.rawManifest,
        baseline.manifestRef,
        await buildCacheInputs(),
      );
      const accepted = await capture("canonical", new Set(manifest.directories));
      if (accepted.manifestRef !== baseline.manifestRef) {
        throw new Error("Local workspace changed before archive capture");
      }
      const projection = current().projection_path;
      const archiveBase = await captureLocalWorkspaceArchiveBaseline({
        root: owner.worktree.repoRoot,
        snapshotCommit,
        manifest,
        signal,
        assertCurrent,
      });
      if (archiveBase.manifestRef === accepted.manifestRef) {
        return;
      }
      const resultRef = workerWorkspaceResultRef(randomUUID());
      // Keep accepted directory membership until the receipt owns it. Recovery
      // must not mistake derived children for deletion after interrupted staging.
      await update({
        pending_ref: resultRef,
        pending_target: "canonical",
        checkpoint_json: null,
      });
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: owner.worktree.repoRoot,
        stagingRoot: projection,
        stagedResultRef: resultRef,
        baseManifestRaw: archiveBase.rawManifest,
        baseManifestRef: archiveBase.manifestRef,
        currentManifestRaw: accepted.rawManifest,
        currentManifestRef: accepted.manifestRef,
        buildCacheInputs: await buildCacheInputs(),
        assertCurrent,
      });
      current();
    },
    expire: async (retireSnapshot?: (assertCurrent: () => void) => Promise<void>) => {
      const selected = current();
      if (
        selected.journal_json ||
        (selected.pending_target && selected.pending_target !== "canonical")
      ) {
        throw new Error("Local sandbox has pending edits; restore its worktree before cleanup");
      }
      const baseline = selected.baseline_ref ? await baselineDocument() : undefined;
      let accepted = baseline
        ? { raw: baseline.rawManifest, ref: baseline.manifestRef }
        : undefined;
      if (selected.pending_ref) {
        if (!retireSnapshot || owner.worktree.removedAt === undefined) {
          throw new Error("Archive receipt still owns its restore data");
        }
        if (selected.pending_target) {
          const receipt = await readStagedWorkerWorkspaceResult(
            owner.worktree.repoRoot,
            selected.pending_ref,
            await buildCacheInputs(),
          );
          current();
          if (
            receipt.baseManifestRef !== baseline?.manifestRef &&
            receipt.currentManifestRef !== baseline?.manifestRef
          ) {
            throw new Error("Archive retention receipt changed");
          }
          accepted = {
            raw: receipt.currentManifestRaw,
            ref: receipt.currentManifestRef,
          };
        }
      }
      if (accepted) {
        // Authenticate the retained bytes, then compare eligible content under
        // today's exclusions without changing the immutable receipt identity.
        const acceptedManifest = parseWorkerWorkspaceManifest(
          accepted.raw,
          accepted.ref,
          await buildCacheInputs(),
        );
        const actual = await capture("canonical", new Set(acceptedManifest.directories));
        if (actual.rawManifest !== serializeWorkerWorkspaceManifest(acceptedManifest)) {
          throw new Error(
            "Local sandbox has unaccepted edits; restore its worktree before cleanup",
          );
        }
      }
      const { readLocalWorkspaceRuntimes } =
        await import("../../agents/sandbox/local-workspace-quiescence.js");
      if ((await readLocalWorkspaceRuntimes(selected.projection_path, { env: owner.env })).length) {
        throw new Error("Local sandbox runtime still owns its workspace; cleanup deferred");
      }
      const parent = path.dirname(selected.projection_path);
      await assertLocalWorkspaceDirectory(parent);
      current();
      // Once expiry starts, an older restore must not find a usable Git snapshot
      // after its accepted overlay has been retired.
      await retireSnapshot?.(assertCurrent);
      current();
      if (selected.pending_ref && accepted) {
        await replaceBaseline(accepted.raw, accepted.ref, {
          pending_target: null,
          checkpoint_json: null,
        });
        await cleanupAccepted();
      }
      current();
      await fs.rm(parent, { recursive: true, force: true });
      await store.delete(current(), owner.workerAuthority);
    },
    rememberPaused: (value: string | null) => update({ paused_runtimes_json: value }),
  };
}
