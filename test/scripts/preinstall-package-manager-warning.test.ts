// Preinstall tests cover package runtime enforcement and package manager warnings.
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-dist-inventory.ts";
import {
  completePackageInstallGuard,
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  enforceSupportedNodeRuntime,
  nodeVersionSatisfiesPackageEngine,
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH as PREINSTALL_GUARD_RELATIVE_PATH,
  probePackageCliNodeRuntime,
  readPackageNodeEngine,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";
import { isSupportedNodeVersion } from "../../src/infra/runtime-guard.js";

const EXPECTED_NODE_ENGINE_RANGE = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";

function requireFirstWarning(warn: ReturnType<typeof vi.fn>): unknown {
  const [call] = warn.mock.calls;
  if (!call) {
    throw new Error("expected package manager warning");
  }
  const [message] = call;
  if (message === undefined) {
    throw new Error("expected package manager warning");
  }
  return message;
}

describe("install runtime enforcement", () => {
  it("shares the packaged install guard path", () => {
    expect(PREINSTALL_GUARD_RELATIVE_PATH).toBe(PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
  });

  it("reads the canonical package engine range", () => {
    expect(readPackageNodeEngine()).toBe(EXPECTED_NODE_ENGINE_RANGE);
  });

  it.each(["22.22.2", "22.22.3", "23.11.0", "24.14.1", "24.15.0", "25.8.1", "25.9.0", "26.0.0"])(
    "matches the CLI runtime guard for Node %s",
    (version) => {
      expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(
        isSupportedNodeVersion(version),
      );
    },
  );

  it("blocks unsupported Node before package replacement", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
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
          version: "24.15.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/node/bin/node",
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
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
            version: "24.15.0",
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

  it("skips Bun's temporary node shim and probes the next PATH runtime", () => {
    const candidates: string[] = [];
    const runtime = probePackageCliNodeRuntime({
      pathEnv: "/tmp/bun-node:/opt/node/bin",
      platform: "linux",
      run: (command) => {
        candidates.push(command);
        return command.startsWith("/tmp/bun-node")
          ? {
              status: 0,
              stdout: JSON.stringify({
                version: "24.3.0",
                bunVersion: "1.3.0",
                execPath: "/opt/bun/bin/bun",
              }),
            }
          : {
              status: 0,
              stdout: JSON.stringify({
                version: "24.15.0",
                bunVersion: null,
                execPath: "/opt/node/bin/node",
              }),
            };
      },
    });

    expect(candidates).toEqual(["/tmp/bun-node/node", "/opt/node/bin/node"]);
    expect(runtime).toEqual({
      version: "24.15.0",
      bunVersion: null,
      execPath: "/opt/node/bin/node",
    });
  });

  it("removes the install guard after runtime validation", () => {
    const markerUrl = new URL("file:///tmp/openclaw-install-guard");
    const remove = vi.fn();
    const reportError = vi.fn();

    expect(completePackageInstallGuard({ markerUrl, remove }, reportError)).toBe(true);
    expect(remove).toHaveBeenCalledWith(markerUrl, { force: true });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails installation when the install guard cannot be removed", () => {
    const reportError = vi.fn();
    expect(
      completePackageInstallGuard(
        {
          remove: () => {
            throw new Error("read-only package");
          },
        },
        reportError,
      ),
    ).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("could not complete package preinstall: read-only package"),
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

describe("createPackageManagerWarningMessage", () => {
  it("returns null for pnpm", () => {
    expect(createPackageManagerWarningMessage("pnpm")).toBeNull();
  });

  it("warns for npm installs", () => {
    expect(createPackageManagerWarningMessage("npm")).toContain("prefer: corepack pnpm install");
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
    expect(requireFirstWarning(warn)).toContain("detected npm");
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
