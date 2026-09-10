import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WorkspaceHashMemo } from "../gateway/worker-environments/workspace-hash-memo.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type {
  NodeWorkerPreparedWorkspaceInput,
  NodeWorkerPreparedWorkspaceResult,
} from "../worker/node-workspace-prepared-protocol.js";
import type { NodeWorkerWorkspaceExecInput } from "../worker/node-workspace-protocol.js";
import {
  type NodeWorkerPreparedWorkspaceRow,
  NodeWorkerPreparedWorkspaceStore,
} from "./node-worker-prepared-workspace-store.js";
import { serializeNodeWorkerWorkspace } from "./node-worker-transfer-client.js";
import { captureManifest } from "./node-worker-workspace-commands.js";
import {
  assertNodePreparedWorkspacePaths,
  nodeWorkerWorkspaceLaunchGenerationKey,
  removeNodeWorkerWorkspaceEntry,
  resolveNodePreparedWorkspaceIdentity,
} from "./node-worker-workspace-identity.js";

/** Owns completed registration, one-session binding and durable retirement on one dedicated node. */
export class NodeWorkerPreparedWorkspaceRuntime {
  readonly store?: NodeWorkerPreparedWorkspaceStore;
  readonly root: string;
  constructor(
    home: string,
    options: OpenClawStateDatabaseOptions,
    private readonly hashMemos: Map<string, WorkspaceHashMemo>,
    enabled: boolean,
  ) {
    this.root = path.resolve(
      enabled ? fs.realpathSync.native(home) : home,
      ".openclaw-worker",
      "prepared",
    );
    if (enabled) {
      this.store = new NodeWorkerPreparedWorkspaceStore(options);
    }
  }

  resolveCommand(input: NodeWorkerWorkspaceExecInput, row: NodeWorkerPreparedWorkspaceRow) {
    if (row.gateway_namespace !== input.gatewayNamespace || !input.sessionKey) {
      throw new Error("INVALID_REQUEST: prepared workspace command requires its bound session");
    }
    return resolveNodePreparedWorkspaceIdentity(this.root, row, {
      workspaceDir: row.workspace_dir,
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      ownerEpoch: input.generation,
    });
  }

