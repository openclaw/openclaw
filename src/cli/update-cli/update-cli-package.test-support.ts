import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type Mock } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import { resolveGatewayTaskScriptPath } from "../../daemon/paths.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { runCommandWithTimeout as RunCommandWithTimeout } from "../../process/exec.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg } from "../quote-cli-arg.js";

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export const writeJsonFixture = (
  filePath: string,
  value: unknown,
  trailingNewline = true,
): Promise<void> =>
  fs.writeFile(filePath, `${JSON.stringify(value)}${trailingNewline ? "\n" : ""}`, "utf-8");

export const writeOpenClawPackageFixture = async (
  root: string,
  version: string,
  options: {
    entryPath?: string;
    entrySource?: string;
    git?: boolean;
    builtSha?: string;
    inventory?: boolean;
  } = {},
) => {
  const entryPath = options.entryPath ?? path.join(root, "dist", "index.js");
  await fs.mkdir(options.entrySource === undefined ? root : path.dirname(entryPath), {
    recursive: true,
  });
  if (options.git) {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
  }
  await writeJsonFixture(path.join(root, "package.json"), { name: "openclaw", version }, false);
  if (options.entrySource !== undefined) {
    await fs.writeFile(entryPath, options.entrySource, "utf-8");
  }
  if (options.builtSha) {
    for (const dir of ["src", "extensions", "dist/control-ui/assets"]) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
    for (const [file, contents] of Object.entries({
      "openclaw.mjs": "export {};\n",
      "dist/entry.js": "export {};\n",
      "dist/build-info.json": JSON.stringify({
        commit: options.builtSha,
        buildId: "fixture-original-build",
      }),
      "dist/.buildstamp": JSON.stringify({ head: options.builtSha }),
      "dist/.runtime-postbuildstamp": JSON.stringify({ head: options.builtSha }),
      "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
      "dist/control-ui/assets/startup.js": "export {};\n",
    })) {
      await fs.writeFile(path.join(root, file), contents);
    }
  }
  if (options.inventory) {
    await writePackageDistInventory(root);
  }
  return entryPath;
};

export async function writeGitUpdateResultFixture(
  params: Pick<UpdateRunResult, "before"> & {
    root: string;
    after: { sha: string; version: string };
  },
): Promise<UpdateRunResult> {
  await writeOpenClawPackageFixture(params.root, params.after.version, {
    builtSha: params.after.sha,
  });
  const { readGitRuntimeArtifactIdentity } = await import("../../infra/update-git-runtime.js");
  return {
    status: "ok",
    mode: "git",
    steps: [],
    durationMs: 100,
    ...params,
    gitRuntime: await readGitRuntimeArtifactIdentity(params.root),
  };
}

export const writeNpmPackageInstall = async (
  argv: string[],
  packageRoot: string,
  version = argv.find((arg) => /^openclaw@\d/u.test(arg))?.slice("openclaw@".length) ?? "9999.0.0",
) => {
  const stagePrefix = argv.includes("--prefix")
    ? requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix")
    : undefined;
  const installedRoot = stagePrefix
    ? path.join(
        stagePrefix,
        process.platform === "win32" ? "node_modules" : "lib/node_modules",
        "openclaw",
      )
    : packageRoot;
  await writeOpenClawPackageFixture(installedRoot, version, {
    entrySource: "export {};\n",
    inventory: true,
  });
};

export const packageTargetStatus = (
  overrides: Partial<{
    target: string;
    version: string | null;
    nodeEngine: string | null;
    schemaVersions: { state: number; agent: number };
    error: string;
  }> = {},
) => ({
  target: "9999.0.0",
  version: "9999.0.0",
  nodeEngine: ">=22.19.0",
  ...overrides,
});

type PackageFixtureDependencies = {
  runCommandWithTimeout: typeof RunCommandWithTimeout;
  serviceStop: Mock;
  serviceReadRuntime: Mock;
  serviceReadCommand: Mock;
  serviceLoaded: Mock;
  pathExists: Mock;
  gatewayFixturePid: number;
  sqliteHostPlatform: NodeJS.Platform;
  mockGatewayHealth: (version: string, connId: string, buildId?: string) => void;
  mockPackageInstallStatus: (root: string) => void;
};

