import { describe, expect, it, vi } from "vitest";
import {
  createLocalInstallPressureRefusalMessage,
  createPackageManagerWarningMessage,
  detectLifecyclePackageManager,
  shouldRefuseLocalInstallForPressure,
  warnIfNonPnpmLifecycle,
} from "../../scripts/preinstall-package-manager-warning.mjs";

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
    expect(warn.mock.calls[0]?.[0]).toContain("detected npm");
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

  it("refuses source-checkout installs when the host is already pressured", () => {
    expect(
      shouldRefuseLocalInstallForPressure(
        {
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
    expect(shouldRefuseLocalInstallForPressure({ CI: "true" }, pressuredHost).refuse).toBe(false);
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

  it("formats an actionable refusal message", () => {
    expect(
      createLocalInstallPressureRefusalMessage({
        reasons: ["MemAvailable below 2GiB", "load1 above 10"],
      }),
    ).toContain("refusing local package install under host pressure");
  });
});
