import { describe, expect, it, vi } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
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
      localPath: installedPluginRoot("/tmp", "voice-call"),
      npmSpec: "@mullusi/voice-call",
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
      rawSpec: "@mullusi/voice-call",
      findBundledSource,
    });

    expect(findBundledSource).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("prefers bundled catalog plugin by id before npm spec", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind, value }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "pluginId" && value === "voice-call") {
          return {
            pluginId: "voice-call",
            localPath: installedPluginRoot("/tmp", "voice-call"),
            npmSpec: "@mullusi/voice-call",
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      pluginId: "voice-call",
      npmSpec: "@mullusi/voice-call",
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({ kind: "pluginId", value: "voice-call" });
    expect(result?.bundledSource.localPath).toBe(installedPluginRoot("/tmp", "voice-call"));
  });

  it("rejects npm-spec matches that resolve to a different plugin id", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "npmSpec") {
          return {
            pluginId: "not-voice-call",
            localPath: installedPluginRoot("/tmp", "not-voice-call"),
            npmSpec: "@mullusi/voice-call",
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      pluginId: "voice-call",
      npmSpec: "@mullusi/voice-call",
      findBundledSource,
    });

    expect(result).toBeNull();
  });

  it("rejects plugin-id bundled matches when the catalog npm spec was overridden", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "pluginId") {
          return {
            pluginId: "whatsapp",
            localPath: installedPluginRoot("/tmp", "whatsapp"),
            npmSpec: "@mullusi/whatsapp",
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      pluginId: "whatsapp",
      npmSpec: "@vendor/whatsapp-fork",
      findBundledSource,
    });

    expect(result).toBeNull();
  });

  it("uses npm-spec bundled fallback only for package-not-found", () => {
    const findBundledSource = vi.fn().mockReturnValue({
      pluginId: "voice-call",
      localPath: installedPluginRoot("/tmp", "voice-call"),
      npmSpec: "@mullusi/voice-call",
    });
    const result = resolveBundledInstallPlanForNpmFailure({
      rawSpec: "@mullusi/voice-call",
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
      findBundledSource,
    });

    expect(findBundledSource).toHaveBeenCalledWith({
      kind: "npmSpec",
      value: "@mullusi/voice-call",
    });
    expect(result?.warning).toContain("npm package unavailable");
  });

  it("skips fallback for non-not-found npm failures", () => {
    const findBundledSource = vi.fn();
    const result = resolveBundledInstallPlanForNpmFailure({
      rawSpec: "@mullusi/voice-call",
      code: "INSTALL_FAILED",
      findBundledSource,
    });

    expect(findBundledSource).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
