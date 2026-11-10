// Creates Template-owned bootstrap and supporting files inside the new agent workspace.
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import type { TemplateAddStateOptions } from "./add-state-write.js";
import { digestTemplateBytes } from "./digest.js";
import { templateContainedRelativePath } from "./path-containment.js";
import { parseTemplateMarkdown } from "./reader.js";
import type { TemplateAddPlan, TemplateAddPlanAction } from "./types.js";
import {
  TEMPLATE_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  type PersistedTemplateWorkspaceFile,
} from "./workspace-state.js";

export type { PersistedTemplateWorkspaceFile } from "./workspace-state.js";

const MAX_TEMPLATE_WORKSPACE_FILE_BYTES = 1024 * 1024;

class TemplateWorkspaceWriteError extends Error {
  constructor(message = "Template workspace file creation failed") {
    super(message);
    this.name = "TemplateWorkspaceWriteError";
  }
}

export async function readTemplateWorkspaceActionSource(params: {
  action: TemplateAddPlanAction;
  packageRoot: string;
  sourceRoot: Root;
}): Promise<{ content: Buffer; sourceRelative: string }> {
  if (!params.action.source) {
    throw new TemplateWorkspaceWriteError();
  }
  const sourcePath = resolve(params.action.source);
  const sourceRelative = templateContainedRelativePath(params.packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new TemplateWorkspaceWriteError();
  }
  const read = await params.sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_TEMPLATE_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath) {
    throw new TemplateWorkspaceWriteError();
  }
  if (params.action.sourceKind !== "templateMarkdownBody") {
    return { content: read.buffer, sourceRelative };
  }
  const parsed = parseTemplateMarkdown(read.buffer, sourcePath);
  if (!parsed.ok) {
    throw new TemplateWorkspaceWriteError();
  }
  return { content: parsed.body, sourceRelative };
}

export async function createTemplateWorkspaceFiles(
  plan: TemplateAddPlan,
  options: TemplateAddStateOptions & {
    nowMs?: number;
    assertForwardCurrent?: () => void;
  } = {},
): Promise<{ files: PersistedTemplateWorkspaceFile[]; rollback: () => Promise<void> }> {
  const actions = plan.actions.filter((action) => action.kind === "workspaceFile");
  if (actions.length === 0) {
    return { files: [], rollback: async () => {} };
  }

  const workspaceRoot = await realpath(resolve(plan.agent.workspace));
  const packageRoot = await realpath(resolve(plan.template.packageRoot));
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_TEMPLATE_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_TEMPLATE_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const createdFiles: PersistedTemplateWorkspaceFile[] = [];
  const createdDirectories = new Set<string>();
  const fileIdentities = new Map<string, Awaited<ReturnType<Root["stat"]>>>();
  const nowMs = options.nowMs ?? Date.now();
  const assertForwardCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };

  const rollback = async () => {
    for (const file of createdFiles.toReversed()) {
      await options.prepareEffect?.();
      assertForwardCurrent();
      const read = await workspace.read(file.path);
      const owned = fileIdentities.get(file.path);
      if (
        !owned ||
        read.stat.dev !== owned.dev ||
        read.stat.ino !== owned.ino ||
        read.stat.mode !== owned.mode ||
        read.stat.mtimeMs !== owned.mtimeMs ||
        digestTemplateBytes(read.buffer) !== file.contentDigest
      ) {
        throw new TemplateWorkspaceWriteError(
          "Template instruction changed; cleanup left it in place",
        );
      }
      assertForwardCurrent();
      await workspace.remove(file.path, { assertBeforeMutation: assertForwardCurrent });
    }
    for (const directory of [...createdDirectories].toReversed()) {
      if (!(await workspace.exists(directory))) {
        continue;
      }
      await options.prepareEffect?.();
      assertForwardCurrent();
      // Only empty directories created by this attempt may be removed.
      await workspace.remove(directory, {
        recursive: false,
        assertBeforeMutation: assertForwardCurrent,
      });
    }
  };
  try {
    for (const action of actions) {
      try {
        assertForwardCurrent();
        if (!action.source || !action.digest) {
          throw new TemplateWorkspaceWriteError();
        }
        const targetPath = resolve(action.target);
        const targetRelative = templateContainedRelativePath(workspaceRoot, targetPath);
        if (!targetRelative) {
          throw new TemplateWorkspaceWriteError();
        }
        const resolvedSource = await readTemplateWorkspaceActionSource({
          action,
          packageRoot,
          sourceRoot: source,
        });
        const digest = digestTemplateBytes(resolvedSource.content);
        if (digest !== action.digest) {
          throw new TemplateWorkspaceWriteError();
        }
        assertForwardCurrent();
        const expectedRecord: PersistedTemplateWorkspaceFile = {
          schemaVersion: TEMPLATE_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
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
          throw new TemplateWorkspaceWriteError();
        }
        await options.prepareEffect?.();
        assertForwardCurrent();
        const missingParents: string[] = [];
        for (
          let parent = dirname(targetRelative);
          parent !== "." && !(await workspace.exists(parent));
          parent = dirname(parent)
        ) {
          missingParents.push(parent);
        }
        for (const parent of missingParents.toReversed()) {
          createdDirectories.add(parent);
        }
        await workspace.write(targetRelative, resolvedSource.content, {
          mkdir: true,
          overwrite: false,
          assertBeforeMutation: assertForwardCurrent,
        });
        fileIdentities.set(expectedRecord.path, await workspace.stat(targetRelative));
        createdFiles.push({ ...expectedRecord, status: "complete" });
      } catch {
        throw new TemplateWorkspaceWriteError();
      }
    }
  } catch (error) {
    try {
      await rollback();
    } catch (cleanupError) {
      throw new TemplateWorkspaceWriteError(
        `Template workspace file creation failed; owned cleanup failed: ${String(cleanupError)}`,
      );
    }
    throw error;
  }
  return { files: createdFiles, rollback };
}
