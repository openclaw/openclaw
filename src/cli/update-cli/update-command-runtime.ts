import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PrepareBundledPluginRuntime,
  WithDistArtifactOwnership,
} from "../../../scripts/lib/runtime-artifact-contract.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import type { PluginLifecycleLeaseContext } from "../../plugins/plugin-lifecycle-lease.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-maintenance.js";

type SourceRuntimeStaging = { prepareBundledPluginRuntime: PrepareBundledPluginRuntime };
type SourceArtifactOwnership = { withDistArtifactOwnership: WithDistArtifactOwnership };

function isSourceRuntimeStaging(value: unknown): value is SourceRuntimeStaging {
  return isRecord(value) && typeof value.prepareBundledPluginRuntime === "function";
}

function isSourceArtifactOwnership(value: unknown): value is SourceArtifactOwnership {
  return isRecord(value) && typeof value.withDistArtifactOwnership === "function";
}

/** Complete source-install artifacts before the target loads plugin configuration. */
export async function completeSourceUpdateRuntime(params: {
  root: string;
  timeoutMs: number;
  lease: PluginLifecycleLeaseContext;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<{ changed: boolean }> {
  params.lease.assertOwned();
  if ((await resolveUpdateInstallKind(params.root, { signal: params.lease.signal })) !== "git") {
    params.lease.assertOwned();
    return { changed: false };
  }
  const root = await fs.realpath(params.root);
  params.lease.assertOwned();
  const stagingFile = path.join(root, "scripts", "stage-bundled-plugin-runtime.mts");
  const stagingPresent = await fs.lstat(stagingFile).then(
    () => true,
    (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    },
  );
  params.lease.assertOwned();
  // Older downgrade targets have no completion contract: 2026.4.27 predates
  // this .mts module, and 2026.9.4 exports only the destructive legacy stager.
  if (!stagingPresent) {
    return { changed: false };
  }
  // These source-checkout modules are native Node TypeScript. The packaged
  // updater must load the installed target's generator, not its retained code.
  const staging: unknown = await import(pathToFileURL(stagingFile).href);
  params.lease.assertOwned();
  if (
    isRecord(staging) &&
    staging.prepareBundledPluginRuntime === undefined &&
    typeof staging.stageBundledPluginRuntime === "function"
  ) {
    return { changed: false };
  }
  if (!isSourceRuntimeStaging(staging)) {
    throw new Error("The installed source checkout cannot complete its runtime artifacts.");
  }
  const ownership: unknown = await import(
    pathToFileURL(path.join(root, "scripts", "lib", "dist-artifact-ownership.mts")).href
  );
  params.lease.assertOwned();
  if (!isSourceArtifactOwnership(ownership)) {
    throw new Error("The installed source checkout cannot complete its runtime artifacts.");
  }

  return await ownership.withDistArtifactOwnership(root, async () => {
    params.lease.assertOwned();
    const prepared = staging.prepareBundledPluginRuntime({ repoRoot: root });
    try {
      params.lease.assertOwned();
      if (prepared.changed) {
        await withGatewayRuntimeArtifactPublication(
          {
            root,
            env: process.env,
            timeoutMs: params.timeoutMs,
            assertCurrent: () => params.lease.assertOwned(),
          },
          async (assertPublicationCurrent) => {
            await prepared.publish(async () => {
              await params.beforePersistentEffect?.();
              await assertPublicationCurrent();
              params.lease.assertOwned();
            });
          },
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
  });
}
