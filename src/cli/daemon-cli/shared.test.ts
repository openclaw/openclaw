import { describe, expect, it, vi } from "vitest";
import { theme } from "../../terminal/theme.js";
import {
  failIfSudoInstall,
  filterContainerGenericHints,
  renderGatewayServiceStartHints,
  resolveDaemonContainerContext,
  resolveRuntimeStatusColor,
} from "./shared.js";

describe("resolveRuntimeStatusColor", () => {
  it("maps known runtime states to expected theme colors", () => {
    expect(resolveRuntimeStatusColor("running")).toBe(theme.success);
    expect(resolveRuntimeStatusColor("stopped")).toBe(theme.error);
    expect(resolveRuntimeStatusColor("unknown")).toBe(theme.muted);
  });

  it("falls back to warning color for unexpected states", () => {
    expect(resolveRuntimeStatusColor("degraded")).toBe(theme.warn);
    expect(resolveRuntimeStatusColor(undefined)).toBe(theme.muted);
  });
});

describe("renderGatewayServiceStartHints", () => {
  it("resolves daemon container context from either env key", () => {
    expect(
      resolveDaemonContainerContext({
        OPENCLAW_CONTAINER: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toBe("openclaw-demo-container");
    expect(
      resolveDaemonContainerContext({
        OPENCLAW_CONTAINER_HINT: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toBe("openclaw-demo-container");
  });

  it("prepends a single container restart hint when OPENCLAW_CONTAINER is set", () => {
    expect(
      renderGatewayServiceStartHints({
        OPENCLAW_CONTAINER: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toEqual(
      expect.arrayContaining([
        "Restart the container or the service that manages it for openclaw-demo-container.",
      ]),
    );
  });

  it("prepends a single container restart hint when OPENCLAW_CONTAINER_HINT is set", () => {
    expect(
      renderGatewayServiceStartHints({
        OPENCLAW_CONTAINER_HINT: "openclaw-demo-container",
      } as NodeJS.ProcessEnv),
    ).toEqual(
      expect.arrayContaining([
        "Restart the container or the service that manages it for openclaw-demo-container.",
      ]),
    );
  });
});

describe("filterContainerGenericHints", () => {
  it("drops the generic container foreground hint when OPENCLAW_CONTAINER is set", () => {
    expect(
      filterContainerGenericHints(
        [
          "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
          "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
        ],
        { OPENCLAW_CONTAINER: "openclaw-demo-container" } as NodeJS.ProcessEnv,
      ),
    ).toEqual([]);
  });

  it("drops the generic container foreground hint when OPENCLAW_CONTAINER_HINT is set", () => {
    expect(
      filterContainerGenericHints(
        [
          "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
          "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
        ],
        { OPENCLAW_CONTAINER_HINT: "openclaw-demo-container" } as NodeJS.ProcessEnv,
      ),
    ).toEqual([]);
  });
});

describe("failIfSudoInstall", () => {
  it("blocks install when SUDO_USER is set and uid is 0 on Linux", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", {
      value: () => 0,
      configurable: true,
      writable: true,
    });

    try {
      const fail = vi.fn();
      const result = failIfSudoInstall(fail, { SUDO_USER: "alice" });
      expect(result).toBe(true);
      expect(fail).toHaveBeenCalledOnce();
      expect(fail.mock.calls[0]?.[0]).toContain("sudo is not needed");
      const hints: string[] = fail.mock.calls[0]?.[1] ?? [];
      expect(hints.some((h) => h.includes("loginctl enable-linger alice"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "getuid", {
        value: originalGetuid,
        configurable: true,
        writable: true,
      });
    }
  });

  it("allows install when not running as root", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", {
      value: () => 1000,
      configurable: true,
      writable: true,
    });

    try {
      const fail = vi.fn();
      const result = failIfSudoInstall(fail, { SUDO_USER: "alice" });
      expect(result).toBe(false);
      expect(fail).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "getuid", {
        value: originalGetuid,
        configurable: true,
        writable: true,
      });
    }
  });

  it("allows install when SUDO_USER is unset (direct root login)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", {
      value: () => 0,
      configurable: true,
      writable: true,
    });

    try {
      const fail = vi.fn();
      const result = failIfSudoInstall(fail, {});
      expect(result).toBe(false);
      expect(fail).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "getuid", {
        value: originalGetuid,
        configurable: true,
        writable: true,
      });
    }
  });

  it("is a no-op on non-Linux platforms", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    try {
      const fail = vi.fn();
      const result = failIfSudoInstall(fail, { SUDO_USER: "alice" });
      expect(result).toBe(false);
      expect(fail).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
