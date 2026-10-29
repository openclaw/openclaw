import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { hasErrnoCode } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { cancelUnreadResponseBody } from "../infra/http-body.js";
import {
  normalizeNpmViewMetadata,
  packNpmSpecToArchive,
  resolveNpmSpecMetadata,
  withInstallWorkspace,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { isExactSemverVersion } from "../infra/npm-registry-spec.js";
import { collectPackageDistContentInventoryErrors } from "../infra/package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "../infra/package-update-steps.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { fetchRegistryPackageDocument } from "../infra/update-check-package-target.js";
import { resolveUpdateRegistryTarget } from "../infra/update-check.js";
import {
  collectInstalledGlobalPackageErrors,
  createGlobalInstallEnv,
  resolveGlobalInstallTarget,
} from "../infra/update-global.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "../infra/update-network-budget.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { AUTO_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";
import { runStep } from "../infra/update-runner-command.js";
import type { CommandRunner } from "../infra/update-runner-types.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parsePackageOpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
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
  // Native Bun staging cannot relocate Windows binary launchers yet.
  const manager = process.versions.bun && process.platform !== "win32" ? "bun" : "npm";
  const registryTarget = resolveUpdateRegistryTarget();
  const registryManifest =
    manager === "bun"
      ? await (async () => {
          try {
            const json = await fetchRegistryPackageDocument({
              ...registryTarget,
              signal: params.signal,
              target: version,
              label: "npm package manifest",
              operation: "npm-registry-package-manifest",
              bodyTimeoutMs: Math.max(1, UPDATE_NETWORK_TIMEOUT_MS),
            });
            const metadata = normalizeNpmViewMetadata(
              json,
              `${registryTarget.packageName}@${version}`,
            );
            const tarball = normalizeOptionalString(asRecord(asRecord(json).dist).tarball);
            if (!metadata?.name || !metadata.version || !tarball) {
              throw new Error(
                "Registry returned incomplete package metadata (name, version, or tarball).",
              );
            }
            return { ...metadata, tarball };
          } catch (error) {
            throw new Error(`Registry package manifest failed: ${String(error)}`, { cause: error });
          }
        })()
      : undefined;
  let metadata: NpmSpecResolution | undefined = registryManifest;
  if (!metadata) {
    const resolved = await resolveNpmSpecMetadata({ spec, signal: params.signal });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    metadata = resolved.metadata;
  }
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
      const retained = (await lstatIfExists(packageRoot, "ENOENT")) !== undefined;
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
        let archivePath: string;
        if (registryManifest) {
          const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
            timeoutMs: Math.max(1, UPDATE_NETWORK_TIMEOUT_MS),
            signal: params.signal,
            operation: "npm-registry-package-download",
          });
          let response: Response | undefined;
          let downloadPath: string | undefined;
          try {
            const url = new URL(registryManifest.tarball);
            if (url.origin !== new URL(registryTarget.registryUrl).origin) {
              throw new Error("Package tarball must share the registry origin.");
            }
            if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
              throw new Error("Package archive requires supported sha512 integrity.");
            }
            // Reject redirects so a same-origin URL cannot send the download elsewhere.
            response = await fetch(url.toString(), { signal, redirect: "error" });
            if (!response.ok || !response.body) {
              throw new Error(`Package archive download failed: HTTP ${response.status}`);
            }
            refresh();
            const hash = createHash("sha512");
            downloadPath = path.join(workspace, `${randomUUID()}.tgz`);
            await pipeline(
              response.body,
              async function* (chunks) {
                for await (const chunk of chunks) {
                  hash.update(chunk);
                  refresh();
                  yield chunk;
                }
              },
              createWriteStream(downloadPath, { flags: "wx", mode: 0o600 }),
              { signal },
            );
            signal?.throwIfAborted();
            if (`sha512-${hash.digest("base64")}` !== integrity) {
              throw new Error("Package archive integrity mismatch.");
            }
            archivePath = downloadPath;
          } catch (error) {
            if (downloadPath) {
              await fs.rm(downloadPath, { force: true });
            }
            throw new Error(`Registry package archive failed: ${String(error)}`, { cause: error });
          } finally {
            await cancelUnreadResponseBody(response);
            cleanup();
          }
          assertCurrent();
        } else {
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
          archivePath = packed.archivePath;
        }
        const env = await createGlobalInstallEnv(
          {
            ...process.env,
            // Lifecycle work must not select an operator's live state or config.
            OPENCLAW_STATE_DIR: path.join(workspace, "state"),
            OPENCLAW_CONFIG_PATH: path.join(workspace, "openclaw.json"),
            ...(manager === "bun"
              ? {
                  BUN_INSTALL_GLOBAL_DIR: path.dirname(layout.globalRoot),
                  BUN_INSTALL_BIN: layout.binDir,
                }
              : {}),
          },
          { manager },
        );
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
          manager,
          runCommand,
          timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
          pkgRoot: packageRoot,
          honorPackageRoot: true,
          packageName: "openclaw",
          ...(manager === "bun" ? { env } : {}),
        });
        if (
          installTarget.manager !== manager ||
          installTarget.packageRoot !== packageRoot ||
          installTarget.globalRoot !== layout.globalRoot
        ) {
          throw new Error(`Node auto-update ${manager} target escaped its private runtime prefix.`);
        }
        assertCurrent();
        if (manager === "bun") {
          // Native staging copies an existing Bun global project (a manifest
          // plus node_modules) and probes from it; this generation starts empty.
          await fs.mkdir(layout.globalRoot, { recursive: true });
          await fs.mkdir(layout.binDir, { recursive: true });
          await fs
            .writeFile(
              path.join(path.dirname(layout.globalRoot), "package.json"),
              '{"private":true}\n',
              {
                flag: "wx",
              },
            )
            .catch((error: unknown) => {
              if (!hasErrnoCode(error, "EEXIST")) {
                throw error;
              }
            });
          assertCurrent();
        }
        const result = await runGlobalPackageUpdateSteps({
          installTarget,
          installSpec: archivePath,
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
