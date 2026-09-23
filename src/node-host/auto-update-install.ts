import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  packNpmSpecToArchive,
  resolveNpmSpecMetadata,
  withInstallWorkspace,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { isExactSemverVersion } from "../infra/npm-registry-spec.js";
import { collectPackageDistContentInventoryErrors } from "../infra/package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "../infra/package-update-steps.js";
import {
  collectInstalledGlobalPackageErrors,
  createGlobalInstallEnv,
  resolveGlobalInstallTarget,
} from "../infra/update-global.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { AUTO_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { runStep } from "../infra/update-runner-command.js";
import type { CommandRunner } from "../infra/update-runner-types.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import {
  assertNodeRuntimeSchemaVersions,
  assertNodeRuntimeUpdateCompatible,
  readNodeRuntimeUpdateManifest,
} from "./auto-update-compatibility.js";

export type PreparedNodeRuntimeUpdate = {
  runtimeRoot: string;
  packageRoot: string;
  version: string;
  integrity: string;
  warnings?: string[];
};

/** Install only into an immutable private generation; activation belongs to the node launcher. */
export async function prepareNodeRuntimeUpdate(params: {
  targetVersion: string;
  stateDir: string;
  signal?: AbortSignal;
}): Promise<PreparedNodeRuntimeUpdate> {
  const version = params.targetVersion.trim();
  if (!isExactSemverVersion(version) || /[\\/]/u.test(version)) {
    throw new Error("Node auto-update requires an exact published OpenClaw version.");
  }
  params.signal?.throwIfAborted();
  const spec = `openclaw@${version}`;
  const resolved = await resolveNpmSpecMetadata({ spec, signal: params.signal });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  const { metadata } = resolved;
  if (metadata.name !== "openclaw" || metadata.version !== version || !metadata.integrity) {
    throw new Error(
      "Node auto-update registry metadata does not identify the requested release and integrity.",
    );
  }
  assertNodeRuntimeSchemaVersions(
    parsePackageOpenClawSchemaVersions({
      name: metadata.name,
      version: metadata.version,
      openclaw: metadata.packageOpenClaw,
    }),
  );
  const integrity = metadata.integrity;
  const digest = createHash("sha256").update(integrity).digest("hex");
  const runtimeRoot = path.resolve(
    params.stateDir,
    "node-runtime",
    "releases",
    `${version}-${digest}`,
  );
  const prepareGeneration = async (
    generationRoot: string,
  ): Promise<PreparedNodeRuntimeUpdate | { invalidRuntime: string }> => {
    const layout = resolveNpmGlobalPrefixLayoutFromPrefix(generationRoot);
    const packageRoot = path.join(layout.globalRoot, "openclaw");
    const prepared = { runtimeRoot: generationRoot, packageRoot, version, integrity };

    return await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(generationRoot);
      const assertCurrent = () => {
        fence.assertCurrent();
        params.signal?.throwIfAborted();
      };
      assertCurrent();
      let retained = false;
      try {
        await fs.lstat(packageRoot);
        retained = true;
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
      if (retained) {
        // Never reinstall over a retained generation: the launcher may still be running it.
        try {
          const errors = [
            ...(await collectInstalledGlobalPackageErrors({
              packageRoot,
              expectedVersion: version,
            })),
            ...(await collectPackageDistContentInventoryErrors(packageRoot)),
          ];
          if (errors.length) {
            throw new Error(errors.join("; "));
          }
          await readNodeRuntimeUpdateManifest(packageRoot);
        } catch (error) {
          assertCurrent();
          return {
            invalidRuntime: `Preserved invalid node runtime at ${generationRoot}: ${formatErrorMessage(error)}`,
          };
        }
        await assertNodeRuntimeUpdateCompatible({ ...params, packageRoot });
        assertCurrent();
        return prepared;
      }

      return await withInstallWorkspace("openclaw-node-update-", async (workspace) => {
        assertCurrent();
        const packed = await packNpmSpecToArchive({
          spec,
          cwd: workspace,
          timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
          signal: params.signal,
        });
        assertCurrent();
        if (!packed.ok) {
          throw new Error(packed.error);
        }
        if (packed.metadata.name !== "openclaw" || packed.metadata.version !== version) {
          throw new Error("Node auto-update archive does not match the requested release.");
        }
        const drift = await resolveNpmIntegrityDriftWithDefaultMessage({
          spec,
          expectedIntegrity: integrity,
          resolution: packed.metadata,
        });
        if (drift.error) {
          throw new Error(drift.error);
        }
        const env = await createGlobalInstallEnv({
          ...process.env,
          // Lifecycle work must not select an operator's live state or config.
          OPENCLAW_STATE_DIR: path.join(workspace, "state"),
          OPENCLAW_CONFIG_PATH: path.join(workspace, "openclaw.json"),
        });
        const runCommand: CommandRunner = async (argv, options) => {
          assertCurrent();
          const result = await runCommandWithTimeout(argv, {
            ...options,
            env: { ...env, ...options.env },
            signal: params.signal,
            killProcessTree: true,
          });
          assertCurrent();
          return result;
        };
        const installTarget = await resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
          pkgRoot: packageRoot,
          honorPackageRoot: true,
          packageName: "openclaw",
        });
        if (
          installTarget.manager !== "npm" ||
          installTarget.packageRoot !== packageRoot ||
          installTarget.globalRoot !== layout.globalRoot
        ) {
          throw new Error("Node auto-update npm target escaped its private runtime prefix.");
        }
        assertCurrent();
        const result = await runGlobalPackageUpdateSteps({
          installTarget,
          installSpec: packed.archivePath,
          packageName: "openclaw",
          runCommand,
          runStep: (step) =>
            runStep({
              ...step,
              runCommand,
              cwd: step.cwd ?? workspace,
              stepIndex: 0,
              totalSteps: 0,
            }),
          timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
          env,
          installCwd: workspace,
          assertCurrent,
          validateCandidate: async (candidateRoot) => {
            const candidate = await readNodeRuntimeUpdateManifest(candidateRoot);
            if (candidate.version !== version) {
              throw new Error("Node auto-update installed an unexpected package version.");
            }
            await assertNodeRuntimeUpdateCompatible({ ...params, packageRoot: candidateRoot });
            assertCurrent();
            return [];
          },
        });
        assertCurrent();
        if (
          result.failedStep ||
          result.activePackageRoot !== packageRoot ||
          result.afterVersion !== version
        ) {
          throw new Error(
            result.failedStep?.stderrTail ??
              "Node auto-update private installation could not be verified.",
          );
        }
        return prepared;
      });
    });
  };

  const initial = await prepareGeneration(runtimeRoot);
  if (!("invalidRuntime" in initial)) {
    return initial;
  }
  // A crash can leave partial bytes at the canonical generation. Retry once in a
  // new generation without guessing whether the old one is still in use.
  try {
    const replacement = await prepareGeneration(`${runtimeRoot}-${randomUUID()}`);
    if ("invalidRuntime" in replacement) {
      throw new Error(replacement.invalidRuntime);
    }
    return { ...replacement, warnings: [initial.invalidRuntime] };
  } catch (cause) {
    throw new Error(
      `${initial.invalidRuntime}; fresh installation failed: ${formatErrorMessage(cause)}`,
      { cause },
    );
  }
}
