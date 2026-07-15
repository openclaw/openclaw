// Preinstall Package Manager Warning tests cover preinstall package manager warning script behavior.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  enforceSupportedNodeRuntime,
  nodeVersionSatisfiesPackageEngine,
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

  it.each(["24.15.0-rc.1", "25.9.1-nightly.20260714", "24.15"])(
    "rejects non-release Node version %s",
    (version) => {
      expect(nodeVersionSatisfiesPackageEngine(version, EXPECTED_NODE_ENGINE_RANGE)).toBe(false);
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

  it("exits nonzero when the packed entrypoint sees an unsupported runtime", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-preinstall-"));
    try {
      const scriptsDir = join(root, "scripts");
      mkdirSync(scriptsDir);
      const scriptPath = join(scriptsDir, "preinstall-package-manager-warning.mjs");
      copyFileSync(
        new URL("../../scripts/preinstall-package-manager-warning.mjs", import.meta.url),
        scriptPath,
      );
      writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: ">=999.0.0" } }));

      const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("requires Node >=999.0.0");
      expect(result.stderr).toContain(`detected Node ${process.versions.node}`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("allows Bun package lifecycle scripts", () => {
    const reportError = vi.fn();
    expect(
      enforceSupportedNodeRuntime(
        {
          version: "24.14.1",
          bunVersion: "1.3.0",
          engine: EXPECTED_NODE_ENGINE_RANGE,
          execPath: "/opt/bun/bin/bun",
        },
        reportError,
      ),
    ).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
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
