import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import lifecyclePaths from "../../scripts/e2e/lib/bun-only-runtime/preinstall-lifecycle-paths.json" with { type: "json" };
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
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const EXPECTED_NODE_ENGINE_RANGE = ">=24.22.1 <25 || >=26.12.1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const lifecyclePrefix = [
  "/work/openclaw/node_modules/.bin",
  "/work/node_modules/.bin",
  "/node_modules/.bin",
];
const probe = (options: Parameters<typeof probePackageCliNodeRuntime>[0]) =>
  probePackageCliNodeRuntime({
    cwd: "/work/openclaw",
    access: () => {},
    platform: "linux",
    bunVersion: "1.4.3",
    ...options,
  });
const enforce = (
  options: Parameters<typeof enforceSupportedNodeRuntime>[0],
  reportError = vi.fn(),
) => enforceSupportedNodeRuntime({ engine: EXPECTED_NODE_ENGINE_RANGE, ...options }, reportError);
function expectRejectedProbe(options: Parameters<typeof probe>[0]) {
  const run = vi.fn();
  expect(probe({ ...options, run })).toBeNull();
  expect(run).not.toHaveBeenCalled();
}
function runtimeReply(execPath: string, version: string, bunVersion: string | null = null) {
  return { status: 0, stdout: JSON.stringify({ version, bunVersion, execPath }) };
}
function expectPathRuntime(options: Parameters<typeof probe>[0], execPath: string) {
  const version = (command: string) => (command === "/opt/node/bin/node" ? "24.22.1" : "24.14.1");
  expect(probe({ ...options, run: (command) => runtimeReply(command, version(command)) })).toEqual({
    execPath,
    version: version(execPath),
    bunVersion: null,
  });
}

