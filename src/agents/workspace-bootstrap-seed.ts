import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { pathExists } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "./workspace-bootstrap-policy.js";
import { WorkspaceBootstrapSeedConflictError } from "./workspace-bootstrap-publish.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { runWorkspaceFilesystemOperation } from "./workspace-filesystem.js";
import {
  runWorkspacePreparation,
  settleWorkspaceBootstrapDeferral,
} from "./workspace-preparation.js";
import { readCanonicalWorkspaceStateSnapshot } from "./workspace-state-read.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

type SeedWorkspaceBootstrapParams = {
  dir: string;
  content: Buffer;
  nowMs?: number;
  stateOptions?: OpenClawStateDatabaseOptions;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => Promise<void>;
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
  return runWorkspacePreparation(captured.dir, async (filesystem) => {
    const guard = { assertHost: captured.beforePersistentApply, filesystem: [filesystem] };
    const result = await seedWorkspaceBootstrapOwned(captured, guard);
    await captured.beforePersistentEffect?.();
    captured.beforePersistentApply?.();
    await settleWorkspaceBootstrapDeferral(captured.dir, {
      ...captured.stateOptions,
      assertCurrent: captured.beforePersistentApply,
      filesystem: guard.filesystem,
    });
    return result;
  });
}

async function seedWorkspaceBootstrapOwned(
  params: SeedWorkspaceBootstrapParams,
  guard: WorkspaceStateGuard,
): Promise<"seeded" | "already-seeded" | "consumed"> {
  const assertSeedCurrent = () => {
    params.beforePersistentApply?.();
  };
  const dir = params.dir;
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const initialState = (await readCanonicalWorkspaceStateSnapshot(dir, params.stateOptions, guard))
    .setup;
  if (initialState.setupCompletedAt) {
    return "consumed";
  }
  const bootstrapExists = await pathExists(bootstrapPath);
  assertSeedCurrent();
  if (initialState.bootstrapSeededAt && !bootstrapExists) {
    return "consumed";
  }

  await params.beforePersistentEffect?.();
  assertSeedCurrent();
  await runWorkspaceFilesystemOperation({ kind: "mkdir", dir }, guard);
  assertSeedCurrent();
  let created: boolean;
  try {
    await params.beforePersistentEffect?.();
    assertSeedCurrent();
    created = await runWorkspaceFilesystemOperation(
      { kind: "seed", dir, name: DEFAULT_BOOTSTRAP_FILENAME, content: params.content },
      guard,
    );
  } catch (error) {
    if (hasErrnoCode(error, "WORKSPACE_BOOTSTRAP_SEED_CONFLICT") && error instanceof Error) {
      throw new WorkspaceBootstrapSeedConflictError(error.message);
    }
    throw error;
  }

  if (!initialState.bootstrapSeededAt) {
    const nowMs = params.nowMs ?? Date.now();
    await params.beforePersistentEffect?.();
    assertSeedCurrent();
    await (params.mergeSetupState ?? mergeWorkspaceSetupState)(
      dir,
      {
        bootstrapSeededAt: new Date(nowMs).toISOString(),
      },
      nowMs,
      { ...params.stateOptions, assertCurrent: assertSeedCurrent, filesystem: guard.filesystem },
    );
  }
  assertSeedCurrent();
  return created ? "seeded" : "already-seeded";
}
