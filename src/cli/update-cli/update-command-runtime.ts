import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WithDistArtifactOwnership } from "../../../scripts/lib/runtime-artifact-contract.js";
import { loadSourceRuntimePreparation } from "../../../scripts/lib/source-update-artifact-preflight.mts";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import type { PluginLifecycleLeaseContext } from "../../plugins/plugin-lifecycle-lease.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-maintenance.js";

type SourceArtifactOwnership = { withDistArtifactOwnership: WithDistArtifactOwnership };

export async function releaseLegacySourceLock(root: string, lock?: FileLockHandle) {
  const consumer = path.join(root, "scripts/lib/source-update-artifact-preflight.mts");
  // Shipped targets without the prepared-fact consumer retain their original writer.
  if (lock && !existsSync(consumer)) {
    await lock.release();
  }
}

function isSourceArtifactOwnership(value: unknown): value is SourceArtifactOwnership {
  return isRecord(value) && typeof value.withDistArtifactOwnership === "function";
}

/** Complete source-install artifacts before the target loads plugin configuration. */
export async function completeSourceUpdateRuntime(params: {
  root: string;
  timeoutMs: number;
  lease: PluginLifecycleLeaseContext;
  sourceRuntimePrepared?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  beforePublication?: () => Promise<void>;
}): Promise<{ changed: boolean }> {
  params.lease.assertOwned();
  if (params.sourceRuntimePrepared === true) {
    return { changed: false };
  }
  const installKind = await resolveUpdateInstallKind(params.root, {
    signal: params.lease.signal,
    timeoutMs: params.timeoutMs,
  });
  if (installKind !== "git") {
    params.lease.assertOwned();
    return { changed: false };
  }
  const root = await fs.realpath(params.root);
  params.lease.assertOwned();
  const prepare = await loadSourceRuntimePreparation(root);
  params.lease.assertOwned();
  if (!prepare) {
    return { changed: false };
  }
  const complete = async () => {
    params.lease.assertOwned();
    const prepared = prepare({ repoRoot: root });
    try {
      params.lease.assertOwned();
      if (prepared.changed) {
        await params.beforePublication?.();
        params.lease.assertOwned();
        const publicationFailures: unknown[] = [];
        try {
          await withGatewayRuntimeArtifactPublication(
            {
              root,
              env: process.env,
              timeoutMs: params.timeoutMs,
              assertCurrent: () => params.lease.assertOwned(),
            },
            async (assertPublicationCurrent) => {
              params.lease.renew?.();
              await prepared.publish(async () => {
                await params.beforePersistentEffect?.();
                await assertPublicationCurrent();
                params.lease.assertOwned();
              });
            },
          );
        } catch (error) {
          publicationFailures.push(error);
        }
        try {
          // Publication has settled rollback and released its temporary authority.
          params.lease.renew?.();
        } catch (error) {
          if (!publicationFailures.includes(error)) {
            publicationFailures.push(error);
          }
        }
        throwSqliteLifecycleErrors(
          publicationFailures,
          "Runtime publication and plugin lease renewal restoration failed.",
        );
      }
    } catch (error) {
      try {
        await prepared.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Runtime completion and staging cleanup failed.",
          {
            cause: cleanupError,
          },
        );
      }
      throw error;
    }
    await prepared.cleanup();
    return { changed: prepared.changed };
  };
  if (params.sourceRuntimePrepared === false) {
    return await complete();
  }
  const ownership: unknown = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "dist-artifact-ownership.mts")).href
  );
  params.lease.assertOwned();
  if (!isSourceArtifactOwnership(ownership)) {
    throw new Error("The installed source checkout cannot complete its runtime artifacts.");
  }
  return await ownership.withDistArtifactOwnership(root, complete);
}
