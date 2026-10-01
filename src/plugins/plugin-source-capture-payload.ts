import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import type { PluginSourceCaptureInstance } from "./plugin-instance-invocation.types.js";

export async function removePluginSourceCapturePayload(
  root: string,
  pendingNative: Iterable<string>,
  assertIdentity?: () => void,
  beforeRemoveRoot?: () => void,
): Promise<void> {
  assertIdentity?.();
  await fsPromises.rm(path.join(root, "captures"), { recursive: true, force: true });
  for (const directory of pendingNative) {
    assertIdentity?.();
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
  assertIdentity?.();
  const native = await fsPromises.readdir(path.join(root, "native")).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return [];
  });
  if (native.length === 0) {
    assertIdentity?.();
    beforeRemoveRoot?.();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

/** Native snapshots keep their original capture reference through publication and disposal. */
export function createPluginNativeCapturePayload(
  instance: PluginSourceCaptureInstance,
  retainLoadedPluginSourceCapture: (root: string) => boolean,
) {
  try {
    const root = instance.createNativeDirectory();
    let committed = false;
    let disposed = false;
    return {
      directory: root.directory,
      commit() {
        if (disposed) {
          throw new Error("Plugin native capture has been disposed");
        }
        root.commit();
        committed = true;
      },
      dispose() {
        if (!disposed) {
          if (!committed && !retainLoadedPluginSourceCapture(root.directory)) {
            fs.rmSync(root.directory, { recursive: true, force: true });
          }
          disposed = true;
          instance.release();
        }
      },
      async disposeAsync() {
        if (!disposed) {
          if (!committed && !retainLoadedPluginSourceCapture(root.directory)) {
            await removeTemporaryArtifacts(root.directory, "Plugin native capture");
          }
          disposed = true;
          await instance.releaseAsync();
        }
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}

/** Root admission owns preparation and cleanup even when no capture can be handed back. */
export function startPluginSourceCapturePayload(
  prepare: () => {
    reference: PluginSourceCaptureInstance;
    preparation: Promise<void>;
    failedCleanup: () => Promise<void> | undefined;
  },
  prefix: string,
  retainLoadedPluginSourceCapture: (root: string) => boolean,
) {
  type CleanupAttempt = {
    result: Promise<void>;
    state: "pending" | "fulfilled" | "rejected";
    observed: boolean;
  };
  let reference: PluginSourceCaptureInstance | undefined;
  let failedPreparationCleanup: (() => Promise<void> | undefined) | undefined;
  let directory: string | undefined;
  let releasedReason: Error | undefined;
  let cleanup: CleanupAttempt | undefined;
  let releasing: Promise<void> | undefined;
  const trackCleanup = (result: Promise<void>): CleanupAttempt => {
    const attempt: CleanupAttempt = { result, state: "pending", observed: false };
    void result.then(
      () => {
        attempt.state = "fulfilled";
      },
      () => {
        attempt.state = "rejected";
      },
    );
    return attempt;
  };
  const releaseOriginal = async () => {
    if (!reference) {
      return;
    }
    if (directory && reference.isCurrent() && !retainLoadedPluginSourceCapture(directory)) {
      await removeTemporaryArtifacts(directory, "Plugin source worker");
    }
    await reference.releaseAsync();
  };
  const result = (async () => {
    try {
      const prepared = prepare();
      const original = prepared.reference;
      reference = original;
      failedPreparationCleanup = prepared.failedCleanup;
      await prepared.preparation;
      const assertPreparedCurrent = () => {
        original.assertCurrent();
        if (releasedReason) {
          throw releasedReason;
        }
      };
      assertPreparedCurrent();
      directory = original.createDirectory(prefix);
      assertPreparedCurrent();
      return Object.freeze({
        directory,
        managedRoot: original.managedRoot,
        assertCurrent: () => {
          if (releasedReason) {
            throw releasedReason;
          }
          original.assertCurrent();
        },
      });
    } catch (error) {
      const failed = failedPreparationCleanup?.();
      if (failed) {
        cleanup = trackCleanup(failed);
      } else {
        cleanup = trackCleanup(releaseOriginal());
        try {
          await cleanup.result;
        } catch (cleanupError) {
          throw createSqliteLifecycleAggregateError(
            [error, cleanupError],
            "Plugin worker source capture preparation and cleanup failed",
            error,
          );
        }
      }
      throw error;
    }
  })();
  return Object.freeze({
    result,
    release: (reason?: Error): Promise<void> => {
      releasedReason ??= reason ?? new Error("Plugin source instance has been released");
      return (releasing ??= (async () => {
        await result.then(
          () => undefined,
          () => undefined,
        );
        if (!cleanup || (cleanup.state === "rejected" && cleanup.observed)) {
          cleanup = trackCleanup(releaseOriginal());
        }
        cleanup.observed = true;
        await cleanup.result;
      })().finally(() => {
        releasing = undefined;
      }));
    },
  });
}