describe("install runtime enforcement", () => {
  it("reads the canonical package engine range", () => {
    expect(readPackageNodeEngine()).toBe(EXPECTED_NODE_ENGINE_RANGE);
  });

  it.each(["v24.22.1+local.1"])("matches the CLI runtime guard for Node %s", (version) => {
    expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(
      isSupportedNodeVersion(version),
    );
  });

  it("allows supported Node without an error", () => {
    const reportError = vi.fn();
    expect(
      enforce(
        { version: "24.22.1", bunVersion: null, execPath: "/opt/node/bin/node" },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["27.0.0", true],
    ["27.0.0-nightly20261018f88a1d25e9", true],
    ["24.22.1-rc.1", false],
    ["27.0.0-nightly..1", false],
  ] as const)("enforces the package engine for Node %s", (version, accepted) => {
    const reportError = vi.fn();
    expect(
      enforce({ version, bunVersion: null, execPath: "/opt/node/bin/node" }, reportError),
    ).toBe(accepted);
    expect(reportError).toHaveBeenCalledTimes(accepted ? 0 : 1);
  });

  it("exits nonzero when the packed entrypoint sees an unsupported runtime", () => {
    const root = tempDirs.make("openclaw-preinstall-");
    const scriptsDir = join(root, "scripts");
    mkdirSync(join(scriptsDir, "lib"), { recursive: true });
    const scriptPath = join(scriptsDir, "preinstall-package-manager-warning.mjs");
    for (const file of [
      "scripts/preinstall-package-manager-warning.mjs",
      "scripts/lib/package-lifecycle-marker.mjs",
      "node-version.mjs",
    ]) {
      copyFileSync(new URL(`../../${file}`, import.meta.url), join(root, file));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: ">=999.0.0" } }));

    const result = spawnSync(testNodeExecPath, [scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires Node >=999.0.0");
    const nodeVersion = spawnSync(testNodeExecPath, ["-p", "process.versions.node"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(result.stderr).toContain(`detected Node ${nodeVersion}`);
  });

  it.each([
    { name: "no marker", launcher: "" },
    { name: "matching shim", accepted: true },
    { name: "foreign shim", shimMatchesBun: false },
    {
      name: "old launcher",
      bun: "1.4.2",
      error: "Bun launcher /opt/bun/bin/bun requires Bun 1.4.3+",
    },
    { name: "relative launcher", launcher: "bin/bun" },
    { name: "old persistent Node", persistent: "old-node", error: "detected Node 24.14.1" },
    {
      name: "supported persistent Node",
      bun: "1.4.2",
      persistent: "supported-node",
      accepted: true,
    },
    { name: "persistent Bun before Node", bun: "1.4.2", persistent: "same-bun" },
  ])(
    "enforces the explicit Bun launcher contract: $name",
    ({
      launcher = "/opt/bun/bin/bun",
      bun = "1.4.3",
      persistent,
      shimMatchesBun = true,
      accepted = false,
      error = "detected Node missing",
    }) => {
      const shimDirectory = "bun-node-ddfce5d01";
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
          const isNode = _command === "/opt/node/bin/node";
          return runtimeReply(
            _command,
            isNode ? (persistent === "old-node" ? "24.14.1" : "24.22.1") : "24.3.0",
            isNode ? null : bun,
          );
        },
      );
      const result = enforce(
        {
          bunVersion: "1.4.3",
          probeNodeRuntime: () =>
            probe({
              execPath: "/opt/bun/bin/bun",
              realpath: (candidate) =>
                (candidate === `/tmp/${shimDirectory}/node` && shimMatchesBun) ||
                candidate === "/opt/bun/bin/node"
                  ? "/opt/bun/bin/bun"
                  : candidate,
              env: {
                OPENCLAW_PACKAGE_BUN_LAUNCHER: launcher,
                NODE_OPTIONS: "--require=fixture.cjs",
                Node_Options: "--require=other-fixture.cjs",
              },
              pathEnv: [
                ...lifecyclePrefix,
                ...(persistent === "same-bun" ? ["/opt/bun/bin", "/opt/node/bin"] : []),
                `/tmp/${shimDirectory}`,
                ...(persistent === "old-node" || persistent === "supported-node"
                  ? ["/opt/node/bin"]
                  : []),
              ].join(":"),
              run,
            }),
        },
        reportError,
      );
      expect(result).toBe(accepted);
      if (!accepted) {
        expect(reportError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(error));
      } else {
        expect(reportError).not.toHaveBeenCalled();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "never spawns absent or nonexecutable Node candidates: persistent supported Node",
    () => {
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
      const executable = join(nodeDir, "node");
      writeFileSync(executable, "Node fixture", { mode: 0o755 });
      const prefix: string[] = [];
      for (let directory = cwd; ; directory = dirname(directory)) {
        prefix.push(join(directory, "node_modules", ".bin"));
        if (dirname(directory) === directory) {
          break;
        }
      }
      const run = vi.fn((command: string) =>
        command === executable
          ? runtimeReply(executable, "24.22.1")
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
                bunVersion: "1.4.3",
                env: { OPENCLAW_PACKAGE_BUN_LAUNCHER: launcher },
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
      ).toBe(true);
      expect(run.mock.calls.map(([command]) => command)).toEqual([executable]);
    },
  );

  it.each(lifecyclePaths)("checks a duplicate inherited entry: $name", (layout) => {
    expectPathRuntime(
      {
        bunVersion: layout.bunVersion,
        env: layout.env,
        pathEnv: [
          ...layout.prefix,
          "/work/openclaw/node_modules/.bin",
          "/opt/node/bin",
          ...layout.suffix,
        ].join(":"),
      },
      "/work/openclaw/node_modules/.bin/node",
    );
  });

  it.each([["/work/node_modules/.bin"], ["/work/node_modules/.bin", "/node_modules/.bin"]])(
    "preserves inherited ancestor bins before later Node paths: %j",
    (...inherited) => {
      expectPathRuntime(
        {
          bunVersion: "1.4.4",
          env: { npm_config_local_prefix: "/work" },
          pathEnv: [
            "/work/openclaw/node_modules/.bin",
            ...inherited,
            "/opt/node/bin",
            "/work/node_modules/.bin",
            "/node_modules/.bin",
          ].join(":"),
        },
        "/work/node_modules/.bin/node",
      );
    },
  );

  it.each(["1.4.3", "1.4.4"])(
    "preserves an inherited ancestor suffix in a prefix-only Bun %s lifecycle",
    (bunVersion) => {
      expectPathRuntime(
        {
          bunVersion,
          env: { npm_config_local_prefix: "/work/openclaw" },
          pathEnv: [
            ...lifecyclePrefix,
            "/opt/node/bin",
            "/work/node_modules/.bin",
            "/node_modules/.bin",
          ].join(":"),
        },
        "/opt/node/bin/node",
      );
    },
  );

  it.each([
    ["/unproven/node_modules/.bin", "/opt/node/bin"],
    ["/work/openclaw/node_modules/.bin", "/opt/node/bin", "/node_modules/.bin"],
    [
      "/work/openclaw/node_modules/.bin",
      "/opt/node/bin",
      "/node_modules/.bin",
      "/work/node_modules/.bin",
    ],
  ])("fails closed when the lifecycle directories cannot be proven: %j", (...entries) => {
    expectRejectedProbe({ pathEnv: entries.join(":") });
  });

  it.each(["."])("fails closed before a relative PATH component %j", (relativeEntry) => {
    expectRejectedProbe({
      pathEnv: [...lifecyclePrefix, relativeEntry, "/opt/node/bin"].join(":"),
    });
  });

  it.each(["/tools"])(
    "fails closed before a Windows root-relative PATH component %j",
    (relativeEntry) => {
      expectRejectedProbe({
        cwd: "C:\\work\\openclaw",
        pathEnv: [
          "C:\\work\\openclaw\\node_modules\\.bin",
          "C:\\work\\node_modules\\.bin",
          "C:\\node_modules\\.bin",
          relativeEntry,
          "C:\\node",
        ].join(";"),
        platform: "win32",
      });
    },
  );

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
  it.each([
    ["C:\\Tools\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "npm"],
    ["C:\\Tools\\corepack\\yarnpkg.cmd", "yarn"],
    ["/work/project/.yarn/releases/yarn-4.5.0.cjs", "yarn"],
    ["/tmp/npm-cache/bin/yarn.js", "yarn"],
  ])("detects %s without interpreting its parent directories", (npm_execpath, manager) => {
    expect(detectLifecyclePackageManager({ npm_execpath })).toBe(manager);
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
