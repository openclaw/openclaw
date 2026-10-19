import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  PLUGIN_INSTALL_ERROR_CODE,
} from "./install.js";
import {
  configWithInstalledPackageTreeBlockPolicy,
  createInstalledPackageTreePolicyExec,
  installNpmPlugin,
  installProjectDependencies,
  registerNpmPayloadIdentityTests,
} from "./install.npm-spec.test-support.js";
import { runPluginPayloadSmokeCheck } from "./payload-verification.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";
import {
  packPlugins,
  registryPackages,
  startStaticRegistry,
  startMutableRegistry,
  type RegistryPackage,
} from "./test-helpers/npm-registry-fixtures.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";

const tempDirs = createTempDirTracker();
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

async function makeInstallFixture(label: string) {
  const rootDir = tempDirs.make(`openclaw-${label}-`);
  const userconfig = path.join(rootDir, "empty.npmrc");
  const globalconfig = path.join(rootDir, "global.npmrc");
  await Promise.all([fs.writeFile(userconfig, ""), fs.writeFile(globalconfig, "")]);
  // These cases exercise npm installs, not discovery of the operator's npm policies.
  for (const [key, value] of Object.entries({
    userconfig,
    globalconfig,
    cache: path.join(rootDir, "pack-cache"),
    allow_git: "all",
    allow_remote: "all",
  })) {
    vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, value);
    vi.stubEnv(`npm_config_${key}`, value);
  }
  const npmRoot = path.join(rootDir, "managed-npm");
  const install = (spec: string, options: Partial<Parameters<typeof installNpmPlugin>[0]> = {}) =>
    installNpmPlugin({ spec, npmRoot, ...options });
  return {
    rootDir,
    npmRoot,
    register: (packages: Parameters<typeof registryPackages>[1]) =>
      registryPackages(rootDir, packages).then(useStaticRegistry),
    install,
    installOk: async (spec: string) => requireInstalled(await install(spec)),
  };
}

