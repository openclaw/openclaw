import { describe, expect, it, vi } from "vitest";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import {
  resolveBundledInstallPlanForCatalogEntry,
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "./plugin-install-plan.js";

describe("plugin install plan helpers", () => {
  it("prefers bundled plugin for bare plugin-id specs", () => {
    const findBundledSource = vi.fn().mockReturnValue({
      pluginId: "voice-call",
      localPath: "/tmp/extensions/voice-call",
      npmSpec: "@openclaw/voice-call",
    });

    const result = resolveBundledInstallPlanBeforeNpm({
      rawSpec: "voice-call",
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({ kind: "pluginId", value: "voice-call" });
    expect(result?.bundledSource.pluginId).toBe("voice-call");
    expect(result?.warning).toContain('bare install spec "voice-call"');
  });

  it("prefers bundled plugin for scoped npm specs", () => {
    const findBundledSource = vi.fn().mockReturnValue({
      pluginId: "voice-call",
      localPath: "/tmp/extensions/voice-call",
      npmSpec: "@openclaw/voice-call",
    });
    const result = resolveBundledInstallPlanBeforeNpm({
      rawSpec: "@openclaw/voice-call",
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({
      kind: "npmSpec",
      value: "@openclaw/voice-call",
    });
    expect(result?.bundledSource.pluginId).toBe("voice-call");
    expect(result?.warning).toContain('npm install spec "@openclaw/voice-call"');
  });

  it("skips bundled pre-plan for non-matching scoped npm specs", () => {
    const findBundledSource = vi.fn().mockReturnValue(undefined);
    const result = resolveBundledInstallPlanBeforeNpm({
      rawSpec: "@openclaw/not-found",
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({
      kind: "npmSpec",
      value: "@openclaw/not-found",
    });
    expect(result).toBeNull();
  });

  it("prefers bundled catalog plugin by id before npm spec", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind, value }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "pluginId" && value === "voice-call") {
          return {
            pluginId: "voice-call",
            localPath: "/tmp/extensions/voice-call",
            npmSpec: "@openclaw/voice-call",
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      pluginId: "voice-call",
      npmSpec: "@openclaw/voice-call",
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({ kind: "pluginId", value: "voice-call" });
    expect(result?.bundledSource.localPath).toBe("/tmp/extensions/voice-call");
  });

  it("rejects npm-spec matches that resolve to a different plugin id", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "npmSpec") {
          return {
            pluginId: "not-voice-call",
            localPath: "/tmp/extensions/not-voice-call",
            npmSpec: "@openclaw/voice-call",
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      pluginId: "voice-call",
      npmSpec: "@openclaw/voice-call",
      findBundledSource,
    });

    expect(result).toBeNull();
  });

  it("uses npm-spec bundled fallback only for package-not-found", () => {
    const findBundledSource = vi.fn().mockReturnValue({
      pluginId: "voice-call",
      localPath: "/tmp/extensions/voice-call",
      npmSpec: "@openclaw/voice-call",
    });
    const result = resolveBundledInstallPlanForNpmFailure({
      rawSpec: "@openclaw/voice-call",
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({
      kind: "npmSpec",
      value: "@openclaw/voice-call",
    });
    expect(result?.warning).toContain("npm package unavailable");
  });

  it("skips fallback for non-not-found npm failures", () => {
    const findBundledSource = vi.fn();
    const result = resolveBundledInstallPlanForNpmFailure({
      rawSpec: "@openclaw/voice-call",
      code: "INSTALL_FAILED",
      findBundledSource,
    });

    expect(findBundledSource).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
