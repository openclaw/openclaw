import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { DEFAULT_BOOTSTRAP_FILENAME, seedWorkspaceBootstrap } from "../agents/workspace.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  mergeWorkspaceBootstrapSetupStateForAdd,
  type TemplateAddStateOptions,
} from "./add-state-write.js";
import { digestTemplateBytes } from "./digest.js";
import { templateContainedRelativePath } from "./path-containment.js";
import type { TemplateAddPlan } from "./types.js";

class TemplateBootstrapWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateBootstrapWriteError";
  }
}

export async function seedTemplatePackageBootstrap(
  plan: TemplateAddPlan,
  options: {
    nowMs?: number;
    assertForwardCurrent?: () => void;
  } & TemplateAddStateOptions = {},
): Promise<"seeded" | "already-seeded" | "consumed" | undefined> {
  const actions = plan.actions.filter((action) => action.kind === "bootstrap");
  if (actions.length === 0) {
    return undefined;
  }
  if (actions.length !== 1) {
    throw new TemplateBootstrapWriteError(
      "A Template add plan may contain only one package bootstrap action.",
    );
  }
  const action = actions[0]!;
  if (!action.source || !action.digest) {
    throw new TemplateBootstrapWriteError("The package bootstrap action lacks source integrity.");
  }

  const packageRoot = await realpath(resolve(plan.template.packageRoot));
  const sourcePath = resolve(action.source);
  const sourceRelative = templateContainedRelativePath(packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new TemplateBootstrapWriteError("BOOTSTRAP.md must remain inside the Template package.");
  }
  const sourceRoot = await fsSafeRoot(packageRoot);
  const read = await sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath || digestTemplateBytes(read.buffer) !== action.digest) {
    throw new TemplateBootstrapWriteError(
      "BOOTSTRAP.md changed after consent; run add --dry-run again.",
    );
  }

  const expectedTarget = resolve(plan.agent.workspace, DEFAULT_BOOTSTRAP_FILENAME);
  if (resolve(action.target) !== expectedTarget) {
    throw new TemplateBootstrapWriteError(
      "The package bootstrap target is not the new agent workspace root.",
    );
  }

  const assertForwardCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  return seedWorkspaceBootstrap({
    dir: plan.agent.workspace,
    content: read.buffer,
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    stateOptions: { ...options, readOnly: options.stateMode === "worker" },
    beforePersistentApply: assertForwardCurrent,
    beforePersistentEffect: options.prepareEffect,
    mergeSetupState: (workspaceDir, next, nowMs) => {
      if (!next.bootstrapSeededAt) {
        throw new TemplateBootstrapWriteError("Missing bootstrap timestamp.");
      }
      return mergeWorkspaceBootstrapSetupStateForAdd(
        workspaceDir,
        next.bootstrapSeededAt,
        nowMs ?? Date.now(),
        { ...options, assertCurrent: assertForwardCurrent },
      );
    },
  });
}
