import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import * as proof from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import { mockPostCoreConvergenceOnce } from "./update-cli/update-cli-config.test-support.js";
import {
  packageTargetStatus,
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const setup = createUpdateCliFixture();
  const { updateCommand, ExitError } = modules;
  const { requireValue } = proof;
  const runtimeInfo = (version: string, text = true) => ({
    status: "supported" as const,
    version,
    sqliteVersion: "3.51.3",
    nodeSharedSqlite: false,
    sqliteProbe: { available: true, version: "3.51.3", text, blob: true, json: true },
  });

  beforeEach(() => runtimeRecovery.stubNodeRuntime());

  it("updates the invoking package and rebinds its owned Gateway after a Node-prefix switch", async () => {
    expect((await migrateDaemonRuntimePins(process.env)).warnings).toEqual([]);
    const invokingVersion = "2026.5.18";
    const oldInstall = await setup.setupServicePackageAtPrefix({
      prefix: setup.tempDirs.make("openclaw-node-a-"),
    });
    const newInstall = await setup.setupServicePackageAtPrefix({
      prefix: setup.tempDirs.make("openclaw-node-b-"),
      version: invokingVersion,
    });
    setup.mockPackageInstallStatus(newInstall.root);
    mocks.readPackageVersion.mockImplementation(async (packageRoot: string) => {
      const manifest: { version: string } = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      return manifest.version;
    });
    // A must be observed independently before B is activated.
    setup.mockGatewayHealth("2026.5.18", "retained-node-A");
    // Canonical readers omit managedDefinition unless an operator override exists.
    const originalCommand = {
      programArguments: [oldInstall.serviceNode, oldInstall.entrypoint, "gateway"],
    };
    mocks.serviceReadCommand.mockResolvedValue(originalCommand);
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: mocks.gatewayFixturePid,
      state: "running",
    });
    setup.primeNpmChannelTag("latest", "2026.5.20");
    setup.mockFileBackedPathExists();
    setup.mockServicePackageCommands({
      nodeModules: newInstall.nodeModules,
      packageRoot: newInstall.root,
      targetVersion: "2026.5.20",
      npmCommands: ["npm", newInstall.serviceNpm, requireValue(newInstall.serviceNpmReal, "npm")],
      nodeVersions: { [oldInstall.serviceNode]: "v24.19.0" },
      onGatewayInstall: (argv) =>
        mocks.serviceReadCommand.mockResolvedValue({
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
    const assertRootsOwned = () => {
      for (const admittedRoot of installationKeys) {
        expect(store.acquire(admittedRoot, "different-profile", { kind: "update" }).kind).toBe(
          "busy",
        );
      }
    };
    const validate = requireValue(
      mocks.candidateValidation.getMockImplementation(),
      "candidate validation",
    );
    mocks.candidateValidation.mockImplementation(async (...args) => {
      assertRootsOwned();
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
    await updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(proof.getErrorOutput() + proof.getLogOutput(), { cause });
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
    const serviceInstall = proof
      .commandCalls()
      .find(([argv]) => argv[2] === "gateway" && argv[3] === "install");
    expect(serviceInstall?.[0].slice(0, 2)).toEqual([
      oldInstall.serviceNode,
      newInstall.entrypoint,
    ]);
    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(proof.getLogOutput()).toContain("Gateway: restarted and verified");
  });

  it.each([
    { scenario: "different Node", command: "gateway", selected: true },
    { scenario: "non-Gateway command", command: "agent", selected: false },
  ])(
    "plans service Node selection independently of database admission ($scenario)",
    async ({ command, selected }) => {
      const root = setup.createCaseDir("openclaw-same-root");
      const entrypoint = await writeOpenClawPackageFixture(root, "2026.5.18");
      const serviceNode = "/opt/other-node/bin/node";
      setup.mockPackageInstallStatus(root);
      setup.primeServiceCommand([serviceNode, "--import", "tsx", entrypoint, command]);

      await updateCommand({ dryRun: true });
      if (command !== "gateway") {
        expect(proof.getLogOutput()).toContain("Stop the Gateway through its owner");
      }

      expect(mocks.serviceReadCommand).toHaveBeenCalledTimes(2);
      const logs = proof.getLogOutput();
      expect(logs).not.toContain("Targeting managed gateway service package root");
      if (selected) {
        expect(logs).toContain("differs from the managed gateway service runtime");
        expect(logs).toContain(serviceNode);
        expect(logs).toContain(
          "Using the managed service runtime for this update so the gateway can start after the upgrade",
        );
      } else {
        expect(logs).not.toContain("differs from the managed gateway service runtime");
        expect(logs).not.toContain(serviceNode);
      }
    },
  );

  it.each([
    { fallback: false, writable: true, refreshFails: false },
    { fallback: true, writable: false, refreshFails: false },
    { fallback: true, writable: true, refreshFails: true },
  ])(
    "admits managed Node before already-current plugin maintenance ($fallback, writable=$writable, refreshFails=$refreshFails)",
    async ({ fallback, writable, refreshFails }) => {
      const servicePrefix = setup.tempDirs.make("openclaw-current-runtime-");
      const { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint } =
        await setup.setupServicePackageAtPrefix({ prefix: servicePrefix, version: VERSION });
      setup.mockPackageInstallStatus(root);
      mocks.readPackageVersion.mockResolvedValue(VERSION);
      setup.primeServiceCommand([serviceNode, entrypoint, "gateway"]);
      mocks.serviceLoaded.mockResolvedValue(true);
      if (!writable) {
        mocks.serviceDefinitionMutationCapability.mockResolvedValue({
          kind: "sealed",
          detail: "test service owner",
        });
      }
      mocks.serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: mocks.gatewayFixturePid,
        state: "running",
      });
      setup.primeNpmChannelTag("latest", VERSION);
      vi.mocked(modules.fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: VERSION, nodeEngine: ">=24.22.1 <25 || >=26.12.1" }),
      );
      mocks.nodeVersionSatisfiesEngine.mockImplementation(
        (version) => fallback && version === process.versions.node,
      );
      mocks.resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => {
        const oldRuntime = nodePath === serviceNode;
        return {
          ...runtimeInfo(oldRuntime ? "22.23.1" : process.versions.node, !oldRuntime),
          ...(oldRuntime
            ? { status: "unsupported" as const, capabilityError: "broken TEXT decoder" }
            : {}),
        };
      });
      setup.mockFileBackedPathExists();
      vi.mocked(modules.resolveGatewayInstallEntrypoint).mockReset();
      setup.mockServicePackageCommands({
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
        vi.mocked(modules.runCommandWithTimeout).getMockImplementation(),
        "runtime fixture command",
      );
      vi.mocked(modules.runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "gateway" && argv[3] === "install") {
          if (refreshFails) {
            return commandResult({ code: 1, stderr: "runtime refresh failed" });
          }
          setup.primeServiceCommand([argv[0], entrypoint, "gateway"]);
        }
        return fixtureCommand(argv, options);
      });
      const installPath = setup.createCaseDir("current-runtime-plugin");
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
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({ brave: record });
      const updated = { ...record, version: "2026.9.3" };
      setup.mockNpmPluginOutcomes(
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
        {
          ...setup.baseConfig,
          plugins: { ...setup.baseConfig.plugins, installs: { brave: updated } },
        },
      );
      mockPostCoreConvergenceOnce(modules.runPostCorePluginConvergenceSpy, {
        installRecords: { brave: updated },
      });

      if (!fallback || !writable) {
        await expect(updateCommand({ yes: true, restart: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(proof.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "node-runtime-preflight",
        });
        const refusedRun = requireValue(
          modules.listUpdateRuns({ limit: 1 })[0],
          "refused update run",
        );
        expect(refusedRun.reason).toBe("node-runtime-preflight");
        const captureWarnings = refusedRun.steps
          .filter((step) => step.step.startsWith("warning:original-state-capture:"))
          .map((step) => `Warning: ${requireValue(step.detail, "original capture warning")}\n`)
          .join("");
        expect(proof.getErrorOutput()).toContain(captureWarnings);
        expect(proof.getErrorOutput()).toContain(
          `Required: openclaw@${VERSION} Node >=24.22.1 <25 || >=26.12.1; detected: Node 22.23.1 at ${serviceNode}`,
        );
        expect(proof.getErrorOutput()).toContain(
          `broken TEXT decoder\n${runtimeRecovery.expectedPlainRecovery(VERSION, "24.22.1", writable ? "refresh" : "owner", "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR", root, writable ? undefined : serviceNode)}`,
        );
        proof.expectNoSideEffects(
          mocks.updateNpmInstalledPlugins,
          mocks.syncPluginsForUpdateChannel,
          mocks.serviceStop,
          mocks.serviceRestart,
        );
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(proof.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "service-runtime-refresh-failed",
          run: { status: "failed" },
        });
        expect(mocks.inferenceRepair).not.toHaveBeenCalled();
        expect(proof.freshRestartCalls()).toHaveLength(1);
        expect(mocks.serviceRestart).not.toHaveBeenCalled();
        expect((await mocks.serviceReadCommand(process.env))?.programArguments[0]).toBe(
          serviceNode,
        );
        expect(proof.getErrorOutput()).toContain("openclaw update repair");
        expect(proof.getLogOutput() + proof.getErrorOutput()).not.toMatch(
          /keep the gateway stopped/i,
        );
      }
      expect(proof.packageInstallCommandCall()).toBeUndefined();
    },
  );

  it("refuses an incompatible service Node before using a compatible shell Node", async () => {
    const servicePrefix = setup.tempDirs.make("openclaw-service-prefix-");
    const { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint } =
      await setup.setupServicePackageAtPrefix({ prefix: servicePrefix });
    // Same package root for both shell and service.
    setup.mockPackageInstallStatus(root);
    const serviceCommand = [serviceNode, entrypoint, "gateway"];
    setup.primeServiceCommand(serviceCommand);
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "sealed",
      reason: "sealed-mount",
    });
    setup.primeNpmChannelTag("latest", "2026.7.1");
    vi.mocked(modules.fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({
        version: "2026.7.1",
        nodeEngine: ">=24.15.0 <25",
      }),
    );
    mocks.nodeVersionSatisfiesEngine.mockImplementation(
      (version: string | null) => version === "24.15.0",
    );
    mocks.resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => {
      const version =
        nodePath === serviceNode ? "24.14.0" : nodePath === process.execPath ? "24.15.0" : null;
      if (!version) {
        throw new Error("Unexpected runtime probe target");
      }
      return runtimeInfo(version);
    });
    setup.mockFileBackedPathExists();
    setup.mockServicePackageCommands({
      nodeModules,
      packageRoot: root,
      targetVersion: "2026.7.1",
      npmCommands: [serviceNpm, serviceNpmReal!],
      nodeVersions: { [serviceNode]: "v24.14.0", [process.execPath]: "v24.15.0" },
    });
    const recovery = await import("./update-cli/update-command-node-runtime-resolution.js");
    const recoverNode = vi
      .spyOn(recovery, "resolveTargetNodeRuntime")
      .mockResolvedValue(process.execPath);
    const packageBefore = await fs.readFile(path.join(root, "package.json"));

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(proof.lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "preflight-node-runtime-incompatible",
    });
    expect(modules.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Gateway service Node 24.14.0 at ${serviceNode} requires >=24.15.0 <25. Install Node 24.16.0 and update that service definition, then retry; changing the shell's Node alone does not update the service.`,
      ),
    );
    expect(proof.packageInstallCommandCall()?.[0]).toBeUndefined();
    proof.expectNoSideEffects(recoverNode, mocks.serviceStop, mocks.serviceRestart);
    expect((await mocks.serviceReadCommand(process.env)).programArguments).toEqual(serviceCommand);
    expect(await fs.readFile(path.join(root, "package.json"))).toEqual(packageBefore);
  });
});
