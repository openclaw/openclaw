// Preinstall Package Manager Warning tests cover preinstall package manager warning script behavior.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectLifecyclePackageManager,
  enforceSupportedNodeRuntime,
  nodeVersionSatisfiesPackageEngine,
  probePackageCliNodeRuntime,
  readPackageNodeEngine,
  removeLegacyPackageInstallGuard,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";
import { isSupportedNodeVersion } from "../../src/infra/runtime-guard.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const EXPECTED_NODE_ENGINE_RANGE = ">=24.16.0 <25 || >=26.1.0";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

describe("install runtime enforcement", () => {
  it("reads the canonical package engine range", () => {
    expect(readPackageNodeEngine()).toBe(EXPECTED_NODE_ENGINE_RANGE);
  });

  it.each(NODE_RELEASE_VERSION_CASES)("matches the CLI runtime guard for Node %s", (version) => {
    expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(
      isSupportedNodeVersion(version),
    );
  });

  it.each([
    "24.16.0-rc.1",
    "25.9.1-nightly.20260714",
    "24.15",
    "24.16.0+",
    "24.16.0+local..1",
    "garbage24.16.0suffix",
    "24.16.0suffix",
  ])("rejects non-release Node version %s", (version) => {
    expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(false);
  });

  it("accepts SemVer build metadata on a supported Node release", () => {
    expect(nodeVersionSatisfiesPackageEngine("24.16.0+local.1", EXPECTED_NODE_ENGINE_RANGE)).toBe(
      true,
    );
  });

  it("blocks unsupported Node before package replacement", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
          bunVersion: null,
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/node/bin/node",
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("this OpenClaw release requires Node"),
    );
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node 24.14.1"));
  });

  it("allows supported Node without an error", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.16.0",
          bunVersion: null,
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/node/bin/node",
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("exits nonzero when the packed entrypoint sees an unsupported runtime", () => {
    const root = tempDirs.make("openclaw-preinstall-");
    const scriptsDir = join(root, "scripts");
    mkdirSync(join(scriptsDir, "lib"), { recursive: true });
    const scriptPath = join(scriptsDir, "preinstall-package-manager-warning.mjs");
    copyFileSync(
      new URL("../../scripts/preinstall-package-manager-warning.mjs", import.meta.url),
      scriptPath,
    );
    copyFileSync(
      new URL("../../scripts/lib/package-lifecycle-marker.mjs", import.meta.url),
      join(scriptsDir, "lib", "package-lifecycle-marker.mjs"),
    );
    copyFileSync(
      new URL("../../node-version.mjs", import.meta.url),
      join(root, "node-version.mjs"),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: ">=999.0.0" } }));

    const result = spawnSync(testNodeExecPath, [scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Node >=999.0.0");
    const nodeVersion = spawnSync(testNodeExecPath, ["-p", "process.versions.node"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(result.stderr).toContain(`detected Node ${nodeVersion}`);
  });

  it("allows Bun package lifecycle scripts when the installed CLI will use supported Node", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/bun/bin/bun",
          probeNodeRuntime: () => ({
            version: "24.16.0",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("blocks Bun package lifecycle scripts when the installed CLI will use old Node", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          probeNodeRuntime: () => ({
            version: "24.14.1",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node 24.14.1"));
  });

  it("blocks Bun package lifecycle scripts when no real Node follows its shim", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          probeNodeRuntime: () => null,
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node missing"));
  });

  it.each(
    [
      {
        name: "no marker",
        launcher: undefined,
        bun: "1.4.3",
        persistent: undefined,
        accepted: false,
        error: "detected Node missing",
      },
      ...[
        "bun-node-ddfce5d01",
        "bun-node-501-6b9148b1",
        "bun-node-501-debug",
        "bun-node-501-6b9148b1-0123456789abcdef",
        "bun-node-501-debug-0123456789abcdef",
      ].flatMap((shimDirectory) =>
        [true, false].map((shimMatchesBun) => ({
          name: `${shimDirectory} resolving to ${shimMatchesBun ? "running" : "another"} Bun`,
          launcher: "/opt/bun/bin/bun",
          bun: "1.4.3",
          persistent: undefined,
          shimDirectory,
          shimMatchesBun,
          accepted: shimMatchesBun,
          error: shimMatchesBun ? undefined : "detected Node missing",
        })),
      ),
      {
        name: "old launcher",
        launcher: "/opt/bun/bin/bun",
        bun: "1.3.9",
        persistent: undefined,
        accepted: false,
        error: "Bun launcher /opt/bun/bin/bun requires Bun 1.4+",
      },
      {
        name: "relative launcher",
        launcher: "bin/bun",
        bun: "1.4.3",
        persistent: undefined,
        accepted: false,
        error: "detected Node missing",
      },
      {
        name: "persistent old Node after the shim",
        launcher: "/opt/bun/bin/bun",
        bun: "1.4.3",
        persistent: "old-node",
        accepted: false,
        error: "detected Node 24.14.1",
      },
      {
        name: "different Bun-backed node before the shim",
        launcher: "/opt/bun/bin/bun",
        bun: "1.4.3",
        persistent: "other-bun",
        accepted: false,
        error: "detected Node missing",
      },
      {
        name: "same Bun-backed node before supported Node without marker",
        launcher: undefined,
        bun: "1.3.9",
        persistent: "same-bun",
        accepted: false,
        error: "detected Node missing",
      },
      {
        name: "same Bun-backed node before supported Node with marker",
        launcher: "/opt/bun/bin/bun",
        bun: "1.3.9",
        persistent: "same-bun",
        accepted: false,
        error: "detected Node missing",
      },
    ].map((testCase) =>
      Object.assign({ shimDirectory: "bun-node-ddfce5d01", shimMatchesBun: true }, testCase),
    ),
  )(
    "enforces the explicit Bun launcher contract: $name",
    ({ launcher, bun, persistent, shimDirectory, shimMatchesBun, accepted, error }) => {
      const reportError = vi.fn();
      const run = vi.fn(
        (
          _command: string,
          _args: string[],
          options: { env: NodeJS.ProcessEnv; timeout: number },
        ) => {
          expect(options.env).not.toHaveProperty("NODE_OPTIONS");
          expect(options.env).not.toHaveProperty("Node_Options");
          expect(options.timeout).toBe(10_000);
          return {
            status: 0,
            stdout: JSON.stringify({
              version:
                _command === "/opt/node/bin/node"
                  ? persistent === "old-node"
                    ? "24.14.1"
                    : "24.16.0"
                  : "24.3.0",
              bunVersion: _command === "/opt/node/bin/node" ? null : bun,
              execPath: _command,
            }),
          };
        },
      );
      const result = enforceSupportedNodeRuntime(
        {
          bunVersion: "1.4.3",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          probeNodeRuntime: () =>
            probePackageCliNodeRuntime({
              cwd: "/work/openclaw",
              access: () => {},
              execPath: "/opt/bun/bin/bun",
              realpath: (candidate) =>
                (candidate === `/tmp/${shimDirectory}/node` && shimMatchesBun) ||
                candidate === "/opt/bun/bin/node"
                  ? "/opt/bun/bin/bun"
                  : candidate,
              platform: "linux",
              env: {
                OPENCLAW_PACKAGE_BUN_LAUNCHER: launcher,
                NODE_OPTIONS: "--require=fixture.cjs",
                Node_Options: "--require=other-fixture.cjs",
              },
              pathEnv: [
                "/work/openclaw/node_modules/.bin",
                "/work/node_modules/.bin",
                "/node_modules/.bin",
                ...(persistent === "other-bun" ? ["/other-bun/bin"] : []),
                ...(persistent === "same-bun" ? ["/opt/bun/bin", "/opt/node/bin"] : []),
                `/tmp/${shimDirectory}`,
                ...(persistent === "old-node" ? ["/opt/node/bin"] : []),
              ].join(":"),
              run,
            }),
        },
        reportError,
      );
      expect(result).toBe(accepted);
      if (error) {
        expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(error));
      } else {
        expect(reportError).not.toHaveBeenCalled();
      }
      expect(run.mock.calls.map(([command]) => command)).toEqual(
        persistent === "old-node"
          ? ["/opt/node/bin/node"]
          : persistent === "other-bun"
            ? ["/other-bun/bin/node"]
            : persistent === "same-bun"
              ? ["/opt/bun/bin/node"]
              : !shimMatchesBun
                ? [`/tmp/${shimDirectory}/node`]
                : launcher?.startsWith("/")
                  ? [launcher]
                  : [],
      );
    },
  );

  it.skipIf(process.platform === "win32").each([
    { name: "explicit Bun launcher", nodeVersion: null, marker: true, accepted: true },
    { name: "missing launcher marker", nodeVersion: null, marker: false, accepted: false },
    { name: "persistent old Node", nodeVersion: "24.14.1", marker: true, accepted: false },
    { name: "persistent supported Node", nodeVersion: "24.16.0", marker: true, accepted: true },
  ])(
    "never spawns absent or nonexecutable Node candidates: $name",
    ({ nodeVersion, marker, accepted }) => {
      const cwd = tempDirs.make("openclaw-preinstall-path-");
      const noExecute = join(cwd, "no-execute");
      const dangling = join(cwd, "dangling");
      const notDirectory = join(cwd, "not-a-directory");
      const nodeDir = join(cwd, "persistent");
      const launcher = join(cwd, "bun");
      for (const directory of [noExecute, dangling, nodeDir]) {
        mkdirSync(directory);
      }
      writeFileSync(join(noExecute, "node"), "not executable", { mode: 0o644 });
      writeFileSync(notDirectory, "not a directory");
      symlinkSync(join(cwd, "missing-node"), join(dangling, "node"));
      writeFileSync(launcher, "Bun fixture", { mode: 0o755 });
      const executable = nodeVersion ? join(nodeDir, "node") : launcher;
      if (nodeVersion) {
        writeFileSync(executable, "Node fixture", { mode: 0o755 });
      }
      const prefix: string[] = [];
      for (let directory = cwd; ; directory = dirname(directory)) {
        prefix.push(join(directory, "node_modules", ".bin"));
        if (dirname(directory) === directory) {
          break;
        }
      }
      const run = vi.fn((command: string) =>
        command === executable
          ? {
              status: 0,
              stdout: JSON.stringify({
                version: nodeVersion ?? "24.3.0",
                bunVersion: nodeVersion ? null : "1.4.3",
                execPath: executable,
              }),
            }
          : { error: Object.assign(new Error("absent executable"), { code: "ENOENT" }) },
      );
      const reportError = vi.fn();
      expect(
        enforceSupportedNodeRuntime(
          {
            bunVersion: "1.4.3",
            engine: EXPECTED_NODE_ENGINE_RANGE,
            probeNodeRuntime: () =>
              probePackageCliNodeRuntime({
                cwd,
                env: { OPENCLAW_PACKAGE_BUN_LAUNCHER: marker ? launcher : undefined },
                pathEnv: [
                  ...prefix,
                  join(cwd, "missing"),
                  noExecute,
                  notDirectory,
                  dangling,
                  nodeDir,
                ].join(":"),
                run,
              }),
          },
          reportError,
        ),
      ).toBe(accepted);
      expect(run.mock.calls.map(([command]) => command)).toEqual(marker ? [executable] : []);
      if (nodeVersion === "24.14.1") {
        expect(reportError).toHaveBeenCalledWith(expect.stringContaining("detected Node 24.14.1"));
      }
    },
  );

  it("strips only Bun's cwd-to-root lifecycle PATH prefix", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      access: () => {},
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.16.0",
            bunVersion: null,
            execPath: "/opt/node/bin/node",
          }),
        };
      },
    });

    expect(candidates).toEqual(["/opt/node/bin/node"]);
    expect(runtime).toEqual({
      version: "24.16.0",
      bunVersion: null,
      execPath: "/opt/node/bin/node",
    });
  });

  it("checks an inherited node_modules/.bin entry after Bun's prefix", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      access: () => {},
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/opt/tools/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.14.1",
            bunVersion: null,
            execPath: command,
          }),
        };
      },
    });

    expect(candidates).toEqual(["/opt/tools/node_modules/.bin/node"]);
    expect(runtime?.version).toBe("24.14.1");
  });

  it("checks a duplicate lifecycle-looking entry inherited in the original PATH", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      cwd: "/work/openclaw",
      access: () => {},
      pathEnv: [
        "/work/openclaw/node_modules/.bin",
        "/work/node_modules/.bin",
        "/node_modules/.bin",
        "/work/openclaw/node_modules/.bin",
        "/opt/node/bin",
      ].join(":"),
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "24.14.1",
            bunVersion: null,
            execPath: command,
          }),
        };
      },
    });

    expect(candidates).toEqual(["/work/openclaw/node_modules/.bin/node"]);
    expect(runtime?.version).toBe("24.14.1");
  });

  it("fails closed when Bun's lifecycle PATH prefix cannot be proven", () => {
    const run = vi.fn();
    expect(
      probePackageCliNodeRuntime({
        cwd: "/work/openclaw",
        access: () => {},
        pathEnv: ["/unproven/node_modules/.bin", "/opt/node/bin"].join(":"),
        platform: "linux",
        run,
      }),
    ).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed on a Bun-backed candidate from the original PATH", () => {
    const candidates: string[] = [];
    expect(
      probePackageCliNodeRuntime({
        cwd: "/work/openclaw",
        access: () => {},
        pathEnv: [
          "/work/openclaw/node_modules/.bin",
          "/work/node_modules/.bin",
          "/node_modules/.bin",
          "/opt/bun-wrapper",
          "/opt/node/bin",
        ].join(":"),
        platform: "linux",
        run: (command) => {
          candidates.push(command);
          return {
            status: 0,
            stdout: JSON.stringify({
              version: "24.16.0",
              bunVersion: "1.3.14",
              execPath: "/opt/bun/bin/bun",
            }),
          };
        },
      }),
    ).toBeNull();
    expect(candidates).toEqual(["/opt/bun-wrapper/node"]);
  });

  it.each(["", ".", "relative/bin"])(
    "fails closed before a relative PATH component %j",
    (relativeEntry) => {
      const run = vi.fn();
      expect(
        probePackageCliNodeRuntime({
          cwd: "/work/openclaw",
          access: () => {},
          pathEnv: [
            "/work/openclaw/node_modules/.bin",
            "/work/node_modules/.bin",
            "/node_modules/.bin",
            relativeEntry,
            "/opt/node/bin",
          ].join(":"),
          platform: "linux",
          run,
        }),
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(["\\tools", "/tools"])(
    "fails closed before a Windows root-relative PATH component %j",
    (relativeEntry) => {
      const run = vi.fn();
      expect(
        probePackageCliNodeRuntime({
          cwd: "C:\\work\\openclaw",
          access: () => {},
          pathEnv: [
            "C:\\work\\openclaw\\node_modules\\.bin",
            "C:\\work\\node_modules\\.bin",
            "C:\\node_modules\\.bin",
            relativeEntry,
            "C:\\node",
          ].join(";"),
          platform: "win32",
          run,
        }),
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("removes NODE_OPTIONS case-insensitively from a Windows probe", () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    expect(
      probePackageCliNodeRuntime({
        cwd: "C:\\work\\openclaw",
        access: () => {},
        env: {
          PATH: [
            "C:\\work\\openclaw\\node_modules\\.bin",
            "C:\\work\\node_modules\\.bin",
            "C:\\node_modules\\.bin",
            "C:\\node",
          ].join(";"),
          NODE_OPTIONS: "--require=first.cjs",
          Node_Options: "--require=second.cjs",
          OPENCLAW_PROBE_SENTINEL: "preserved",
        },
        platform: "win32",
        run: (_command, _args, options) => {
          childEnv = options.env;
          return {
            status: 0,
            stdout: JSON.stringify({
              version: "24.16.0",
              bunVersion: null,
              execPath: "C:\\node\\node.exe",
            }),
          };
        },
      }),
    ).toEqual({
      version: "24.16.0",
      bunVersion: null,
      execPath: "C:\\node\\node.exe",
    });
    expect(childEnv).toEqual({
      PATH: [
        "C:\\work\\openclaw\\node_modules\\.bin",
        "C:\\work\\node_modules\\.bin",
        "C:\\node_modules\\.bin",
        "C:\\node",
      ].join(";"),
      OPENCLAW_PROBE_SENTINEL: "preserved",
    });
  });

  it("removes the legacy install guard after runtime validation", () => {
    const markerUrl = new URL("file:///tmp/openclaw-install-guard");
    const remove = vi.fn();
    const reportError = vi.fn();

    expect(removeLegacyPackageInstallGuard({ markerUrl, remove }, reportError)).toBe(true);
    expect(remove).toHaveBeenCalledWith(markerUrl, { force: true });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails installation when the legacy install guard cannot be removed", () => {
    const reportError = vi.fn();
    expect(
      removeLegacyPackageInstallGuard(
        {
          remove: () => {
            throw new Error("read-only package");
          },
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not remove the legacy package install guard: read-only package",
      ),
    );
  });
});

describe("detectLifecyclePackageManager", () => {
  it("prefers npm_config_user_agent when present", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
      }),
    ).toBe("npm");
  });

  it("falls back to npm_execpath when user agent is missing", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });

  it("detects npm cli launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      }),
    ).toBe("npm");
  });

  it("detects yarnpkg launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "C:\\Tools\\corepack\\yarnpkg.cmd",
      }),
    ).toBe("yarn");
  });

  it("detects versioned Yarn release launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/work/project/.yarn/releases/yarn-4.5.0.cjs",
      }),
    ).toBe("yarn");
  });

  it("detects Yarn Berry release launchers from npm_execpath", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/work/project/.yarn/releases/yarn-berry.cjs",
      }),
    ).toBe("yarn");
  });

  it("ignores package manager names in npm_execpath parent directories", () => {
    expect(
      detectLifecyclePackageManager({
        npm_execpath: "/tmp/npm-cache/bin/yarn.js",
      }),
    ).toBe("yarn");
  });

  it("ignores untrusted user-agent tokens with control characters", () => {
    expect(
      detectLifecyclePackageManager({
        npm_config_user_agent: "\u001bnpm/11.4.1 node/v22.20.0 darwin arm64",
        npm_execpath: "/Users/test/.cache/node/corepack/v1/pnpm/10.32.1/bin/pnpm.cjs",
      }),
    ).toBe("pnpm");
  });
});

describe("warnIfNonPnpmLifecycle", () => {
  it("warns once for npm lifecycle runs", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "npm/11.4.1 node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = expectDefined(warn.mock.calls[0], "package manager warning call");
    expect(message).toContain("detected npm");
    expect(message).toContain("prefer: corepack pnpm install");
  });

  it("stays quiet for pnpm", () => {
    const warn = vi.fn();
    expect(
      warnIfNonPnpmLifecycle(
        {
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 darwin arm64",
        },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
