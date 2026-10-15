import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, pathExists, root as fsSafeRoot } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "./workspace-bootstrap-policy.js";
import { WorkspaceBootstrapSeedConflictError } from "./workspace-bootstrap-publish.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";
import { runWorkspacePreparation } from "./workspace-preparation.js";
import { readCanonicalWorkspaceStateSnapshot } from "./workspace-state-read.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";

type SeedWorkspaceBootstrapParams = {
  dir: string;
  content: Buffer;
  nowMs?: number;
  stateOptions?: OpenClawStateDatabaseOptions;
  beforePersistentApply?: () => void;
  mergeSetupState?: typeof mergeWorkspaceSetupState;
};

export async function seedWorkspaceBootstrap(
  params: SeedWorkspaceBootstrapParams,
): Promise<"seeded" | "already-seeded" | "consumed"> {
  if (params.content.byteLength > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
    throw new WorkspaceBootstrapSeedConflictError(
      `BOOTSTRAP.md exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes.`,
    );
  }
  const options = params.stateOptions;
  const captured = {
    ...params,
    dir: resolveUserPath(params.dir),
    content: Buffer.from(params.content),
    stateOptions: options && {
      ...options,
      env: options.env && { ...options.env },
      initializationAgentPaths: options.initializationAgentPaths && [
        ...options.initializationAgentPaths,
      ],
    },
  };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(captured.content);
  } catch {
    throw new WorkspaceBootstrapSeedConflictError("BOOTSTRAP.md must be valid UTF-8.");
  }
  if (text.trim().length === 0) {
    throw new WorkspaceBootstrapSeedConflictError("BOOTSTRAP.md must not be empty.");
  }
  return runWorkspacePreparation(captured.dir, (assertCurrent) =>
    seedWorkspaceBootstrapOwned(captured, assertCurrent),
  );
}

async function seedWorkspaceBootstrapOwned(
  params: SeedWorkspaceBootstrapParams,
  assertCurrent: () => void,
): Promise<"seeded" | "already-seeded" | "consumed"> {
  const assertSeedCurrent = () => {
    assertCurrent();
    params.beforePersistentApply?.();
  };
  const dir = params.dir;
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const initialState = (
    await readCanonicalWorkspaceStateSnapshot(dir, params.stateOptions, {
      assertHost: assertCurrent,
    })
  ).setup;
  if (initialState.setupCompletedAt) {
    return "consumed";
  }
  const bootstrapExists = await pathExists(bootstrapPath);
  assertCurrent();
  if (initialState.bootstrapSeededAt && !bootstrapExists) {
    return "consumed";
  }

  assertSeedCurrent();
  await fs.mkdir(dir, { recursive: true });
  assertCurrent();
  const workspaceRoot = await fsSafeRoot(dir, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    symlinks: "reject",
  });
  let created = false;
  if (!bootstrapExists) {
    try {
      await workspaceRoot.write(DEFAULT_BOOTSTRAP_FILENAME, params.content, {
        overwrite: false,
        assertBeforeMutation: assertSeedCurrent,
      });
      created = true;
    } catch (error) {
      const alreadyExists =
        hasErrnoCode(error, "EEXIST") ||
        (error instanceof FsSafeError && error.code === "already-exists");
      if (!alreadyExists) {
        throw error;
      }
    }
  }

  if (!created) {
    // Local seeders share the preparation FIFO; an external writer may require another run.
    const existing = await readWorkspaceFileWithGuards({
      filePath: bootstrapPath,
      workspaceDir: dir,
      useCache: false,
    });
    assertCurrent();
    if (!existing.ok) {
      throw new WorkspaceBootstrapSeedConflictError(
        "Existing BOOTSTRAP.md could not be read safely.",
      );
    }
    if (!Buffer.from(existing.content, "utf8").equals(params.content)) {
      throw new WorkspaceBootstrapSeedConflictError(
        "Existing BOOTSTRAP.md differs from the consented Claw bootstrap.",
      );
    }
  }

  if (!initialState.bootstrapSeededAt) {
    const nowMs = params.nowMs ?? Date.now();
    assertSeedCurrent();
    await (params.mergeSetupState ?? mergeWorkspaceSetupState)(
      dir,
      {
        bootstrapSeededAt: new Date(nowMs).toISOString(),
      },
      nowMs,
      { ...params.stateOptions, assertCurrent: assertSeedCurrent },
    );
  }
  assertCurrent();
  return created ? "seeded" : "already-seeded";
}
