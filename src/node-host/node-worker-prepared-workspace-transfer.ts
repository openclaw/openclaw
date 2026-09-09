import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import {
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "../gateway/worker-environments/workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "../gateway/worker-environments/workspace-reconcile-apply.js";
import { changedPaths } from "../gateway/worker-environments/workspace-reconcile-core.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { runCommandBuffered } from "../process/exec.js";
import type {
  NodeWorkerPreparedWorkspaceRow,
  NodeWorkerPreparedWorkspaceStore,
} from "./node-worker-prepared-workspace-store.js";
import { captureManifest, TRANSFER_TIMEOUT_MS } from "./node-worker-workspace-commands.js";

export type NodeWorkerPreparedWorkspaceTransfer = {
  row: NodeWorkerPreparedWorkspaceRow;
  store: NodeWorkerPreparedWorkspaceStore;
};

/** Download only the eligible delta; absolute build paths and ignored output stay in place. */
export async function prepareNodeWorkerWorkspaceOverlay(params: {
  prepared: NodeWorkerPreparedWorkspaceTransfer;
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}) {
  const { row, store } = params.prepared;
  const readManifest = async (ref: string) =>
    parseWorkerWorkspaceManifest(
      await fsp.readFile(
        path.join(row.home_dir, ".openclaw-worker", "manifests", `${ref.slice(7)}.json`),
        "utf8",
      ),
      ref,
    );
  const source = await readManifest(row.source_manifest_ref);
  if (!source.baseCommit || params.manifest.baseCommit !== source.baseCommit) {
    throw new Error("Prepared workspace transfer does not match its immutable Git base");
  }
  const capture = async (referenceManifestRef: string, baseManifestRef?: string) =>
    await captureManifest({
      workspaceDir: row.workspace_dir,
      manifestHome: row.home_dir,
      baseCommit: source.baseCommit,
      referenceManifestRef,
      baseManifestRef,
      hashMemo: params.hashMemo,
      signal: params.signal,
    });
  const baseManifestRef = await capture(row.source_manifest_ref);
  const base = await readManifest(baseManifestRef);
  const sourceEntries = new Map(source.entries.map((entry) => [entry.path, entry]));
  return {
    changed: changedPaths(base, params.manifest),
    materializeSourceFile: async (
      entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>,
      destination: string,
    ) => {
      const original = sourceEntries.get(entry.path);
      if (
        original?.type !== "file" ||
        original.sha256 !== entry.sha256 ||
        original.size !== entry.size ||
        original.mode !== entry.mode
      ) {
        throw new Error("Prepared checkpoint source file differs from its immutable baseline");
      }
      // Checkpoints carry C-vs-B blobs only. If setup changed B into P and the
      // session restored B, recover those bytes locally without expanding its download token.
      const result = await runCommandBuffered(
        [
          "git",
          "--no-replace-objects",
          "-c",
          "protocol.allow=never",
          "cat-file",
          "blob",
          `${source.baseCommit}:${entry.path}`,
        ],
        {
          cwd: row.workspace_dir,
          baseEnv: {
            PATH: process.env.PATH,
            HOME: row.home_dir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: gitNullConfigPath(),
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          signal: params.signal,
          timeoutMs: TRANSFER_TIMEOUT_MS,
          killProcessTree: true,
          maxOutputBytes: { stdout: entry.size + 1, stderr: 16 * 1024 },
          maxCombinedOutputBytes: entry.size + 1 + 16 * 1024,
        },
      );
      if (
        result.termination !== "exit" ||
        result.code !== 0 ||
        result.stdout.length !== entry.size ||
        createHash("sha256").update(result.stdout).digest("hex") !== entry.sha256
      ) {
        throw new Error("Prepared checkpoint immutable Git content verification failed");
      }
      params.signal?.throwIfAborted();
      await fsp.writeFile(destination, result.stdout, { mode: entry.mode, flag: "wx" });
    },
    apply: async (stagingRoot: string): Promise<string> => {
      params.signal?.throwIfAborted();
      // The normal workspace fence holds throughout. After a crash this row is
      // cleanup-only: no in-memory permit survives to resurrect a partial tree.
      const mutation = store.beginMutation(row);
      let rolledBack = false;
      try {
        await withWorkerWorkspaceHashMemo(
          params.hashMemo ?? new Map(),
          async () =>
            await applyStagedWorkerWorkspace({
              root: row.workspace_dir,
              stagingRoot,
              baseManifestRef,
              currentManifestRef: params.manifestRef,
              base,
              current: params.manifest,
              journal: {
                load: () => undefined,
                begin: () => {},
                commit: () => {},
                abort: () => {
                  rolledBack = true;
                },
              },
              acceptance: {
                kind: "exact-target",
                verify: async () => {
                  if ((await capture(params.manifestRef, baseManifestRef)) !== params.manifestRef) {
                    throw new Error("Prepared workspace overlay verification failed");
                  }
                },
              },
            }),
        );
        params.signal?.throwIfAborted();
        mutation.complete();
        return params.manifestRef;
      } catch (error) {
        if (
          rolledBack &&
          !params.signal?.aborted &&
          (await capture(baseManifestRef)) === baseManifestRef
        ) {
          mutation.complete();
        }
        throw error;
      } finally {
        mutation.close();
      }
    },
  };
}
