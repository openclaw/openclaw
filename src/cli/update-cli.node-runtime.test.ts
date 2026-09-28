import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import {
  commandCalls,
  doctorCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  gatewayCommandCall,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  spawnCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  candidateValidation,
  gatewayFixturePid,
  inferenceRepair,
  loadInstalledPluginIndexInstallRecords,
  nodeVersionSatisfiesEngine,
  readPackageVersion,
  resolveNodeRuntimeInfo,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceRestart,
  serviceStop,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  fetchNpmPackageTargetStatus,
  listUpdateRuns,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runPostCorePluginConvergenceSpy,
  updateCommand,
} from "./update-cli-modules.test-support.js";
import { mockPostCoreConvergenceOnce } from "./update-cli/update-cli-config.test-support.js";
import {
  packageTargetStatus,
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    createCaseDir,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockNpmPluginOutcomes,
    mockPackageInstallStatus,
    mockServicePackageCommands,
    primeNpmChannelTag,
    primeServiceCommand,
    setupServicePackageAtPrefix,
    tempDirs,
  } = createUpdateCliFixture();

  it.each(["nvm", "system"] as const)(
    "keeps the CLI and service reachable after a %s runtime recovery",
    async (manager) => {
      resolveNodeRuntimeInfo.mockResolvedValue(runtimeRecovery.unsupportedServiceRuntimeFixture);
      const { root, serviceNode, entrypoint } = await setupServicePackageAtPrefix({
        prefix: path.join(
          tempDirs.make("runtime-recovery-"),
          manager === "nvm" ? ".nvm/versions/node/v22.18.0" : "system",
        ),
        withNpm: false,
      });
      mockPackageInstallStatus(root);
      primeServiceCommand([serviceNode, entrypoint, "gateway"]);
      primeNpmChannelTag("latest", "2026.5.20");
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ target: "latest", version: "2026.5.20" }),
      );
      vi.mocked(runCommandWithTimeout).mockImplementation(
        runtimeRecovery.runtimeRecoveryCommandFixture(serviceNode),
      );
      nodeVersionSatisfiesEngine.mockReturnValue(false);

      await expect(updateCommand({ yes: true, restart: false, json: true })).rejects.toEqual(
        new ExitError(1),
      );

      expect(lastWriteJsonCall()).toMatchObject({
        reason: "node-runtime-preflight",
        failedStep: {
          recoverySteps: runtimeRecovery.expectedManagedRuntimeRecoverySteps(manager, root),
        },
      });
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expect(serviceStop).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(listUpdateRuns({ limit: 1 })[0]?.reason).toBe("node-runtime-preflight");
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        `openclaw@2026.5.20 requires Node >=22.19.0; selected runtime is Node 22.18.0 at ${serviceNode}.\nNode 22.18.0: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)\n${runtimeRecovery.expectedPlainRecovery("2026.5.20", "24.16.0", "refresh", undefined, root).replace("3. Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.", manager === "nvm" ? `3. Run \`${runtimeRecovery.expectedRuntimeSelectionCommand("nvm", "24.16.0")}\`.` : "3. Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.")}`,
      );
    },
  );

  it("runs same-root service follow-up commands with its selected Node despite heap argv", async () => {
    const servicePrefix = tempDirs.make("openclaw-service-prefix-");
    const {
      nodeModules,
      root: serviceRoot,
      serviceNode,
      serviceNpm,
      serviceNpmReal,
      entrypoint,
    } = await setupServicePackageAtPrefix({ prefix: servicePrefix });
    mockPackageInstallStatus(serviceRoot);
    primeServiceCommand([serviceNode, "--max-old-space-size=16384", entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.5.20");
    mockFileBackedPathExists();
    mockServicePackageCommands({
      nodeModules,
      packageRoot: serviceRoot,
      targetVersion: "2026.5.20",
      npmCommands: [serviceNpm, serviceNpmReal!],
      nodeVersions: { [serviceNode]: "v22.22.0" },
    });

    await updateCommand({ yes: true });

    expect(doctorCommandCall()?.[0][0]).toBe(serviceNode);
    expect(spawnCall()?.[0]).toBe(serviceNode);
    const serviceInstallCall = commandCalls().find(
      ([argv]) => argv[2] === "gateway" && argv[3] === "install",
    );
    expect(serviceInstallCall?.[0][0]).toBe(serviceNode);
  });

  it.each([
    { busyPackage: false, alreadyCurrent: false, wrongOriginal: false, overriddenOriginal: false },
    { busyPackage: true, alreadyCurrent: false, wrongOriginal: false, overriddenOriginal: false },
    { busyPackage: false, alreadyCurrent: true, wrongOriginal: false, overriddenOriginal: false },
    { busyPackage: false, alreadyCurrent: false, wrongOriginal: true, overriddenOriginal: false },
    { busyPackage: false, alreadyCurrent: false, wrongOriginal: false, overriddenOriginal: true },
  ])(
    "updates the invoking package and rebinds its owned Gateway after a Node-prefix switch (busy B=$busyPackage, current B=$alreadyCurrent, wrong A=$wrongOriginal, late override=$overriddenOriginal)",
    async ({ busyPackage, alreadyCurrent, wrongOriginal, overriddenOriginal }) => {
      const invokingVersion = alreadyCurrent ? "2026.5.20" : "2026.5.18";
      const oldInstall = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("openclaw-node-a-"),
      });
      const newInstall = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("openclaw-node-b-"),
        version: invokingVersion,
      });
      mockPackageInstallStatus(newInstall.root);
      readPackageVersion.mockImplementation(async (packageRoot: string) => {
        const manifest: { version: string } = JSON.parse(
          await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        );
        return manifest.version;
      });
      // A must be observed independently before B is activated.
      mockGatewayHealth(wrongOriginal ? "0.0.0" : "2026.5.18", "retained-node-A");
      // Canonical readers omit managedDefinition unless an operator override exists.
      const originalCommand = {
        programArguments: [oldInstall.serviceNode, oldInstall.entrypoint, "gateway"],
      };
      serviceReadCommand.mockResolvedValue(originalCommand);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      primeNpmChannelTag("latest", "2026.5.20");
      mockFileBackedPathExists();
      mockServicePackageCommands({
        nodeModules: newInstall.nodeModules,
        packageRoot: newInstall.root,
        targetVersion: "2026.5.20",
        npmCommands: ["npm", newInstall.serviceNpm, requireValue(newInstall.serviceNpmReal, "npm")],
        nodeVersions: { [oldInstall.serviceNode]: "v24.19.0" },
        onGatewayInstall: (argv) =>
          serviceReadCommand.mockResolvedValue({
            programArguments: [
              requireValue(argv[0], "Node"),
              requireValue(argv[1], "entrypoint"),
              "gateway",
            ],
          }),
      });

      const { createManagedHandoffLeaseStore } =
        await import("../infra/update-managed-service-handoff-lease.js");
      const store = createManagedHandoffLeaseStore();
      const installationKeys = [oldInstall.root, newInstall.root].map(resolveUpdateInstallRoot);
      if (busyPackage) {
        const incumbent = store.acquire(installationKeys[1]!, "different-profile", {
          kind: "update",
        });
        expect(incumbent.kind).toBe("acquired");
        if (incumbent.kind !== "acquired") {
          throw new Error("Fixture B owner missing");
        }
        await expect(updateCommand({ yes: true })).rejects.toThrow();
        expect(serviceStop).not.toHaveBeenCalled();
        expect(candidateValidation).not.toHaveBeenCalled();
        expect(
          JSON.parse(await fs.readFile(path.join(newInstall.root, "package.json"), "utf8")).version,
        ).toBe(invokingVersion);
        expect(store.current(incumbent.lease)).toBe(true);
        expect(store.release(incumbent.lease)).toBe(true);
        return;
      }
      const assertRootsOwned = () => {
        for (const admittedRoot of installationKeys) {
          expect(store.acquire(admittedRoot, "different-profile", { kind: "update" }).kind).toBe(
            "busy",
          );
        }
      };
      const validate = requireValue(
        candidateValidation.getMockImplementation(),
        "candidate validation",
      );
      candidateValidation.mockImplementation(async (...args) => {
        assertRootsOwned();
        if (overriddenOriginal) {
          // An override introduced after planning must still block unsafe rebind.
          serviceReadCommand.mockResolvedValue({
            ...originalCommand,
            managedDefinition: originalCommand,
            managedOverrides: { environment: true },
          });
        }
        return await validate(...args);
      });
      const rename = fs.rename;
      const publicationChecks: string[] = [];
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(from) === newInstall.root || String(to) === newInstall.root) {
          assertRootsOwned();
          publicationChecks.push(String(to));
        }
        return await rename(from, to);
      });
      if (wrongOriginal || overriddenOriginal) {
        await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
        expect(getLogOutput() + getErrorOutput()).toContain(
          overriddenOriginal ? "managed-service-preflight" : "original-service-unverified",
        );
        if (overriddenOriginal) {
          expect(getLogOutput() + getErrorOutput()).toContain(
            "Gateway service definition changed after database admission",
          );
        }
        expect(serviceStop).not.toHaveBeenCalled();
        expect(publicationChecks).toEqual([]);
        expect(freshRestartCalls()).toEqual([]);
        expect(
          JSON.parse(await fs.readFile(path.join(newInstall.root, "package.json"), "utf8")).version,
        ).toBe(invokingVersion);
        return;
      }
      await updateCommand({ yes: true }).catch((cause: unknown) => {
        throw new Error(getErrorOutput() + getLogOutput(), { cause });
      });
      expect(publicationChecks).toContain(newInstall.root);

      const installed = JSON.parse(
        await fs.readFile(path.join(newInstall.root, "package.json"), "utf8"),
      );
      const previous = JSON.parse(
        await fs.readFile(path.join(oldInstall.root, "package.json"), "utf8"),
      );
      expect(installed.version).toBe("2026.5.20");
      expect(previous.version).toBe("2026.5.18");
      const serviceInstall = commandCalls().find(
        ([argv]) => argv[2] === "gateway" && argv[3] === "install",
      );
      expect(serviceInstall?.[0].slice(0, 2)).toEqual([process.execPath, newInstall.entrypoint]);
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(getLogOutput()).toContain("Gateway: restarted and verified");
    },
  );

  it.each([
    { scenario: "different Node", command: "gateway", sameNode: false, selected: true },
    { scenario: "non-Gateway command", command: "agent", sameNode: false, selected: false },
    { scenario: "symlink to current Node", command: "gateway", sameNode: true, selected: false },
  ])(
    "plans service Node selection independently of database admission ($scenario)",
    async ({ command, sameNode, selected }) => {
      const root = createCaseDir("openclaw-same-root");
      const entrypoint = await writeOpenClawPackageFixture(root, "2026.5.18");
      let serviceNode = "/opt/other-node/bin/node";
      if (sameNode) {
        const nodeAliasDir = path.join(root, "node-bin");
        await fs.symlink(
          path.dirname(process.execPath),
          nodeAliasDir,
          process.platform === "win32" ? "junction" : "dir",
        );
        serviceNode = path.join(nodeAliasDir, path.basename(process.execPath));
      }
      mockPackageInstallStatus(root);
      primeServiceCommand([serviceNode, "--import", "tsx", entrypoint, command]);

      await updateCommand({ dryRun: true });
      if (command !== "gateway") {
        expect(getLogOutput()).toContain("Restart the Gateway you launched manually");
      }

      expect(serviceReadCommand).toHaveBeenCalledTimes(2);
      const logs = getLogOutput();
      expect(logs).not.toContain("Targeting managed gateway service package root");
      if (selected) {
        expect(logs).toContain("differs from the managed gateway service Node");
        expect(logs).toContain(serviceNode);
        expect(logs).toContain(
          "Using the managed service Node for this update so the gateway can start after the upgrade",
        );
      } else {
        expect(logs).not.toContain("differs from the managed gateway service Node");
        expect(logs).not.toContain(serviceNode);
      }
    },
  );

  it.each([
    { fallback: false, restart: true, writable: true, refreshFails: false },
    { fallback: true, restart: true, writable: true, refreshFails: false },
    { fallback: true, restart: false, writable: true, refreshFails: false },
    { fallback: true, restart: true, writable: false, refreshFails: false },
    { fallback: true, restart: true, writable: true, refreshFails: true },
  ])(
    "admits managed Node before already-current plugin maintenance ($fallback, restart=$restart, writable=$writable, refreshFails=$refreshFails)",
    async ({ fallback, restart, writable, refreshFails }) => {
      const servicePrefix = tempDirs.make("openclaw-current-runtime-");
      const { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint } =
        await setupServicePackageAtPrefix({ prefix: servicePrefix, version: VERSION });
      mockPackageInstallStatus(root);
      readPackageVersion.mockResolvedValue(VERSION);
      primeServiceCommand([serviceNode, entrypoint, "gateway"]);
      serviceLoaded.mockResolvedValue(true);
      if (!writable) {
        serviceDefinitionMutationCapability.mockResolvedValue({
          kind: "sealed",
          detail: "test service owner",
        });
      }
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      primeNpmChannelTag("latest", VERSION);
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: VERSION, nodeEngine: ">=24.16.0 <25 || >=26.1.0" }),
      );
      nodeVersionSatisfiesEngine.mockImplementation(
        (version) => fallback && version === process.versions.node,
      );
      resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => {
        const oldRuntime = nodePath === serviceNode;
        return {
          status: oldRuntime ? "unsupported" : "supported",
          version: oldRuntime ? "22.23.1" : process.versions.node,
          sqliteVersion: "3.51.3",
          nodeSharedSqlite: false,
          sqliteProbe: {
            available: true,
            version: "3.51.3",
            text: !oldRuntime,
            blob: true,
            json: true,
          },
          ...(oldRuntime ? { capabilityError: "broken TEXT decoder" } : {}),
        };
      });
      mockFileBackedPathExists();
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset();
      mockServicePackageCommands({
        nodeModules,
        packageRoot: root,
        targetVersion: VERSION,
        npmCommands: [serviceNpm, serviceNpmReal!],
        nodeVersions: {
          [serviceNode]: "v22.23.1",
          [process.execPath]: `v${process.versions.node}`,
        },
      });
      const fixtureCommand = requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "runtime fixture command",
      );
      vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "gateway" && argv[3] === "install") {
          if (refreshFails) {
            return commandResult({ code: 1, stderr: "runtime refresh failed" });
          }
          primeServiceCommand([argv[0], entrypoint, "gateway"]);
        }
        return fixtureCommand(argv, options);
      });
      const installPath = createCaseDir("current-runtime-plugin");
      await fs.mkdir(installPath, { recursive: true });
      await writeJsonFixture(path.join(installPath, "package.json"), {
        name: "@openclaw/brave-plugin",
        version: "2026.9.2",
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/brave-plugin",
        installPath,
        version: "2026.9.2",
      };
      loadInstalledPluginIndexInstallRecords.mockResolvedValue({ brave: record });
      const updated = { ...record, version: "2026.9.3" };
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "brave",
            status: "updated",
            currentVersion: "2026.9.2",
            nextVersion: "2026.9.3",
            message: "Updated brave.",
          },
        ],
        true,
        { ...baseConfig, plugins: { ...baseConfig.plugins, installs: { brave: updated } } },
      );
      mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
        installRecords: { brave: updated },
      });

      if (!fallback || !restart || !writable) {
        await expect(updateCommand({ yes: true, restart, json: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "node-runtime-preflight",
        });
        expect(getErrorOutput()).toBe(
          `openclaw@${VERSION} requires Node >=24.16.0 <25 || >=26.1.0; selected runtime is Node 22.23.1 at ${serviceNode}.\nbroken TEXT decoder\n${runtimeRecovery.expectedPlainRecovery(VERSION, "24.16.0", writable ? "refresh" : "owner", "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR", root, writable ? undefined : serviceNode)}`,
        );
        expectNoSideEffects(
          updateNpmInstalledPlugins,
          syncPluginsForUpdateChannel,
          serviceStop,
          serviceRestart,
        );
      } else if (refreshFails) {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "service-runtime-refresh-failed",
          run: { status: "failed" },
        });
        expect(inferenceRepair).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toHaveLength(0);
        expect(serviceRestart).not.toHaveBeenCalled();
        expect((await serviceReadCommand(process.env))?.programArguments[0]).toBe(serviceNode);
      } else {
        await updateCommand({ yes: true, json: true });
        expect(lastWriteJsonCall()).toMatchObject({
          status: "ok",
          postUpdate: { plugins: { changed: true } },
        });
        const install = gatewayCommandCall(entrypoint, "install");
        expect(install?.[0][0]).toBe(process.execPath);
        expect((await serviceReadCommand(process.env))?.programArguments[0]).toBe(process.execPath);
        expect(serviceStop).toHaveBeenCalledOnce();
        expect(freshRestartCalls()).toHaveLength(0);
      }
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("refreshes the managed service to current Node when its baked Node cannot run the target", async () => {
    const servicePrefix = tempDirs.make("openclaw-service-prefix-");
    const { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint } =
      await setupServicePackageAtPrefix({ prefix: servicePrefix });
    // Same package root for both shell and service.
    mockPackageInstallStatus(root);
    primeServiceCommand([serviceNode, entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.7.1");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({
        target: "latest",
        version: "2026.7.1",
        nodeEngine: ">=24.15.0 <25",
      }),
    );
    nodeVersionSatisfiesEngine.mockImplementation(
      (version: string | null) => version === "24.15.0",
    );
    resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => {
      const version =
        nodePath === serviceNode ? "24.14.0" : nodePath === process.execPath ? "24.15.0" : null;
      if (!version) {
        throw new Error("Unexpected runtime probe target");
      }
      return {
        status: "supported",
        version,
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      };
    });
    mockFileBackedPathExists();
    mockServicePackageCommands({
      nodeModules,
      packageRoot: root,
      targetVersion: "2026.7.1",
      npmCommands: [serviceNpm, serviceNpmReal!],
      nodeVersions: { [serviceNode]: "v24.14.0", [process.execPath]: "v24.15.0" },
    });

    await updateCommand({ yes: true });

    const logs = getLogOutput();
    expect(logs).toContain(`Managed gateway service Node (${serviceNode}) cannot run`);
    expect(logs).toContain(`Using compatible Node (${process.execPath})`);
  });

  it("pins package install to the service root when nodes differ and no owning npm exists at the prefix", async () => {
    const servicePrefix = tempDirs.make("openclaw-no-npm-prefix-");
    // Create the node binary but intentionally do NOT create <prefix>/bin/npm
    // so resolvePreferredNpmCommand returns null and the PATH npm is used.
    const { root, serviceNode, entrypoint } = await setupServicePackageAtPrefix({
      prefix: servicePrefix,
      withNpm: false,
    });
    // No npm binary at servicePrefix/bin/npm!
    mockPackageInstallStatus(root);
    primeServiceCommand([serviceNode, entrypoint, "gateway"]);
    serviceLoaded.mockResolvedValue(true);
    primeNpmChannelTag("latest", "2026.5.20");
    mockFileBackedPathExists();
    // The PATH npm returns a DIFFERENT global root (simulates Node-B's npm).
    // PATH npm returns Node-B's root, NOT the service root.
    // Install step: create the expected package structure at the target.
    const nodeBGlobalRoot = path.join(tempDirs.make("node-b-global-"), "lib", "node_modules");
    await fs.mkdir(nodeBGlobalRoot, { recursive: true });
    mockServicePackageCommands({
      nodeModules: nodeBGlobalRoot,
      packageRoot: root,
      targetVersion: "2026.5.20",
      npmCommands: ["npm"],
      nodeVersions: { [serviceNode]: "v24.14.0" },
    });

    await updateCommand({ yes: true });

    // The install command must use --prefix pointing to a location within
    // the service root's prefix tree, NOT Node-B's global root.
    const installCall = packageInstallCommandCall();
    expect(installCall).toBeDefined();
    const installArgv = installCall![0];
    const prefixIdx = installArgv.indexOf("--prefix");
    expect(prefixIdx).toBeGreaterThan(-1);
    // Staging prefix should be under the service prefix, not Node-B's.
    expect(installArgv[prefixIdx + 1]).toContain(servicePrefix);
    expect(installArgv[prefixIdx + 1]).not.toContain(nodeBGlobalRoot);
    // Follow-up commands use the service node.
    expect(doctorCommandCall()?.[0][0]).toBe(serviceNode);
  });
});
