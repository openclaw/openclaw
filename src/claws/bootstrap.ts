import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { DEFAULT_BOOTSTRAP_FILENAME, seedWorkspaceBootstrap } from "../agents/workspace.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  mergeWorkspaceBootstrapSetupStateForAdd,
  type ClawAddStateOptions,
} from "./add-state-write.js";
import { digestClawBytes } from "./digest.js";
import { clawContainedRelativePath } from "./path-containment.js";
import type { ClawAddPlan } from "./types.js";

class ClawBootstrapWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawBootstrapWriteError";
  }
}

export async function seedClawPackageBootstrap(
  plan: ClawAddPlan,
  options: {
    nowMs?: number;
    assertForwardCurrent?: () => void;
  } & ClawAddStateOptions = {},
): Promise<"seeded" | "already-seeded" | "consumed" | undefined> {
  const actions = plan.actions.filter((action) => action.kind === "bootstrap");
  if (actions.length === 0) {
    return undefined;
  }
  if (actions.length !== 1) {
    throw new ClawBootstrapWriteError(
      "A Claw add plan may contain only one package bootstrap action.",
    );
  }
  const action = actions[0]!;
  if (!action.source || !action.digest) {
    throw new ClawBootstrapWriteError("The package bootstrap action lacks source integrity.");
  }

  const packageRoot = await realpath(resolve(plan.claw.packageRoot));
  const sourcePath = resolve(action.source);
  const sourceRelative = clawContainedRelativePath(packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new ClawBootstrapWriteError("BOOTSTRAP.md must remain inside the Claw package.");
  }
  const sourceRoot = await fsSafeRoot(packageRoot);
  const read = await sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath || digestClawBytes(read.buffer) !== action.digest) {
    throw new ClawBootstrapWriteError(
      "BOOTSTRAP.md changed after consent; run add --dry-run again.",
    );
  }

  const expectedTarget = resolve(plan.agent.workspace, DEFAULT_BOOTSTRAP_FILENAME);
  if (resolve(action.target) !== expectedTarget) {
    throw new ClawBootstrapWriteError(
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
    mergeSetupState: (workspaceDir, next, nowMs) => {
      if (!next.bootstrapSeededAt) {
        throw new ClawBootstrapWriteError("Missing bootstrap timestamp.");
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
