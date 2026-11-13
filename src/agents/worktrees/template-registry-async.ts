import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { LruCache } from "../../infra/lru-cache.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateReadCommand } from "../../state/openclaw-state-read.types.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { readWorktreeRegistryCommand } from "./registry-read.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

type TemplateOperation = Extract<
  keyof OpenClawStateWorkerOperations,
  `worktrees.templates.${string}`
>;

async function runTemplateCommand<Key extends TemplateOperation>(
  env: NodeJS.ProcessEnv,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
  commitGuard?: () => void,
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  const context = captureOpenClawStateWorkerContext({ env });
  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
  let outcome: { value: OpenClawStateWorkerOperations[Key]["output"] } | { error: unknown };
  try {
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      {
        assertCurrent: commitGuard,
        createAdmission: (operation) => {
          settled = operation.settled;
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              context.admission.assertCurrent();
              commitGuard?.();
              grant();
            }),
          };
        },
      },
    );
    context.admission.assertCurrent();
    commitGuard?.();
    outcome = { value: result };
  } catch (error) {
    outcome = { error };
  }
  // Result delivery can succeed even when the worker cannot confirm native cleanup.
  const settlement = await settled;
  if (settlement?.kind === "unknown") {
    const error = new SqliteWorkerError(
      "Worktree template native state outcome is unknown",
      "outcome-unknown",
    );
    error.cause =
      "error" in outcome
        ? new AggregateError(
            [outcome.error, settlement.error],
            "Template result delivery and native settlement failed",
          )
        : settlement.error;
    throw error;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

async function runTemplateReadCommand<
  Command extends Extract<OpenClawStateReadCommand, { type: `worktrees.templates.${string}` }>,
>(env: NodeJS.ProcessEnv, command: Command, commitGuard?: () => void) {
  const context = captureOpenClawStateReadWorkerContext({ env });
  commitGuard?.();
  const reply = await readWorktreeRegistryCommand(context, command);
  commitGuard?.();
  return reply;
}

export async function readTemplateAsync(
  env: NodeJS.ProcessEnv,
  cacheKey: string,
  commitGuard?: () => void,
  contentKey?: string,
): Promise<WorktreeTemplateRecord | undefined> {
  const reply = await runTemplateReadCommand(
    env,
    { type: "worktrees.templates.read", input: { cacheKey, contentKey } },
    commitGuard,
  );
  return reply?.record;
}

export async function hasTemplatesAsync(
  env: NodeJS.ProcessEnv,
  commitGuard?: () => void,
): Promise<boolean> {
  const reply = await runTemplateReadCommand(
    env,
    { type: "worktrees.templates.has", input: undefined },
    commitGuard,
  );
  return reply?.has ?? false;
}

export async function listTemplatesAsync(
  env: NodeJS.ProcessEnv,
  commitGuard?: () => void,
): Promise<WorktreeTemplateRecord[]> {
  const reply = await runTemplateReadCommand(
    env,
    { type: "worktrees.templates.list", input: undefined },
    commitGuard,
  );
  return reply?.records ?? [];
}

export function reserveTemplateAsync(
  env: NodeJS.ProcessEnv,
  record: WorktreeTemplateRecord & { status: "preparing" },
  commitGuard: () => void,
): Promise<void> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.reserve", input: record },
    commitGuard,
  );
}

type TemplateManifest = { rawManifest: string; manifestRef: string };
const compressManifest = promisify(zstdCompress);
const decompressManifest = promisify(zstdDecompress);
const templateManifests = new LruCache<{ compressed: Buffer; manifestRef: string; bytes: number }>(
  1024,
  { maxBytes: 64 * 1024 * 1024, sizeOf: (entry) => entry.bytes },
);
const pendingManifests = new Map<string, Promise<TemplateManifest>>();
const templateManifestKey = (record: WorktreeTemplateRecord, policyKey: string) =>
  `${JSON.stringify(record.id)}:${JSON.stringify([record.path, record.createdAt, record.sourceCommit, policyKey])}`;

function invalidateTemplateManifest(id: string): void {
  const prefix = `${JSON.stringify(id)}:`;
  for (const key of templateManifests.keys()) {
    if (key.startsWith(prefix)) {
      templateManifests.delete(key);
    }
  }
}

export async function readTemplateManifest(record: WorktreeTemplateRecord, policyKey: string) {
  const cached = templateManifests.get(templateManifestKey(record, policyKey));
  return (
    cached && {
      rawManifest: (await decompressManifest(cached.compressed)).toString("utf8"),
      manifestRef: cached.manifestRef,
    }
  );
}

/** Callers retain the immutable generation until capture settles, excluding retirement. */
export async function prepareTemplateManifest(
  record: WorktreeTemplateRecord,
  policyKey: string,
  capture: () => Promise<TemplateManifest>,
  signal?: AbortSignal,
): Promise<TemplateManifest> {
  const key = templateManifestKey(record, policyKey);
  while (true) {
    const pending = pendingManifests.get(key);
    if (!pending) {
      break;
    }
    try {
      return await racePromiseWithAbortSignal(pending, signal);
    } catch {
      // Another caller can cancel its capture. Active waiters retry under their own custody.
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  const prepared = (async () => {
    const cached = await readTemplateManifest(record, policyKey);
    signal?.throwIfAborted();
    if (cached) {
      return cached;
    }
    const manifest = await capture();
    const compressed = await compressManifest(Buffer.from(manifest.rawManifest));
    const bytes = compressed.byteLength + 2 * (key.length + manifest.manifestRef.length) + 256;
    templateManifests.set(key, { compressed, manifestRef: manifest.manifestRef, bytes });
    return manifest;
  })().finally(() => pendingManifests.delete(key));
  pendingManifests.set(key, prepared);
  return prepared;
}

export async function markTemplateReadyAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  now: number,
  commitGuard: () => void,
  publication?: OpenClawStateWorkerOperations["worktrees.templates.ready"]["input"]["publication"],
): Promise<boolean> {
  const ready = await runTemplateCommand(
    env,
    { type: "worktrees.templates.ready", input: { id, now, publication } },
    commitGuard,
  );
  if (ready && publication?.previousId && !publication.retainedCacheKey) {
    invalidateTemplateManifest(publication.previousId);
  }
  return ready;
}

export async function deleteTemplateAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): Promise<boolean> {
  try {
    return await runTemplateCommand(
      env,
      { type: "worktrees.templates.delete", input: { id } },
      commitGuard,
    );
  } finally {
    invalidateTemplateManifest(id);
  }
}

export async function retainTemplateReaderAsync(
  env: NodeJS.ProcessEnv,
  input: OpenClawStateWorkerOperations["worktrees.templates.retainReader"]["input"],
  commitGuard: () => void,
): Promise<WorktreeTemplateRecord | undefined> {
  const record = await runTemplateCommand(
    env,
    { type: "worktrees.templates.retainReader", input },
    commitGuard,
  );
  if (record && "unpublish" in input && input.unpublish) {
    invalidateTemplateManifest(record.id);
  }
  return record;
}

export function releaseTemplateReaderAsync(
  env: NodeJS.ProcessEnv,
  key: string,
  commitGuard: () => void,
): Promise<void> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.releaseReader", input: { key } },
    commitGuard,
  );
}

export function hasTemplateReadersAsync(
  env: NodeJS.ProcessEnv,
  id: string,
  commitGuard: () => void,
): Promise<boolean> {
  return runTemplateCommand(
    env,
    { type: "worktrees.templates.hasReaders", input: { id } },
    commitGuard,
  );
}