  async prepare(
    input: NodeWorkerPreparedWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerPreparedWorkspaceResult> {
    const { root, store, hashMemos } = this;
    if (!store) {
      throw new Error("INVALID_REQUEST: prepared workspaces require a dedicated ephemeral node");
    }
    // Compatible snapshots keep absolute build paths; exact preparation stays in the binding row.
    const ownerRoot = path.join(root, input.gatewayNamespace, input.cacheKey);
    return await serializeNodeWorkerWorkspace(ownerRoot, async () => {
      signal?.throwIfAborted();
      const verifyPrepared = async (
        workspace: {
          workspaceDir: string;
          homeDir: string;
          sourceManifestRef: string;
          preparedManifestRef: string;
        },
        hashMemo: WorkspaceHashMemo,
      ) => {
        const readManifest = async (ref: string) =>
          parseWorkerWorkspaceManifest(
            await fsp.readFile(
              path.join(workspace.homeDir, ".openclaw-worker", "manifests", `${ref.slice(7)}.json`),
              "utf8",
            ),
            ref,
          );
        const source = await readManifest(workspace.sourceManifestRef);
        const prepared = await readManifest(workspace.preparedManifestRef);
        if (
          !source.baseCommit ||
          source.baseCommit !== prepared.baseCommit ||
          (await captureManifest({
            workspaceDir: workspace.workspaceDir,
            manifestHome: workspace.homeDir,
            baseCommit: source.baseCommit,
            referenceManifestRef: workspace.preparedManifestRef,
            baseManifestRef: workspace.sourceManifestRef,
            hashMemo,
            signal,
          })) !== workspace.preparedManifestRef
        ) {
          throw new Error("INVALID_REQUEST: prepared workspace source does not match its manifest");
        }
      };
      let row: NodeWorkerPreparedWorkspaceRow;
      if (input.action === "register") {
        const hashMemo: WorkspaceHashMemo = new Map();
        assertNodePreparedWorkspacePaths(root, input);
        await verifyPrepared(input, hashMemo);
        signal?.throwIfAborted();
        assertNodePreparedWorkspacePaths(root, input);
        row = store.register(input);
        // Only successful registration publishes hashes; failed verification keeps
        // its candidate memo private and cannot replace an accepted registration.
        hashMemos.set(ownerRoot, hashMemo);
      } else {
        const existing = store.find(input.environmentId);
        if (!existing) {
          throw new Error("INVALID_REQUEST: prepared workspace registration is missing");
        }
        assertNodePreparedWorkspacePaths(root, {
          gatewayNamespace: existing.gateway_namespace,
          cacheKey: existing.cache_key,
          workspaceDir: existing.workspace_dir,
          homeDir: existing.home_dir,
        });
        if (existing.state === "available") {
          // Ready capacity must still match completed setup at its first claim.
          // Exact bind replay belongs to the session and must preserve its later edits.
          const hashMemo = hashMemos.get(ownerRoot) ?? new Map();
          await verifyPrepared(
            {
              workspaceDir: existing.workspace_dir,
              homeDir: existing.home_dir,
              sourceManifestRef: existing.source_manifest_ref,
              preparedManifestRef: existing.prepared_manifest_ref,
            },
            hashMemo,
          );
          signal?.throwIfAborted();
          hashMemos.set(ownerRoot, hashMemo);
        }
        row = store.bind(input);
        const hashMemo = hashMemos.get(ownerRoot);
        if (hashMemo) {
          // Move once, under the workspace fence. Bind replay must not overwrite
          // newer capture hashes already owned by this exact session generation.
          hashMemos.set(nodeWorkerWorkspaceLaunchGenerationKey(input), hashMemo);
          hashMemos.delete(ownerRoot);
        }
      }
      return {
        preparationKey: row.preparation_key,
        cacheKey: row.cache_key,
        environmentId: row.environment_id,
        gatewayNamespace: row.gateway_namespace,
        workspaceDir: row.workspace_dir,
        homeDir: row.home_dir,
        sourceManifestRef: row.source_manifest_ref,
        preparedManifestRef: row.prepared_manifest_ref,
      };
    });
  }

  async collect(
    gatewayNamespace: string,
    isProtected: (generationKey: string) => boolean,
    signal?: AbortSignal,
  ) {
    const generationKeys: string[] = [];
    let deleted = 0;
    const store = this.store;
    if (!store) {
      return { deleted, generationKeys };
    }
    for (const row of store.list(gatewayNamespace)) {
      if (row.state === "available" || row.state === "retired") {
        continue;
      }
      if (!row.session_id || !row.session_key || row.owner_epoch === null) {
        throw new Error("INVALID_REQUEST: prepared workspace has invalid retirement ownership");
      }
      const generationKey = nodeWorkerWorkspaceLaunchGenerationKey({
        gatewayNamespace: row.gateway_namespace,
        environmentId: row.environment_id,
        sessionId: row.session_id,
        ownerEpoch: row.owner_epoch,
      });
      if (isProtected(generationKey)) {
        continue;
      }
      const ownerRoot = path.join(this.root, row.gateway_namespace, row.cache_key);
      await serializeNodeWorkerWorkspace(ownerRoot, async () => {
        signal?.throwIfAborted();
        if (isProtected(generationKey)) {
          return;
        }
        // Retain passes serialize. Fence new claims before filesystem awaits;
        // a later retain cannot reopen this durable retirement tombstone.
        const retiring = store.retire(row);
        const removed = await removeNodeWorkerWorkspaceEntry(
          this.root,
          ownerRoot,
          "directory",
          () => {
            signal?.throwIfAborted();
            store.assertCurrent(retiring);
            return true;
          },
        );
        if (!removed) {
          try {
            await fsp.lstat(ownerRoot);
            throw new Error("INVALID_REQUEST: prepared workspace retirement path is not owned");
          } catch (error) {
            if (!hasNodeErrorCode(error, "ENOENT")) {
              throw error;
            }
          }
        }
        store.retire(retiring, true);
        generationKeys.push(generationKey);
        deleted += Number(removed);
      });
    }
    return { deleted, generationKeys };
  }
}
