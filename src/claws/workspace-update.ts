import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { clawWorkspaceActionsById } from "./application-provenance.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";
import { collectClawRollbackFailures } from "./update-rollback.js";
import {
  deleteClawWorkspaceFileForUpdate,
  readClawWorkspaceFilesForUpdate,
  upsertClawWorkspaceFileForUpdate,
  type ClawUpdateStateOptions,
} from "./update-state-write.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  readClawWorkspaceActionSource,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

const MAX_UPDATE_FILE_BYTES = 1024 * 1024;

export type ClawWorkspaceUpdateExecution = {
  appliedPaths: string[];
  rollback: () => Promise<void>;
};

export class ClawWorkspaceUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawWorkspaceUpdateError";
  }
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function applyClawWorkspaceUpdate(
  updatePlan: ClawUpdatePlan,
  targetAddPlan: ClawAddPlan,
  options: ClawUpdateStateOptions & { nowMs?: number } = {},
): Promise<ClawWorkspaceUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "workspaceFile" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedPaths: [], rollback: async () => undefined };
  }
  const workspaceRoot = resolve(targetAddPlan.agent.workspace);
  const packageRoot = resolve(targetAddPlan.claw.packageRoot);
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_UPDATE_FILE_BYTES,
    symlinks: "reject",
  });
  const currentRefs = new Map(
    (await readClawWorkspaceFilesForUpdate(updatePlan.agentId, options)).map((record) => [
      record.path,
      record,
    ]),
  );
  const targetActions = clawWorkspaceActionsById(targetAddPlan.actions);
  const undo: Array<() => Promise<void>> = [];
  const appliedPaths: string[] = [];
  const assertForwardCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  const forwardOptions = { ...options, assertCurrent: assertForwardCurrent };

  const rollback = async () => {
    const failures = await collectClawRollbackFailures(undo.toReversed());
    if (failures.length > 0) {
      throw new ClawWorkspaceUpdateError(failures.join("; "), true);
    }
  };

  try {
    for (const action of actions) {
      const path = action.id;
      const previousRef = currentRefs.get(path);
      const existed = await workspace.exists(path);
      const previousContent = existed
        ? await workspace.readBytes(path, { maxBytes: MAX_UPDATE_FILE_BYTES })
        : undefined;
      if (action.currentPresent === true && !existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} disappeared after planning.`,
        );
      }
      if (action.currentPresent === false && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} appeared after planning.`,
        );
      }
      if (
        previousContent &&
        action.currentDigest &&
        digest(previousContent) !== action.currentDigest
      ) {
        throw new ClawWorkspaceUpdateError(
          `Workspace file ${JSON.stringify(path)} changed after planning.`,
        );
      }
      if (action.action === "add" && existed) {
        throw new ClawWorkspaceUpdateError(
          `Workspace destination ${JSON.stringify(path)} appeared after planning.`,
        );
      }

      if (action.action === "remove") {
        assertForwardCurrent();
        undo.push(async () => {
          const currentContent = (await workspace.exists(path))
            ? await workspace.readBytes(path, { maxBytes: MAX_UPDATE_FILE_BYTES })
            : undefined;
          if (
            currentContent &&
            (!previousContent || digest(currentContent) !== digest(previousContent))
          ) {
            throw new Error(`Workspace file ${JSON.stringify(path)} changed before rollback.`);
          }
          if (!currentContent && previousContent) {
            await workspace.write(path, previousContent, {
              mkdir: true,
              overwrite: true,
              assertBeforeMutation: options.assertCurrent,
            });
          }
          if (previousRef) {
            await upsertClawWorkspaceFileForUpdate(previousRef, options);
          }
        });
        if (existed) {
          await workspace.remove(path, { assertBeforeMutation: assertForwardCurrent });
        }
        await deleteClawWorkspaceFileForUpdate(updatePlan.agentId, path, forwardOptions);
        appliedPaths.push(path);
        continue;
      }

      const target = targetActions.get(path);
      if (!target?.source || !target.digest) {
        throw new ClawWorkspaceUpdateError(
          `Target workspace action ${JSON.stringify(path)} lacks source provenance.`,
        );
      }
      const resolvedSource = await readClawWorkspaceActionSource({
        action: target,
        packageRoot,
        sourceRoot: source,
      });
      const content = resolvedSource.content;
      if (digest(content) !== target.digest || target.digest !== action.desiredDigest) {
        throw new ClawWorkspaceUpdateError(
          `Workspace source for ${JSON.stringify(path)} changed after planning.`,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const record: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        workspace: workspace.rootReal,
        path,
        sourcePath: resolvedSource.sourceRelative.replaceAll(sep, "/"),
        contentDigest: target.digest,
        status: "complete",
        createdAtMs: previousRef?.createdAtMs ?? nowMs,
        updatedAtMs: nowMs,
      };
      assertForwardCurrent();
      undo.push(async () => {
        const currentContent = (await workspace.exists(path))
          ? await workspace.readBytes(path, { maxBytes: MAX_UPDATE_FILE_BYTES })
          : undefined;
        const unchanged = previousContent
          ? currentContent && digest(currentContent) === digest(previousContent)
          : !currentContent;
        if (!unchanged && (!currentContent || digest(currentContent) !== target.digest)) {
          throw new Error(`Workspace file ${JSON.stringify(path)} changed before rollback.`);
        }
        if (!unchanged && previousContent) {
          await workspace.write(path, previousContent, {
            mkdir: true,
            overwrite: true,
            assertBeforeMutation: options.assertCurrent,
          });
        } else if (!unchanged && currentContent) {
          await workspace.remove(path, { assertBeforeMutation: options.assertCurrent });
        }
        if (previousRef) {
          await upsertClawWorkspaceFileForUpdate(previousRef, options);
        } else {
          await deleteClawWorkspaceFileForUpdate(updatePlan.agentId, path, options);
        }
      });
      await workspace.write(path, content, {
        mkdir: true,
        overwrite: existed,
        assertBeforeMutation: assertForwardCurrent,
      });
      await upsertClawWorkspaceFileForUpdate(record, forwardOptions);
      appliedPaths.push(path);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawWorkspaceUpdateError(
        `${coerceErrorMessage(error)}; rollback failed: ${coerceErrorMessage(rollbackError)}`,
        true,
      );
    }
    throw error;
  }
  return { appliedPaths, rollback };
}
