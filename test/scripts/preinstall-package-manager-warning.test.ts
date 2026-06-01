// Preinstall Package Manager Warning tests cover preinstall package manager warning script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalInstallPressureRefusalMessage,
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  isOpenClawSourceCheckoutRoot,
  shouldRefuseLocalInstallForPressure,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";

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

describe("local install pressure guard", () => {
  const pressuredHost = {
    isSourceCheckout: true,
    memAvailableBytes: 1536 * 1024 * 1024,
    swapFreeBytes: 768 * 1024 * 1024,
    load1: 12,
  };

  it("stays compatible by default when the host is already pressured", () => {
    expect(
      shouldRefuseLocalInstallForPressure(
        {
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 linux arm64",
        },
        pressuredHost,
      ),
    ).toEqual({ refuse: false, reasons: [] });
  });

  it("refuses source-checkout installs when the pressure guard is explicitly enabled", () => {
    expect(
      shouldRefuseLocalInstallForPressure(
        {
          OPENCLAW_INSTALL_PRESSURE_GUARD: "1",
          npm_config_user_agent: "pnpm/10.32.1 npm/? node/v22.20.0 linux arm64",
        },
        pressuredHost,
      ),
    ).toEqual({
      refuse: true,
      reasons: ["MemAvailable below 2GiB", "SwapFree below 1GiB", "load1 above 10"],
    });
  });

  it("allows CI and explicit pressure-guard opt-out installs", () => {
    expect(
      shouldRefuseLocalInstallForPressure(
        { CI: "true", OPENCLAW_INSTALL_PRESSURE_GUARD: "1" },
        pressuredHost,
      ).refuse,
    ).toBe(false);
    expect(
      shouldRefuseLocalInstallForPressure({ OPENCLAW_INSTALL_PRESSURE_GUARD: "0" }, pressuredHost)
        .refuse,
    ).toBe(false);
  });

  it("stays quiet outside source checkouts", () => {
    expect(
      shouldRefuseLocalInstallForPressure(
        {},
        {
          ...pressuredHost,
          isSourceCheckout: false,
        },
      ).refuse,
    ).toBe(false);
  });

  it("only classifies real OpenClaw source roots as guarded source checkouts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-guard-"));
    try {
      const sourceRoot = path.join(tempRoot, "source-root");
      const consumerRoot = path.join(tempRoot, "consumer-root");
      const packedInstallRoot = path.join(consumerRoot, "node_modules", "openclaw");
      fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, "extensions"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "package.json"), "{}\n");
      fs.writeFileSync(path.join(sourceRoot, "pnpm-workspace.yaml"), "packages: []\n");
      fs.mkdirSync(packedInstallRoot, { recursive: true });
      fs.writeFileSync(path.join(packedInstallRoot, "package.json"), "{}\n");

      expect(spawnSync("git", ["init"], { cwd: sourceRoot }).status).toBe(0);
      expect(spawnSync("git", ["init"], { cwd: consumerRoot }).status).toBe(0);

      expect(isOpenClawSourceCheckoutRoot(sourceRoot)).toBe(true);
      expect(isOpenClawSourceCheckoutRoot(packedInstallRoot)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("formats an actionable refusal message", () => {
    expect(
      createLocalInstallPressureRefusalMessage({
        reasons: ["MemAvailable below 2GiB", "load1 above 10"],
      }),
    ).toContain("refusing local package install under host pressure");
  });
});