/** Package bytes, command transport and service lifecycle used by the CLI scenarios. */
export function createUpdateCliPackageFixtures({
  runCommandWithTimeout,
  serviceStop,
  serviceReadRuntime,
  serviceReadCommand,
  serviceLoaded,
  pathExists,
  gatewayFixturePid,
  sqliteHostPlatform,
  mockGatewayHealth,
  mockPackageInstallStatus,
}: PackageFixtureDependencies) {
  const mockNpmGlobalCommands = (
    nodeModules: string,
    handle?: (
      ...args: Parameters<typeof runCommandWithTimeout>
    ) =>
      | Awaited<ReturnType<typeof runCommandWithTimeout>>
      | undefined
      | Promise<Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined>,
    sourceCheckout?: string | (() => string),
  ) => {
    const activateGateway = mockPackageGatewayLifecycle();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const handled = await handle?.(argv, options);
      if (handled !== undefined) {
        return handled;
      }
      if (sourceCheckout && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        const checkout = typeof sourceCheckout === "function" ? sourceCheckout() : sourceCheckout;
        expect(argv).toContain(checkout);
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(
          stagePrefix,
          process.platform === "win32" ? "node_modules" : "lib/node_modules",
        );
        await fs.mkdir(stageRoot, { recursive: true });
        await fs.symlink(
          checkout,
          path.join(stageRoot, "openclaw"),
          process.platform === "win32" ? "junction" : undefined,
        );
      }
      if (argv[0] === "npm" && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${nodeModules}\n` });
      }
      if (argv[0] === "npm" && argv[1] === "pack") {
        const destination = requireValue(
          argv[argv.indexOf("--pack-destination") + 1],
          "pack destination",
        );
        await fs.writeFile(path.join(destination, "openclaw-9999.0.0.tgz"), "packed\n", "utf8");
      }
      await activateGateway(argv);
      return commandResult();
    });
  };

  const mockFileBackedPathExists = () => {
    pathExists.mockImplementation(async (candidate: string) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    });
  };

  const setupInstalledPackageAtNodeModules = async (nodeModules: string, version = "2026.4.21") => {
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(pkgRoot);
    const entryPath = await writeOpenClawPackageFixture(pkgRoot, version, {
      entrySource: "export {};\n",
      inventory: true,
    });
    return { nodeModules, pkgRoot, entryPath };
  };

  const setupInstalledPackageRoot = (baseDir: string, version = "2026.4.21") =>
    setupInstalledPackageAtNodeModules(
      path.join(baseDir, process.platform === "win32" ? "node_modules" : "lib/node_modules"),
      version,
    );

  const setupServicePackageAtPrefix = async (params: {
    prefix: string;
    version?: string;
    withNpm?: boolean;
  }) => {
    const nodeModules = path.join(params.prefix, "lib", "node_modules");
    const root = path.join(nodeModules, "openclaw");
    const serviceNode = path.join(
      params.prefix,
      "bin",
      sqliteHostPlatform === "win32" ? "node.exe" : "node",
    );
    const serviceNpm = path.join(params.prefix, "bin", "npm");
    await fs.mkdir(path.dirname(serviceNode), { recursive: true });
    // Metadata sizing executes the selected path outside the CLI transport mock.
    if (sqliteHostPlatform === "win32") {
      await fs.copyFile(process.execPath, serviceNode);
    } else {
      await fs.writeFile(serviceNode, `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} "$@"\n`, {
        mode: 0o755,
      });
    }
    const serviceNpmReal =
      params.withNpm === false
        ? undefined
        : await fs.writeFile(serviceNpm, "", "utf-8").then(() => fs.realpath(serviceNpm));
    const entrypoint = await writeOpenClawPackageFixture(root, params.version ?? "2026.5.18", {
      entrySource: "",
      inventory: true,
    });
    return { nodeModules, root, serviceNode, serviceNpm, serviceNpmReal, entrypoint };
  };

  const mockPackageGatewayLifecycle = () => {
    serviceStop.mockImplementation(async () => {
      serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      // macOS stop boots out the job; systemd enablement and task registration remain.
      if (process.platform === "darwin") {
        serviceLoaded.mockResolvedValue(false);
      }
    });
    return async (argv: string[]) => {
      if (argv[2] !== "gateway" || (argv[3] !== "install" && argv[3] !== "restart")) {
        return;
      }
      // Native activation starts the installed package. Changing the probe only
      // here keeps a missing restart or wrong package visible to real health checks.
      const entrypoint = requireValue(argv[1], "gateway activation entrypoint");
      await fs.access(entrypoint);
      const manifest = JSON.parse(
        await fs.readFile(path.join(path.dirname(entrypoint), "..", "package.json"), "utf8"),
      ) as { version: string };
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      mockGatewayHealth(manifest.version, "updated-gateway");
    };
  };

  const mockServicePackageCommands = (params: {
    nodeModules: string;
    packageRoot: string;
    targetVersion: string;
    npmCommands: string[];
    nodeVersions: Record<string, string>;
    onGatewayInstall?: (argv: string[]) => void;
  }) => {
    const npmCommands = new Set(params.npmCommands);
    const activateGateway = mockPackageGatewayLifecycle();
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      const command = argv[0] ?? "";
      if (argv[1] === "--version" && params.nodeVersions[command]) {
        return commandResult({ stdout: `${params.nodeVersions[command]}\n` });
      }
      if (npmCommands.has(command) && argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (npmCommands.has(command) && argv[1] === "root" && argv[2] === "-g") {
        return commandResult({ stdout: `${params.nodeModules}\n` });
      }
      if (npmCommands.has(command) && argv[1] === "i") {
        const stagePrefix = argv.includes("--prefix")
          ? argv[argv.indexOf("--prefix") + 1]
          : undefined;
        const stageRoot = stagePrefix
          ? path.join(stagePrefix, "lib", "node_modules", "openclaw")
          : params.packageRoot;
        await writeOpenClawPackageFixture(stageRoot, params.targetVersion, {
          entrySource: "export {};\n",
          inventory: true,
        });
      }
      await activateGateway(argv);
      if (argv[2] === "gateway" && argv[3] === "install") {
        params.onGatewayInstall?.([...argv]);
      }
      return commandResult();
    });
  };

  const mockRunningManagedGateway = (
    programArguments: string[] = ["openclaw", "gateway", "run"],
  ) => {
    serviceReadCommand.mockResolvedValue({
      programArguments,
      ...(process.platform === "win32"
        ? { sourcePath: resolveGatewayTaskScriptPath(process.env) }
        : {}),
      environment: {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
  };

  const mockStoppedManagedGitGateway = () => {
    mockRunningManagedGateway([
      "node",
      path.join(process.cwd(), "dist", "index.js"),
      "gateway",
      "run",
    ]);
    serviceLoaded.mockImplementation(async () => serviceStop.mock.calls.length === 0);
    serviceReadRuntime.mockImplementation(async () =>
      serviceStop.mock.calls.length === 0
        ? { status: "running", pid: gatewayFixturePid, state: "running" }
        : { status: "stopped", pid: null, state: "stopped" },
    );
  };

  const mockNpmGlobalRoot = (nodeModules: string) => {
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        await writeNpmPackageInstall(argv, path.join(nodeModules, "openclaw"));
      }
    });
  };

  const mockPackageReplacementFailure = (message: string, beforeFailure?: () => Promise<void>) => {
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (argv[1] === "--version") {
        return commandResult({ stdout: "12.0.0\n" });
      }
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        await beforeFailure?.();
        throw new Error(message);
      }
      return commandResult();
    });
  };

  const mockGatewayInstallFailure = (entrypoint: string, stderr = "launchctl bootstrap failed") => {
    const message =
      "Service definition refresh failed; the previous definition was restored: Error: launchctl bootstrap failed";
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      const failed = argv[1] === entrypoint && argv[2] === "gateway" && argv[3] === "install";
      return commandResult({
        stdout: failed
          ? JSON.stringify({
              action: "install",
              ok: false,
              error: `Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: ${message}`,
              warnings: [message],
            })
          : "",
        stderr: failed ? stderr : "",
        code: failed ? 1 : 0,
      });
    });
  };
  return {
    mockNpmGlobalCommands,
    mockFileBackedPathExists,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    setupServicePackageAtPrefix,
    mockPackageGatewayLifecycle,
    mockServicePackageCommands,
    mockRunningManagedGateway,
    mockStoppedManagedGitGateway,
    mockNpmGlobalRoot,
    mockPackageReplacementFailure,
    mockGatewayInstallFailure,
  };
}

/** Stage the package/fresh-process entrypoint responses without depending on a built repository. */
export function createCurrentProcessFreshDoctorFixture(
  resolveGatewayInstallEntrypoint: typeof import("../../daemon/gateway-entrypoint.js").resolveGatewayInstallEntrypoint,
  freshEntrypoint: string,
) {
  return (
    params: {
      postCoreResumeAttempt?: boolean;
      packageRoot?: string;
      candidateAdmission?: boolean;
    } = {},
  ) => {
    // Package Doctor precedes the fresh-process decision; it must have a real entrypoint.
    if (params.packageRoot) {
      vi.mocked(resolveGatewayInstallEntrypoint).mockReset();
      if (params.candidateAdmission) {
        // Native capability admission resolves the staged candidate before package Doctor.
        vi.mocked(resolveGatewayInstallEntrypoint).mockImplementationOnce(async (root) =>
          path.join(expectDefined(root, "capability candidate root"), "dist", "index.js"),
        );
      }
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
        path.join(params.packageRoot, "dist", "index.js"),
      );
    }
    if (params.postCoreResumeAttempt !== false) {
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(undefined);
    }
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(freshEntrypoint);
  };
}