function uniquePackageName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function requireInstalled(result: Awaited<ReturnType<typeof installNpmPlugin>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

type DelegatedObservation = {
  exitCode: number;
  authorityClosed: boolean;
  error: string;
  configUnchanged: boolean;
  pluginInstalls: Record<string, unknown>;
  hookInstalls: Record<string, unknown>;
  npmPayloads: string[];
  hookPayload: boolean;
};

type ProjectManifest = {
  version?: string;
  dependencies?: Record<string, string>;
  openclaw?: { managedPeerDependencies?: string[] };
};
function readProjectManifest(projectRoot: string) {
  return readJson<ProjectManifest>(path.join(projectRoot, "package.json"));
}
function expectPackagePresent(projectRoot: string, name: string) {
  return expect(
    fs.lstat(path.join(projectRoot, "node_modules", name, "package.json")),
  ).resolves.toBeTruthy();
}
function expectPackageAbsent(projectRoot: string, name: string) {
  return expect(
    fs.lstat(path.join(projectRoot, "node_modules", name, "package.json")),
  ).rejects.toHaveProperty("code", "ENOENT");
}

function pluginNpmProjectRoot(npmRoot: string, packageName: string): string {
  return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
}

async function useStaticRegistry(packages: RegistryPackage[]): Promise<string> {
  const registry = await startStaticRegistry(packages, servers);
  useRegistry(registry);
  return registry;
}

function useRegistry(registry: string): void {
  vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
  vi.stubEnv("npm_config_registry", registry);
}

describe("installPluginFromNpmSpec e2e", () => {
  registerNpmPayloadIdentityTests({ makeInstallFixture, uniquePackageName, useStaticRegistry });

  it.each(["npm", "npm-pack"] as const)(
    "preserves a real %s successor when an earlier lifecycle lease has closed",
    { timeout: 120_000 },
    async (source) => {
      const { rootDir, npmRoot } = await makeInstallFixture("npm-rollback-owner-e2e");
      const packageName = uniquePackageName("rollback-owner");
      const versions = await packPlugins(rootDir, [
        { packageName, version: "1.0.0" },
        { packageName, version: "2.0.0" },
      ]);
      await useStaticRegistry([{ packageName, latest: "2.0.0", versions }]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
      const install = (version: string, deferCommit = false, cancelBeforePublish = false) =>
        withPluginLifecycleLease({ env }, async (lease) => {
          let callerActive = true;
          const params = requestDeferredPluginInstall(
            {
              npmDir: npmRoot,
              mode: "update" as const,
              timeoutMs: 120_000,
              beforePersistentApply: () => {
                if (!callerActive) {
                  throw new Error("caller authority closed");
                }
              },
              onBeforePluginArtifactCommit: async () => {
                lease.assertOwned();
                callerActive = !cancelBeforePublish;
              },
            },
            undefined,
            () => lease.assertOwned(),
          );
          const result =
            source === "npm"
              ? await installPluginFromNpmSpec({ ...params, spec: `${packageName}@${version}` })
              : await installPluginFromNpmPackArchive({
                  ...params,
                  archivePath: path.join(rootDir, `${packageName}-${version}.tgz`),
                });
          if (!result.ok) {
            throw new Error(result.error);
          }
          const transaction = resolvePluginInstallTransaction(result);
          if (!transaction) {
            throw new Error("expected deferred npm install");
          }
          if (!deferCommit) {
            await transaction.commit();
          }
          return { result, transaction };
        });

      await install("1.0.0");
      const older = await install("2.0.0", true);
      const successor = await install("2.0.0");
      expect(successor.result.targetDir).toBe(older.result.targetDir);
      const projectRoot = path.dirname(path.dirname(successor.result.targetDir));
      const manifestPath = path.join(projectRoot, "package.json");
      const protectedFiles = [
        manifestPath,
        path.join(projectRoot, "package-lock.json"),
        path.join(successor.result.targetDir, "dist", "index.js"),
      ];
      if (source === "npm-pack") {
        const manifest = await readJson<{ dependencies: Record<string, string> }>(manifestPath);
        const dependencySpec = manifest.dependencies[packageName];
        if (!dependencySpec?.startsWith("file:")) {
          throw new Error("expected a managed npm-pack file dependency");
        }
        protectedFiles.push(path.resolve(projectRoot, dependencySpec.slice("file:".length)));
      }
      const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));

      const rollbackError = await older.transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect.soft(rollbackError).toHaveProperty("code", "OPENCLAW_STATE_LEASE_LOST");
      const after = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
      expect(after).toEqual(before);

      await expect(install("2.0.0", false, true)).rejects.toThrow("caller authority closed");
      expect(await Promise.all(protectedFiles.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it("relocates a bundled plugin through real npm only after artifact consent", async () => {
    const { rootDir, npmRoot, register } = await makeInstallFixture("relocation-e2e");
    const packageName = uniquePackageName("relocated-plugin");
    await register([{ packageName }]);
    const bundledPath = path.join(rootDir, "old", "extensions", packageName);
    const config: OpenClawConfig = {
      plugins: {
        entries: { [packageName]: { enabled: true } },
        load: { paths: [bundledPath] },
        installs: {
          [packageName]: { source: "path", sourcePath: bundledPath, installPath: bundledPath },
        },
      },
    };
    const roots = {
      npmDir: npmRoot,
      extensionsDir: path.join(rootDir, "extensions"),
      gitDir: path.join(rootDir, "git"),
      stateDir: path.join(rootDir, "state"),
    };
    const sync = (accept: boolean) =>
      withPluginInstallRoots(roots, () =>
        syncPluginsForUpdateChannel({
          config,
          channel: "stable",
          env: { ...process.env, OPENCLAW_STATE_DIR: roots.stateDir },
          externalizedBundledPluginBridges: [
            { bundledPluginId: packageName, npmSpec: packageName },
          ],
          ...(accept
            ? {
                onCapabilityConsent: async (details: { reviewToken: string }) => ({
                  reviewToken: details.reviewToken,
                }),
              }
            : {}),
        }),
      );
    const refused = await sync(false);
    expect(refused.config).toEqual(config);
    expect(refused.summary.errors).toEqual([
      expect.objectContaining({
        pluginId: packageName,
        code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
      }),
    ]);
    expect(refused.summary.errors[0]?.message).toContain(
      "did not install the replacement plugin payload",
    );
    expect(refused.summary.errors[0]?.message).not.toContain("payload is missing");
    const projectDir = pluginNpmProjectRoot(npmRoot, packageName);
    await expect(fs.access(projectDir)).rejects.toHaveProperty("code", "ENOENT");
    const accepted = await sync(true);
    expect(accepted.summary.errors).toEqual([]);
    expect(accepted.config.plugins?.load?.paths).toEqual([]);
    expect(accepted.config.plugins?.installs?.[packageName]?.source).toBe("npm");
    expect(
      await runPluginPayloadSmokeCheck({
        records: accepted.config.plugins?.installs ?? {},
        env: process.env,
      }),
    ).toEqual({ checked: [packageName], failures: [] });
  }, 120_000);

  it.each(["plugin", "hook pack"] as const)(
    "does not persist an npm %s when delegated authority closes during download",
    { timeout: 180_000 },
    async (kind) => {
      const { rootDir } = await makeInstallFixture("npm-delegated-install-e2e");
      const packageName = uniquePackageName("delegated-install");
      const downloadBarrier = { requested: createDeferred(), released: createDeferred() };
      const registry = await startStaticRegistry(
        await registryPackages(rootDir, [
          {
            packageName,
            ...(kind === "hook pack" ? { hookName: "cancel-test-hook" } : {}),
          },
        ]),
        servers,
        downloadBarrier,
      );
      const stateDir = path.join(rootDir, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const reportPath = path.join(rootDir, "install-result.json");
      // Reuse compiled modules while keeping the hook payload owner's state in a fresh process.
      const installCommandUrl = resolveRuntimeWorkerUrl(
        pluginProcessRuntimeEntrypoints.installCommand,
      );
      const script = `
        import { existsSync } from "node:fs";
        import fs from "node:fs/promises";
        import path from "node:path";
        import { randomUUID } from "node:crypto";
        import { runPluginInstallCommand } from ${JSON.stringify(installCommandUrl.href)};
        import { writeConfigFile } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.config).href)};
        import { readHookInstalls } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.hookInstalls).href)};
        import { readPersistedInstalledPluginIndexInstallRecordsAsync } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.installedPluginRecords).href)};
        import {
          claimAgentRunDelegatedAuthority,
          releaseAgentRunDelegatedAuthority,
          validateAgentRunDelegatedAuthority,
        } from ${JSON.stringify(resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.delegatedAuthority).href)};
        const [packageName, registry, reportPath] = JSON.parse(process.argv[1]);
        await writeConfigFile({});
        const configBefore = await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8");
        const observations = {};
        for (const stage of ["cancelled", "active"]) {
          const authority = claimAgentRunDelegatedAuthority(Object.freeze({
            instanceId: randomUUID(), runId: randomUUID(),
          }));
          const errors = [];
          let exitCode = 0;
          let authorityClosed = false;
          const cancellationAbort = new AbortController();
          const cancellation = stage === "cancelled"
            ? (async () => {
                await fetch(registry + "/-/test/authority-close", {
                  signal: cancellationAbort.signal,
                }).then((response) => response.text());
                authorityClosed = releaseAgentRunDelegatedAuthority(authority)
                  && !validateAgentRunDelegatedAuthority(authority);
                if (!authorityClosed) throw new Error("Failed to close delegated authority");
                await fetch(registry + "/-/test/authority-closed").then((response) => response.text());
              })().catch((error) => errors.push(String(error)))
            : Promise.resolve();
          try {
            await runPluginInstallCommand({
              raw: "npm:" + packageName + "@1.0.0",
              opts: { force: true, acceptCapabilities: true },
              allowInstallPolicyWarningPrompt: false,
              beforePersistentApply: () => {
                if (!validateAgentRunDelegatedAuthority(authority)) {
                  throw new Error("Delegated install authority closed");
                }
              },
              runtime: {
                log() {},
                error: (...args) => errors.push(args.join(" ")),
                exit: (code) => { exitCode = code; },
              },
            });
          } catch (error) {
            exitCode = 1;
            errors.push(String(error));
          }
          cancellationAbort.abort();
          await cancellation;
          const npmEntries = await fs.readdir(path.join(process.env.OPENCLAW_STATE_DIR, "npm"), {
            recursive: true,
          }).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          observations[stage] = {
            exitCode, authorityClosed, error: errors.join("\\n"),
            configUnchanged: configBefore === await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"),
            pluginInstalls: (await readPersistedInstalledPluginIndexInstallRecordsAsync()) ?? {},
            hookInstalls: readHookInstalls(),
            npmPayloads: npmEntries.filter((entry) => entry.endsWith(path.join("node_modules", packageName))),
            hookPayload: existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "hooks", packageName)),
          };
          releaseAgentRunDelegatedAuthority(authority);
        }
        await fs.writeFile(reportPath, JSON.stringify(observations));
      `;
      try {
        const result = await runNodeScript(
          (workerArgv) => [
            ...workerArgv(installCommandUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            script,
            JSON.stringify([packageName, registry, reportPath]),
          ],
          {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_HOME: rootDir,
            OPENCLAW_AGENT_DIR: undefined,
            NPM_CONFIG_REGISTRY: registry,
            npm_config_registry: registry,
            // npm pack seeds its cache; cancellation must observe a real tarball download.
            NPM_CONFIG_CACHE: path.join(rootDir, "npm-cache"),
            npm_config_cache: path.join(rootDir, "npm-cache"),
          },
          150_000,
          { maxBuffer: 64 * 1024, requireProcessTreeExit: true },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const observations =
          await readJson<Record<"cancelled" | "active", DelegatedObservation>>(reportPath);
        expect(observations.cancelled.error).toContain("Delegated install authority closed");
        expect(observations.cancelled).toMatchObject({
          exitCode: 1,
          authorityClosed: true,
          configUnchanged: true,
          npmPayloads: [],
          hookPayload: false,
        });
        expect(observations.cancelled.pluginInstalls).toEqual({});
        expect(observations.cancelled.hookInstalls).toEqual({});
        // The same artifact still installs under a fresh live claim; rejection is not a broken fixture.
        expect(observations.active.exitCode, observations.active.error).toBe(0);
        expect(observations.active.configUnchanged).toBe(false);
        if (kind === "plugin") {
          expect(Object.keys(observations.active.pluginInstalls)).toEqual([packageName]);
          expect(observations.active.npmPayloads).toHaveLength(1);
        } else {
          expect(Object.keys(observations.active.hookInstalls)).toEqual([packageName]);
          expect(observations.active.hookPayload).toBe(true);
        }
      } finally {
        downloadBarrier.requested.resolve();
        downloadBarrier.released.resolve();
      }
    },
  );

  it.each([
    ["compatible", "2026.5.26", "2026.5.27"],
    ["mutable", "1.0.0", "2.0.0"],
  ] as const)(
    "installs the selected %s version %s, not %s",
    async (selection, selected, latest) => {
      const { rootDir, npmRoot } = await makeInstallFixture("npm-version-selection-e2e");
      const packageName = uniquePackageName("selected-version");
      const compatible = selection === "compatible";
      const packageVersion = (version: string, pluginApi: string) => ({
        packageName,
        version,
        ...(compatible
          ? {
              openclaw: {
                extensions: ["./dist/index.js"],
                install: { minHostVersion: ">=2026.4.25" },
                compat: { pluginApi },
              },
            }
          : {}),
      });
      const versions = await packPlugins(rootDir, [
        packageVersion(selected, ">=2026.5.10-beta.1"),
        packageVersion(latest, ">=2026.5.27"),
      ]);
      if (compatible) {
        await useStaticRegistry([{ packageName, latest, versions }]);
        vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.5.10-beta.1");
      } else {
        useRegistry(
          await startMutableRegistry(
            { packageName, initialLatest: selected, laterLatest: latest, versions },
            servers,
          ),
        );
      }
      const warnings: string[] = [];
      const result = requireInstalled(
        await installPluginFromNpmSpec({
          spec: compatible ? packageName : packageName + "@latest",
          npmDir: npmRoot,
          logger: { info: () => {}, warn: (message) => warnings.push(message) },
          ...(compatible ? {} : { timeoutMs: 120_000 }),
        }),
      );
      expect(result.npmResolution?.version).toBe(selected);
      const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
      const payloadDir = compatible
        ? path.join(projectRoot, "node_modules", packageName)
        : result.targetDir;
      expect((await readProjectManifest(payloadDir)).version).toBe(selected);
      if (compatible) {
        expect(result.npmResolution?.resolvedSpec).toBe(packageName + "@" + selected);
        expect(warnings.join("\n")).toContain(
          "using newest compatible " + packageName + "@" + selected,
        );
      } else {
        expect((await readProjectManifest(projectRoot)).dependencies?.[packageName]).toBe(selected);
        const lock = await readJson<{
          packages?: Record<string, { integrity?: string; version?: string }>;
        }>(path.join(projectRoot, "package-lock.json"));
        expect(lock.packages?.["node_modules/" + packageName]).toMatchObject({
          integrity: versions[0]?.integrity,
          version: selected,
        });
      }
    },
  );

  it("keeps third-party peer dependencies in the owning npm project across later installs", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-third-party-peer-e2e");
    const pluginWithRuntimePeer = uniquePackageName("runtime-peer-plugin");
    const laterPlugin = uniquePackageName("later-plugin");
    const runtimePeer = uniquePackageName("runtime-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: pluginWithRuntimePeer,
          peerDependencies: { [runtimePeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
        { packageName: laterPlugin },
        { packageName: runtimePeer },
      ]),
    );

    const first = await installNpmPlugin({
      spec: `${pluginWithRuntimePeer}@1.0.0`,
      npmRoot,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const firstProjectRoot = pluginNpmProjectRoot(npmRoot, pluginWithRuntimePeer);
    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();

    const second = await installNpmPlugin({
      spec: `${laterPlugin}@1.0.0`,
      npmRoot,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();
  });

  it("plans peers from installed optional dependencies", async () => {
    const { npmRoot, register, installOk } = await makeInstallFixture(
      "npm-plugin-optional-peer-e2e",
    );
    const owner = uniquePackageName("optional-owner-plugin");
    const dependency = uniquePackageName("optional-dep");
    const peer = uniquePackageName("optional-peer");
    await register([
      { packageName: owner, optionalDependencies: { [dependency]: "1.0.0" } },
      { packageName: dependency, peerDependencies: { [peer]: "^1.0.0" }, peerDependenciesMeta: {} },
      { packageName: peer },
    ]);

    await installOk(`${owner}@1.0.0`);

    const projectRoot = pluginNpmProjectRoot(npmRoot, owner);
    await expectPackagePresent(projectRoot, dependency);
    await expectPackagePresent(projectRoot, peer);
    const rootManifest = await readProjectManifest(projectRoot);
    expect(["1.0.0", "^1.0.0"]).toContain(rootManifest.dependencies?.[peer]);
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).toContain(peer);
  });

  it("does not take ownership of an existing root dependency observed as a peer", async () => {
    const { rootDir, npmRoot, register, install } = await makeInstallFixture(
      "npm-plugin-peer-existing-root-e2e",
    );
    const policyExec = await createInstalledPackageTreePolicyExec(rootDir);
    const existing = uniquePackageName("existing-root");
    const blocked = uniquePackageName("blocked-plugin");
    const peer = uniquePackageName("runtime-peer");
    await register([
      { packageName: existing },
      {
        indexJs: "eval('1');\n",
        packageName: blocked,
        peerDependencies: { [existing]: "^1.0.0", [peer]: "^1.0.0" },
        peerDependenciesMeta: {},
      },
      { packageName: peer },
    ]);

    const projectRoot = pluginNpmProjectRoot(npmRoot, blocked);
    await installProjectDependencies(projectRoot, {
      [existing]: "1.0.0",
    });

    const result = await install(`${blocked}@1.0.0`, {
      config: configWithInstalledPackageTreeBlockPolicy(policyExec),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED);
      expect(result.error).toContain("Install blocked by policy");
      expect(result.error).toContain("Reason: blocked installed package tree");
    }
    const rootManifest = await readProjectManifest(projectRoot);
    expect([existing, blocked, peer].map((name) => rootManifest.dependencies?.[name])).toEqual([
      "1.0.0",
      undefined,
      undefined,
    ]);
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(existing);
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(peer);
    await expectPackagePresent(projectRoot, existing);
    await expectPackageAbsent(projectRoot, blocked);
    await expectPackageAbsent(projectRoot, peer);
  });

  it("keeps an earlier isolated openclaw peer link after later plugin installs", async () => {
    const { npmRoot, register, installOk } = await makeInstallFixture("npm-plugin-peer-e2e");
    const firstPackage = uniquePackageName("peer-plugin");
    const secondPackage = uniquePackageName("later-plugin");
    await register([
      { packageName: firstPackage, peerDependencies: { openclaw: ">=2026.0.0" } },
      { packageName: secondPackage },
    ]);

    const first = await installOk(`${firstPackage}@1.0.0`);
    const hostLink = path.join(first.targetDir, "node_modules", "openclaw");
    await expect(fs.lstat(hostLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);

    await installOk(`${secondPackage}@1.0.0`);

    await expect(fs.lstat(hostLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    const projectRoot = pluginNpmProjectRoot(npmRoot, firstPackage);
    const manifest = await readProjectManifest(projectRoot);
    expect(manifest.dependencies?.openclaw).toBeUndefined();
    const lock = await readJson<{
      packages?: Record<string, unknown>;
    }>(path.join(projectRoot, "package-lock.json"));
    expect(lock.packages?.["node_modules/openclaw"]).toBeUndefined();
  });

  it("rejects a trusted pin when a real registry omits dist.integrity", async () => {
    const { npmRoot, register, install } = await makeInstallFixture(
      "missing-registry-integrity-e2e",
    );
    const packageName = uniquePackageName("missing-registry-integrity-plugin");
    await register([{ packageName, omitIntegrity: true }]);

    const result = await install(`${packageName}@1.0.0`, {
      expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    });

    expect(result).toEqual({
      ok: false,
      error: `aborted: npm package integrity missing for ${packageName}@1.0.0`,
    });
    await expect(fs.access(pluginNpmProjectRoot(npmRoot, packageName))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
});
