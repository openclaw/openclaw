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
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
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
  sourceRuntimePrepared?: boolean;
  assertCurrent?: () => void;
  beforePublication?: () => Promise<void>;
}): Promise<{ changed: boolean }> {
  params.assertCurrent?.();
  if (params.sourceRuntimePrepared === true) {
    return { changed: false };
  }
  const installKind = await resolveUpdateInstallKind(params.root, {
    signal: resolveCommandProcessSignal(),
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent?.();
  if (installKind !== "git") {
    return { changed: false };
  }
  return await withPluginLifecycleLease({ assertCurrent: params.assertCurrent }, (lease) =>
    withCommandProcessScope(async () => {
      const root = await fs.realpath(params.root);
      lease.assertOwned();
      const prepare = await loadSourceRuntimePreparation(root);
      lease.assertOwned();
      if (!prepare) {
        return { changed: false };
      }
      const complete = async () => {
        lease.assertOwned();
        const prepared = prepare({ repoRoot: root });
        try {
          lease.assertOwned();
          if (prepared.changed) {
            await params.beforePublication?.();
            lease.assertOwned();
            const publicationFailures: unknown[] = [];
            try {
              await withGatewayRuntimeArtifactPublication(
                {
                  root,
                  env: process.env,
                  timeoutMs: params.timeoutMs,
                  assertCurrent: () => lease.assertOwned(),
                },
                async (assertPublicationCurrent) => {
                  lease.renew?.();
                  await prepared.publish(async () => {
                    await assertPublicationCurrent();
                    lease.assertOwned();
                  });
                },
              );
            } catch (error) {
              publicationFailures.push(error);
            }
            try {
              // Publication has settled rollback and released its temporary authority.
              lease.renew?.();
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
      lease.assertOwned();
      if (!isSourceArtifactOwnership(ownership)) {
        throw new Error("The installed source checkout cannot complete its runtime artifacts.");
      }
      return await ownership.withDistArtifactOwnership(root, complete);
    }, lease.signal),
  );
}
