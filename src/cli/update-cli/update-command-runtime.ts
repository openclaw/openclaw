import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { acquireDistArtifactOwnership } from "../../../scripts/lib/dist-artifact-lock.mts";
import type {
  DistArtifactOwnership,
  PrepareBundledPluginRuntime,
  WithDistArtifactOwnership,
} from "../../../scripts/lib/runtime-artifact-contract.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import type { PluginLifecycleLeaseContext } from "../../plugins/plugin-lifecycle-lease.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-maintenance.js";

type SourceRuntimeStaging = { prepareBundledPluginRuntime: PrepareBundledPluginRuntime };
type SourceArtifactOwnership = {
  withDistArtifactOwnership: WithDistArtifactOwnership;
};

function isSourceRuntimeStaging(value: unknown): value is SourceRuntimeStaging {
  return isRecord(value) && typeof value.prepareBundledPluginRuntime === "function";
}

function isSourceArtifactOwnership(value: unknown): value is SourceArtifactOwnership {
  return isRecord(value) && typeof value.withDistArtifactOwnership === "function";
}

async function sourceRuntimeStagingExists(file: string) {
  return fs.lstat(file).then(
    () => true,
    (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    },
  );
}

async function loadSourceUpdateRuntime(params: {
  root: string;
  timeoutMs: number;
  lease: PluginLifecycleLeaseContext;
}) {
  params.lease.assertOwned();
  const installKind = await resolveUpdateInstallKind(params.root, {
    signal: params.lease.signal,
    timeoutMs: params.timeoutMs,
  });
  if (installKind !== "git") {
    params.lease.assertOwned();
    return undefined;
  }
  const root = await fs.realpath(params.root);
  params.lease.assertOwned();
  const stagingFile = path.join(root, "scripts", "stage-bundled-plugin-runtime.mts");
  const stagingPresent = await sourceRuntimeStagingExists(stagingFile);
  params.lease.assertOwned();
  // Older downgrade targets have no completion contract: 2026.4.27 predates
  // this .mts module, and 2026.9.4 exports only the destructive legacy stager.
  if (!stagingPresent) {
    return undefined;
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
    return undefined;
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
  return { root, staging, ownership };
}

/** Hold installed-checkout admission through activation and joined completion. */
export async function prepareSourceUpdateRuntime(params: {
  root: string;
  timeoutMs: number;
  nodeRunner?: string;
  assertCurrent(): void;
}): Promise<DistArtifactOwnership | undefined> {
  if ((await resolveUpdateInstallKind(params.root, { timeoutMs: params.timeoutMs })) !== "git") {
    params.assertCurrent();
    return undefined;
  }
  const root = await fs.realpath(params.root);
  params.assertCurrent();
  const ownership = await acquireDistArtifactOwnership(root, { runtimeChildren: true });
  try {
    params.assertCurrent();
    const stagingFile = path.join(root, "scripts", "stage-bundled-plugin-runtime.mts");
    const stagingPresent = await sourceRuntimeStagingExists(stagingFile);
    params.assertCurrent();
    if (stagingPresent) {
      // A joined probe exercises the real producer without caching its old
      // module graph in the process that may complete the activated target.
      const result = await runCommandWithTimeout(
        [
          params.nodeRunner ?? process.execPath,
          "--input-type=module",
          "--eval",
          `const staging = await import(process.argv[1]);
if (typeof staging.prepareBundledPluginRuntime === "function") {
  const prepared = staging.prepareBundledPluginRuntime({ repoRoot: process.argv[2] });
  await prepared.cleanup();
} else if (staging.prepareBundledPluginRuntime !== undefined || typeof staging.stageBundledPluginRuntime !== "function") {
  throw new Error("The installed source checkout cannot complete its runtime artifacts.");
}`,
          pathToFileURL(stagingFile).href,
          root,
        ],
        {
          cwd: root,
          timeoutMs: params.timeoutMs,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          maxOutputBytes: 8000,
        },
      );
      if (result.cleanup === "forced" || result.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      if (result.code !== 0 || result.termination !== "exit") {
        throw new Error(
          `Installed runtime staging failed (${result.code}): ${result.stderr.trim()}`,
        );
      }
    }
    params.assertCurrent();
    await ownership.assertOwned();
    return ownership;
  } catch (error) {
    if (!hasCommandProcessCleanupError(error)) {
      await ownership.release();
    }
    throw error;
  }
}

/** Complete source-install artifacts before the target loads plugin configuration. */
export async function completeSourceUpdateRuntime(params: {
  root: string;
  timeoutMs: number;
  lease: PluginLifecycleLeaseContext;
  artifactOwnership?: DistArtifactOwnership;
  beforePersistentEffect?: () => void | Promise<void>;
  beforePublication?: () => Promise<void>;
}): Promise<{ changed: boolean }> {
  const source = await loadSourceUpdateRuntime(params);
  if (!source) {
    return { changed: false };
  }
  const { root, staging, ownership } = source;

  const complete = async (inheritedOwnership?: DistArtifactOwnership) => {
    const artifactOwnership = params.artifactOwnership ?? inheritedOwnership;
    await artifactOwnership?.assertOwned();
    params.lease.assertOwned();
    const prepared = staging.prepareBundledPluginRuntime({ repoRoot: root });
    try {
      params.lease.assertOwned();
      if (prepared.changed) {
        await params.beforePublication?.();
        params.lease.assertOwned();
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
              await artifactOwnership?.assertOwned();
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
  };
  return params.artifactOwnership
    ? await complete()
    : await ownership.withDistArtifactOwnership(root, complete);
}
