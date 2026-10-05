import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { captureUpdateCommandExecutorAuthority } from "../../cli/update-cli/update-command-executor.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { runSqliteReadOnlyOperation } from "../sqlite-readonly-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../sqlite-worker-store.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  assertManagedUpdateLeaseDatabaseIdentity,
} from "../update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "../update-run-recovery.js";
import type { UpdateRunWriteOptions } from "../update-run-write.async.js";
import {
  retainedUpgradeRecipeRunSchema,
  type RetainedUpgradeRecipeRun,
  type UpgradeRecipeRecoveryPorts,
} from "./recovery-contract.js";
import { pointerSchema, type RetainedUpgradeRecipeRunPointer } from "./retained-run-contract.js";

const artifactSchema = retainedUpgradeRecipeRunSchema.shape.planArtifact;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type { RetainedUpgradeRecipeRunPointer } from "./retained-run-contract.js";
function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
async function privatePath(file: string, directory: boolean) {
  const stat = await fs.lstat(file);
  if (
    (await fs.realpath(file)) !== file ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Retained evidence must use private canonical owner files.");
  }
  return stat;
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Exclusive publication: an interrupted orphan is preserved, never silently adopted. */
async function writeImmutable(file: string, bytes: Uint8Array, assertCurrent: () => void) {
  assertCurrent();
  await privatePath(path.dirname(file), true);
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    assertCurrent();
  } finally {
    await handle.close();
  }
  await privatePath(file, false);
  await syncDirectory(path.dirname(file));
  assertCurrent();
  return { path: file, sha256: hash(bytes), length: bytes.byteLength };
}
async function readImmutable(ref: RetainedUpgradeRecipeRun["planArtifact"], max: number) {
  if (ref.length > max) {
    throw new Error("Retained artifact exceeds its private byte bound.");
  }
  await privatePath(path.dirname(ref.path), true);
  const initial = await privatePath(ref.path, false);
  if (initial.size !== ref.length) {
    throw new Error("Retained artifact length changed.");
  }
  const handle = await fs.open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.dev !== initial.dev || before.ino !== initial.ino) {
      throw new Error("Retained artifact identity changed.");
    }
    const bytes = Buffer.alloc(ref.length);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) {
        break;
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await privatePath(ref.path, false);
    if (
      offset !== ref.length ||
      after.size !== ref.length ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      hash(bytes) !== ref.sha256
    ) {
      throw new Error("Retained artifact bytes or identity changed.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Concrete native worker store. The supplied verifier ports remain the existing trust owners. */
export function createRetainedUpgradeRecipeRunStore(
  options: UpdateRunWriteOptions & { assertCurrent: () => void },
) {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = options.context ?? captureOpenClawStateWorkerContext({ ...options, env });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.signal?.throwIfAborted();
    options.assertCurrent();
  };
  const read = async (runId: string) => {
    assertCurrent();
    const source = captureOpenClawStateReadContext(context.admission.databasePath);
    source.admission.assertCurrent();
    const value = await runSqliteReadOnlyOperation(
      context.admission.databasePath,
      { type: "upgradeRecipeRuns.read", input: { runId } },
      {
        source: "canonical",
        expectedIdentity: source.admission.identity.key,
        env,
        signal: options.signal,
      },
    );
    source.admission.assertCurrent();
    assertCurrent();
    if (value) {
      if (value.pointer.ledgerAuthority.databasePath !== context.admission.databasePath) {
        throw new Error("Retained recipe pointer selects another original ledger store.");
      }
      assertManagedUpdateLeaseDatabaseIdentity(value.pointer.ledgerAuthority);
    }
    return value;
  };
  const record = async (pointer: RetainedUpgradeRecipeRunPointer, assertOwner: () => void) => {
    const assertWriteCurrent = () => {
      assertCurrent();
      assertOwner();
    };
    options.assertAccepting?.();
    assertWriteCurrent();
    const pending = runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "upgradeRecipeRuns.retain", input: pointer }),
      {
        existingOnly: true,
        assertCurrent: assertWriteCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertWriteCurrent, [
          context.admission.databasePath,
        ]),
      },
    ).catch((error: unknown) => {
      if (hasSqliteWorkerOutcomeUnknown(error) && !hasCommandProcessCleanupError(error)) {
        throw new CommandProcessCleanupError({ cause: error });
      }
      throw error;
    });
    options.retainSettlement?.(pending.then(() => undefined));
    const result = await pending;
    assertWriteCurrent();
    return pointerSchema.parse(result);
  };
  const readRetainedEnvelope = async (runId: string) => {
    const value = await read(runId);
    if (!value) {
      throw new Error("Original retained run pointer is missing; never adopt orphan evidence.");
    }
    const bytes = await readImmutable(value.pointer.envelope, 1024 * 1024);
    const retained = retainedUpgradeRecipeRunSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      retained.binding.runId !== runId ||
      !isDeepStrictEqual(retained.nativeAuthority, value.pointer.nativeAuthority) ||
      !isDeepStrictEqual(retained.ledgerAuthority, value.pointer.ledgerAuthority)
    ) {
      throw new Error("Retained envelope differs from original pointer authority.");
    }
    return bytes;
  };
  const readArtifact = (ref: RetainedUpgradeRecipeRun["planArtifact"]) =>
    readImmutable(artifactSchema.parse(ref), 16 * 1024 * 1024);
  return {
    read,
    readRetainedEnvelope,
    readArtifact,
    retain: async (input: {
      fence: UpdateRecoveryFence;
      runId: string;
      originalCreatedAtMs: number;
      root: string;
      forbiddenRoots: readonly string[];
      envelope: Omit<
        RetainedUpgradeRecipeRun,
        | "planArtifact"
        | "configArtifact"
        | "authorizationArtifact"
        | "nativeAuthority"
        | "originalNativeOwner"
        | "ledgerAuthority"
      >;
      plan: Uint8Array;
      config: Uint8Array;
      authorization: Uint8Array;
    }) => {
      const originalEnvelope = structuredClone(input.envelope);
      const forbiddenRoots = [...input.forbiddenRoots];
      const artifacts = [
        Buffer.from(input.plan),
        Buffer.from(input.config),
        Buffer.from(input.authorization),
      ];
      if (artifacts.some((bytes) => bytes.length === 0 || bytes.length > 16 * 1024 * 1024)) {
        throw new Error("Retained artifacts exceed private evidence bounds.");
      }
      const runId = z.uuid().parse(input.runId);
      const root = path.resolve(input.root);
      const ledgerAuthority = captureManagedUpdateLeaseDatabaseIdentity(
        context.admission.databasePath,
      );
      const assertOwner = () => {
        assertCurrent();
        input.fence.assertCurrent();
        const { owner: _owner, ...identity } = captureUpdateCommandExecutorAuthority(
          input.fence,
          runId,
        );
        assertManagedUpdateLeaseDatabaseIdentity(ledgerAuthority);
        return identity;
      };
      const nativeAuthority = assertOwner();
      const originalNativeOwner = captureUpdateCommandExecutorAuthority(input.fence, runId).owner;
      if (
        originalEnvelope.binding.runId !== runId ||
        originalEnvelope.binding.installationKey !== nativeAuthority.installKey
      ) {
        throw new Error("Retained envelope differs from original native owner.");
      }
      if (forbiddenRoots.length === 0) {
        throw new Error("Workspace exclusion roots must be explicit.");
      }
      await privatePath(root, true);
      for (const boundary of [...forbiddenRoots, nativeAuthority.installKey]) {
        const canonical = await fs.realpath(path.resolve(boundary));
        if (inside(canonical, root)) {
          throw new Error("Retained evidence must survive outside installations and workspaces.");
        }
      }
      const directory = path.join(root, runId);
      assertOwner();
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(root);
      const planArtifact = await writeImmutable(
        path.join(directory, "plan.json"),
        artifacts[0]!,
        assertOwner,
      );
      const configArtifact = await writeImmutable(
        path.join(directory, "config.json"),
        artifacts[1]!,
        assertOwner,
      );
      const authorizationArtifact = await writeImmutable(
        path.join(directory, "authorization.json"),
        artifacts[2]!,
        assertOwner,
      );
      const retained = retainedUpgradeRecipeRunSchema.parse({
        ...originalEnvelope,
        nativeAuthority,
        ledgerAuthority,
        originalNativeOwner,
        planArtifact,
        configArtifact,
        authorizationArtifact,
      });
      const bytes = Buffer.from(JSON.stringify(retained));
      if (bytes.length > 1024 * 1024) {
        throw new Error("Retained envelope exceeds private evidence bound.");
      }
      const envelope = await writeImmutable(
        path.join(directory, "envelope.json"),
        bytes,
        assertOwner,
      );
      assertOwner();
      const pointer = await record(
        {
          schemaVersion: 1,
          runId,
          originalCreatedAtMs: input.originalCreatedAtMs,
          envelope,
          nativeAuthority,
          ledgerAuthority,
        },
        assertOwner,
      );
      assertOwner();
      return { pointer, retained };
    },
    recoveryPorts: (
      verifiers: Omit<
        UpgradeRecipeRecoveryPorts,
        "readOriginalRun" | "readRetainedEnvelope" | "readArtifact"
      >,
    ): UpgradeRecipeRecoveryPorts => ({
      ...verifiers,
      readOriginalRun: async (runId) => {
        const value = await read(runId);
        if (!value) {
          return null;
        }
        const { pointer: _pointer, ...original } = value;
        return original;
      },
      readRetainedEnvelope,
      readArtifact,
    }),
  };
}
