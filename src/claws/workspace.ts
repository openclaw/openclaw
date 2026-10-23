// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import type { ClawAddStateOptions } from "./add-state-write.js";
import { digestClawBytes } from "./digest.js";
import { clawContainedRelativePath } from "./path-containment.js";
import { parseClawMarkdown } from "./reader.js";
import type { ClawAddPlan, ClawAddPlanAction } from "./types.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  type PersistedClawWorkspaceFile,
} from "./workspace-state.js";

export type { PersistedClawWorkspaceFile } from "./workspace-state.js";

const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

class ClawWorkspaceWriteError extends Error {
  constructor() {
    super("Claw workspace file creation failed");
    this.name = "ClawWorkspaceWriteError";
  }
}

export async function readClawWorkspaceActionSource(params: {
  action: ClawAddPlanAction;
  packageRoot: string;
  sourceRoot: Root;
}): Promise<{ content: Buffer; sourceRelative: string }> {
  if (!params.action.source) {
    throw new ClawWorkspaceWriteError();
  }
  const sourcePath = resolve(params.action.source);
  const sourceRelative = clawContainedRelativePath(params.packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new ClawWorkspaceWriteError();
  }
  const read = await params.sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath) {
    throw new ClawWorkspaceWriteError();
  }
  if (params.action.sourceKind !== "clawMarkdownBody") {
    return { content: read.buffer, sourceRelative };
  }
  const parsed = parseClawMarkdown(read.buffer, sourcePath);
  if (!parsed.ok) {
    throw new ClawWorkspaceWriteError();
  }
  return { content: parsed.body, sourceRelative };
}

export async function createClawWorkspaceFiles(
  plan: ClawAddPlan,
  options: ClawAddStateOptions & {
    nowMs?: number;
    assertForwardCurrent?: () => void;
  } = {},
): Promise<PersistedClawWorkspaceFile[]> {
  const actions = plan.actions.filter((action) => action.kind === "workspaceFile");
  if (actions.length === 0) {
    return [];
  }

  const workspaceRoot = await realpath(resolve(plan.agent.workspace));
  const packageRoot = await realpath(resolve(plan.claw.packageRoot));
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const createdFiles: PersistedClawWorkspaceFile[] = [];
  const nowMs = options.nowMs ?? Date.now();
  const assertForwardCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };

  for (const action of actions) {
    try {
      assertForwardCurrent();
      if (!action.source || !action.digest) {
        throw new ClawWorkspaceWriteError();
      }
      const targetPath = resolve(action.target);
      const targetRelative = clawContainedRelativePath(workspaceRoot, targetPath);
      if (!targetRelative) {
        throw new ClawWorkspaceWriteError();
      }
      const resolvedSource = await readClawWorkspaceActionSource({
        action,
        packageRoot,
        sourceRoot: source,
      });
      const digest = digestClawBytes(resolvedSource.content);
      if (digest !== action.digest) {
        throw new ClawWorkspaceWriteError();
      }
      assertForwardCurrent();
      const expectedRecord: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        workspace: workspace.rootReal,
        path: targetRelative.replaceAll(sep, "/"),
        sourcePath: resolvedSource.sourceRelative.replaceAll(sep, "/"),
        contentDigest: digest,
        status: "pending",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (await workspace.exists(targetRelative)) {
        throw new ClawWorkspaceWriteError();
      }
      await workspace.write(targetRelative, resolvedSource.content, {
        mkdir: true,
        overwrite: false,
        assertBeforeMutation: assertForwardCurrent,
      });
      createdFiles.push({ ...expectedRecord, status: "complete" });
    } catch {
      throw new ClawWorkspaceWriteError();
    }
  }
  return createdFiles;
}
