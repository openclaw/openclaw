import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import { quoteCliArg } from "./quote-cli-arg.js";
import {
  commandCalls,
  doctorCommandCall,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  spawnCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
  nodeVersionSatisfiesEngine,
  readPackageVersion,
  resolveNodeRuntimeInfo,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceStop,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  fetchNpmPackageTargetStatus,
  makeOkUpdateResult,
  replaceConfigFile,
  resolveNpmChannelTag,
  runCommandWithTimeout,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  packageTargetStatus,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    createCaseDir,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockServicePackageCommands,
    primeNpmChannelTag,
    primeServiceCommand,
    runUpdateCliScenario,
    setupInstalledPackageRoot,
    setupServicePackageAtPrefix,
    tempDirs,
  } = createUpdateCliFixture();

  it("leaves same-version package files intact with --no-restart", async () => {
    const tempDir = tempDirs.make("openclaw-update-current-");
    const { nodeModules, pkgRoot } = await setupInstalledPackageRoot(tempDir, VERSION);
    readPackageVersion.mockResolvedValue(VERSION);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: VERSION,
    });
    await writeOpenClawPackageFixture(pkgRoot, VERSION, {
      inventory: true,
    });
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await updateCommand({ yes: true, restart: false });

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(doctorCommandCall()).toBeUndefined();
    expect(spawnCall()).toBeUndefined();
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(getLogOutput()).toContain("already-current");
  });

  it("retries package updates without optional deps when npm global update fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-optional-");
    const nodeModules = path.join(tempDir, "lib", "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    await writeOpenClawPackageFixture(pkgRoot, "1.0.0", {
      inventory: true,
      entrySource: "export {};\n",
    });

    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (
        argv[0] === "npm" &&
        argv[1] === "i" &&
        argv.includes("-g") &&
        !argv.includes("--omit=optional")
      ) {
        return commandResult({ stderr: "node-gyp failed", code: 1 });
      }
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot);
      }
      return undefined;
    });

    await updateCommand({ yes: true, restart: false });

    const installArgvs = commandCalls()
      .map(([argv]) => argv)
      .filter((argv) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g");
    const installPrefix = [
      "npm",
      "i",
      "-g",
      "--allow-scripts=openclaw",
      "--prefix",
      expect.stringContaining(".openclaw.update-stage-"),
      "openclaw@9999.0.0",
    ];
    const installFlags = ["--no-fund", "--no-audit", "--loglevel=error", "--min-release-age=0"];
    expect(installArgvs).toEqual([
      installPrefix.concat(installFlags),
      installPrefix.concat("--omit=optional", installFlags),
    ]);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("uses the owning npm binary for package updates when PATH npm points elsewhere", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const brewPrefix = createCaseDir("brew-prefix");
    const brewRoot = path.join(brewPrefix, "lib", "node_modules");
    const pkgRoot = path.join(brewRoot, "openclaw");
    const brewNpm = path.join(brewPrefix, "bin", "npm");
    const win32PrefixNpm = path.join(brewPrefix, "npm.cmd");
    const owningNpmCommands = new Set([brewNpm, win32PrefixNpm].map(path.normalize));
    const isOwningNpmCommand = (value: unknown) =>
      typeof value === "string" && owningNpmCommands.has(path.normalize(value));
    const pathNpmRoot = createCaseDir("nvm-root");
    mockPackageInstallStatus(pkgRoot);
    await writeOpenClawPackageFixture(pkgRoot, "1.0.0", {
      entrySource: "export {};\n",
      inventory: true,
    });
    mockFileBackedPathExists();

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (!Array.isArray(argv)) {
        return commandResult();
      }
      if (isOwningNpmCommand(argv[0]) && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${pathNpmRoot}\n` });
      }
      if (isOwningNpmCommand(argv[0]) && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${brewRoot}\n` });
      }
      if (isOwningNpmCommand(argv[0]) && argv[1] === "i" && argv[2] === "-g") {
        await writeNpmPackageInstall(argv, pkgRoot);
      }
      return commandResult();
    });

    await fs.mkdir(path.dirname(brewNpm), { recursive: true });
    await fs.writeFile(brewNpm, "", "utf8");
    await fs.writeFile(win32PrefixNpm, "", "utf8");
    await updateCommand({ yes: true });

    platformSpy.mockRestore();

    expect(updateGitCheckout).not.toHaveBeenCalled();
    const installCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        ([argv]) =>
          Array.isArray(argv) &&
          isOwningNpmCommand(argv[0]) &&
          argv[1] === "i" &&
          argv[2] === "-g" &&
          argv.includes("openclaw@9999.0.0"),
      );

    const requiredInstallCall = requireValue(installCall, "brew npm install call");
    const installCommand = requiredInstallCall[0][0] ?? "";
    expect(installCommand).not.toBe("npm");
    expect(path.isAbsolute(installCommand)).toBe(true);
    expect(path.normalize(installCommand)).toContain(path.normalize(brewPrefix));
    expect(path.normalize(installCommand)).toMatch(
      new RegExp(
        `${path
          .normalize(path.join(brewPrefix, path.sep))
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*npm(?:\\.cmd)?$`,
        "i",
      ),
    );
    expect(vi.mocked(resolveNpmChannelTag)).toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(vi.mocked(fetchNpmPackageTargetStatus)).toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    const installOptions = requiredInstallCall[1] as { timeoutMs?: number };
    expect(installOptions.timeoutMs).toBeUndefined();
  });

  it("prepends portable Git PATH for package updates on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await mockPackageInstallAtCaseDir();
    const localAppData = createCaseDir("openclaw-localappdata");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });
    mockFileBackedPathExists();

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      await updateCommand({ yes: true });
    });

    platformSpy.mockRestore();

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    const updateOptions =
      typeof updateCall?.[1] === "object" && updateCall[1] !== null ? updateCall[1] : undefined;
    const mergedPath = updateOptions?.env?.Path ?? updateOptions?.env?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(updateOptions?.env?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
  });

  it.each([
    {
      name: "outputs JSON when --json is set",
      run: async () => {
        vi.mocked(updateGitCheckout).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(defaultRuntime.writeJson).mockClear();
        await updateCommand({ json: true });
      },
      assert: () => {
        requireValue(lastWriteJsonCall(), "update JSON output");
      },
    },
    {
      name: "exits with error on failure",
      run: async () => {
        vi.mocked(updateGitCheckout).mockResolvedValue({
          status: "error",
          mode: "git",
          reason: "rebase-failed",
          steps: [],
          durationMs: 100,
        } satisfies UpdateRunResult);
        vi.mocked(defaultRuntime.exit).mockClear();
        await expect(updateCommand({})).rejects.toEqual(new ExitError(1));
      },
      assert: () => {
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      },
    },
  ] as const)("updateCommand reports outcomes: $name", runUpdateCliScenario);

  it("persists the requested channel only after a successful package update", async () => {
    await mockPackageInstallAtCaseDir();

    await updateCommand({ channel: "beta", yes: true });

    const installCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        update: {
          channel: "beta",
        },
      },
      baseHash: undefined,
    });
    expect(
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex] ?? 0,
    ).toBeLessThan(
      vi.mocked(replaceConfigFile).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it.each(["sealed", "unknown", "writable-overridden"] as const)(
    "preserves split-root package updates when the service definition is %s",
    async (kind) => {
      const oldInstall = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("sealed-node-a-"),
      });
      const shellInstall = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("sealed-node-b-"),
      });
      mockPackageInstallStatus(shellInstall.root);
      readPackageVersion.mockImplementation(
        async (root: string) =>
          JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
      );
      const originalCommand = [oldInstall.serviceNode, oldInstall.entrypoint, "gateway"];
      primeServiceCommand(originalCommand);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: kind === "writable-overridden" ? "writable" : kind,
        reason: kind === "sealed" ? "foreign-owner" : "inspection-failed",
      });
      const overriddenCommand = {
        programArguments: originalCommand,
        environment: { NODE_OPTIONS: "--max-old-space-size=4096" },
        managedDefinition: { programArguments: originalCommand },
        managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
      };
      if (kind === "writable-overridden") {
        serviceReadCommand.mockResolvedValue(overriddenCommand);
      }
      primeNpmChannelTag("latest", "2026.5.20");
      mockFileBackedPathExists();
      const transports = [oldInstall, shellInstall].map((install) => {
        mockServicePackageCommands({
          nodeModules: install.nodeModules,
          packageRoot: install.root,
          targetVersion: "2026.5.20",
          npmCommands: ["npm", install.serviceNpm, requireValue(install.serviceNpmReal, "npm")],
          nodeVersions: { [oldInstall.serviceNode]: "v24.19.0" },
        });
        return requireValue(
          vi.mocked(runCommandWithTimeout).getMockImplementation(),
          "package transport",
        );
      });
      const oldPrefix = path.dirname(path.dirname(oldInstall.serviceNode));
      vi.mocked(runCommandWithTimeout).mockImplementation((argv, options) => {
        const context =
          typeof options === "object" && options !== null
            ? [options.cwd ?? "", options.env?.PATH ?? ""]
            : [];
        const old = [...argv, ...context].some((value) => value.includes(oldPrefix));
        return transports[old ? 0 : 1]!(argv, options);
      });
      await updateCommand({ yes: true }).catch((cause: unknown) => {
        throw new Error(getErrorOutput() + getLogOutput(), { cause });
      });
      expect(
        JSON.parse(await fs.readFile(path.join(oldInstall.root, "package.json"), "utf8")).version,
      ).toBe("2026.5.20");
      expect(
        JSON.parse(await fs.readFile(path.join(shellInstall.root, "package.json"), "utf8")).version,
      ).toBe("2026.5.18");
      expect((await serviceReadCommand(process.env)).programArguments).toEqual(originalCommand);
      if (kind === "writable-overridden") {
        expect(await serviceReadCommand(process.env)).toEqual(overriddenCommand);
      }
      const installCalls = commandCalls().filter(
        ([argv]) => argv[2] === "gateway" && argv[3] === "install",
      );
      if (kind === "writable-overridden") {
        expect(installCalls).toHaveLength(1);
        expect(installCalls[0]?.[0].slice(0, 4)).toEqual([
          oldInstall.serviceNode,
          oldInstall.entrypoint,
          "gateway",
          "install",
        ]);
        expect(installCalls[0]?.[1]).toEqual(
          expect.objectContaining({
            cwd: oldInstall.root,
            input: expect.stringContaining('"targetRoot":' + JSON.stringify(oldInstall.root)),
          }),
        );
      } else {
        expect(installCalls).toEqual([]);
      }
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(getLogOutput()).toContain("Gateway: restarted and verified");
    },
  );

  it("previews rebinding a managed service to the invoking package root", async () => {
    const shellRoot = createCaseDir("openclaw-shell-root");
    const serviceRoot = tempDirs.make("openclaw-service-root-");
    const serviceNode = path.join(path.dirname(serviceRoot), "bin", "node");
    await fs.mkdir(path.join(serviceRoot, "dist"), { recursive: true });
    await writeOpenClawPackageFixture(serviceRoot, "2026.5.18");
    await writeOpenClawPackageFixture(shellRoot, "2026.5.20");
    mockPackageInstallStatus(shellRoot);
    serviceReadCommand.mockResolvedValue({
      programArguments: [serviceNode, path.join(serviceRoot, "dist", "index.js"), "gateway"],
    });

    await updateCommand({ dryRun: true });

    expect(serviceReadCommand).toHaveBeenCalledTimes(2);
    const logs = getLogOutput();
    expect(logs).toContain(`rebinding the managed Gateway from ${serviceRoot}`);
    expect(logs).toContain(`to ${shellRoot} after verification`);
    expect(logs).not.toContain("make sure `openclaw` on PATH");
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each([
    { capability: "sealed", restart: true, currentRunner: false, compatible: false },
    { capability: "unknown", restart: true, currentRunner: false, compatible: false },
    { capability: "writable", restart: false, currentRunner: true, compatible: false },
    { capability: "sealed", restart: false, currentRunner: true, compatible: false },
    { capability: "writable", restart: true, currentRunner: false, compatible: false },
    { capability: "sealed", restart: true, currentRunner: false, compatible: true },
  ] as const)(
    "preserves target compatibility for an unchanged service launcher ($capability, restart=$restart, current=$currentRunner, compatible=$compatible)",
    async ({ capability, restart, currentRunner, compatible }) => {
      const fixture = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("preserved-runtime-"),
      });
      const serviceNode = currentRunner ? process.execPath : fixture.serviceNode;
      const replacementNode = path.join(tempDirs.make("replacement-runtime-"), "bin", "node");
      await fs.mkdir(path.dirname(replacementNode), { recursive: true });
      // Preserve the host runtime's dynamic-library paths when metadata probes execute it.
      if (process.platform === "win32") {
        await fs.copyFile(process.execPath, replacementNode);
      } else {
        await fs.writeFile(
          replacementNode,
          `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} "$@"\n`,
          {
            mode: 0o755,
          },
        );
      }
      mockPackageInstallStatus(fixture.root);
      primeServiceCommand([serviceNode, fixture.entrypoint, "gateway"]);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: capability,
        reason: "fixture",
      });
      primeNpmChannelTag("latest", "2026.7.1");
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ target: "latest", version: "2026.7.1", nodeEngine: ">=26.1.0" }),
      );
      nodeVersionSatisfiesEngine.mockImplementation(
        (version: string | null) => version === "26.8.1",
      );
      resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => ({
        status: "supported",
        version:
          nodePath === replacementNode || (compatible && nodePath === serviceNode)
            ? "26.8.1"
            : "24.20.0",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      }));
      const recovery = await import("./update-cli/update-command-node-runtime-resolution.js");
      const recoverNode = vi
        .spyOn(recovery, "resolveTargetNodeRuntime")
        .mockResolvedValue(replacementNode);
      mockFileBackedPathExists();
      mockServicePackageCommands({
        nodeModules: fixture.nodeModules,
        packageRoot: fixture.root,
        targetVersion: "2026.7.1",
        npmCommands: ["npm", fixture.serviceNpm, requireValue(fixture.serviceNpmReal, "npm")],
        nodeVersions: {
          [serviceNode]: compatible ? "v26.8.1" : "v24.20.0",
          [replacementNode]: "v26.8.1",
        },
        onGatewayInstall: (argv) =>
          primeServiceCommand([requireValue(argv[0], "Node"), fixture.entrypoint, "gateway"]),
      });
      if (!compatible && (!restart || capability !== "writable")) {
        await expect(updateCommand({ yes: true, json: true, restart })).rejects.toEqual(
          new ExitError(1),
        );
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "node-runtime-preflight",
        });
        expect(
          commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g"),
        ).toBeUndefined();
        expect(recoverNode).not.toHaveBeenCalled();
        expect(serviceStop).not.toHaveBeenCalled();
        expect((await serviceReadCommand(process.env)).programArguments[0]).toBe(serviceNode);
        expect(
          JSON.parse(await fs.readFile(path.join(fixture.root, "package.json"), "utf8")).version,
        ).toBe("2026.5.18");
      } else {
        await updateCommand({ yes: true, json: true, restart });
        expect(commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g")).toBeDefined();
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
        expect((await serviceReadCommand(process.env)).programArguments[0]).toBe(
          compatible ? serviceNode : replacementNode,
        );
        if (compatible) {
          expect(recoverNode).not.toHaveBeenCalled();
        } else {
          expect(recoverNode).toHaveBeenCalledOnce();
        }
      }
    },
  );
});
