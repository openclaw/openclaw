import { describe, expect, it, vi } from "vitest";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import {
  resolveBuiltinToolInstallHintForNpmFailure,
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

  it("skips bundled pre-plan for scoped npm specs", () => {
    const findBundledSource = vi.fn();
    const result = resolveBundledInstallPlanBeforeNpm({
      rawSpec: "@openclaw/voice-call",
      findBundledSource,
    });

    expect(findBundledSource).not.toHaveBeenCalled();
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

  it("returns built-in tool hint for missing-openclaw-extensions on bare tool-like spec", () => {
    const hint = resolveBuiltinToolInstallHintForNpmFailure({
      rawSpec: "exec",
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS,
    });

    expect(hint).toContain("built-in tool category");
    expect(hint).toContain("tools.profile coding");
  });

  it("does not return built-in tool hint for scoped specs or other error codes", () => {
    const scoped = resolveBuiltinToolInstallHintForNpmFailure({
      rawSpec: "@openclaw/exec",
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS,
    });
    const otherError = resolveBuiltinToolInstallHintForNpmFailure({
      rawSpec: "exec",
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
    });

    expect(scoped).toBeNull();
    expect(otherError).toBeNull();
  });
});
