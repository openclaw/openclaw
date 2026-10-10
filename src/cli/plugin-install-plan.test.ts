// Plugin install plan tests cover install planning for local, registry, and bundled plugins.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  resolveBundledInstallPlanForCatalogEntry,
  resolveBundledInstallPlanForNpmFailure,
  resolvePluginInstallSourcePlan,
} from "../plugins/install-source-plan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { resolveCatalogOfficialExternalNpmPackageTrust } from "../plugins/official-external-install-trust.js";

function createSourceCheckoutPlugin(pluginId: string): {
  packageRoot: string;
  pluginRoot: string;
} {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-plan-"));
  fs.mkdirSync(path.join(packageRoot, ".git"));
  fs.mkdirSync(path.join(packageRoot, "src"));
  fs.mkdirSync(path.join(packageRoot, "extensions"));
  const pluginRoot = path.join(packageRoot, "dist", "extensions", pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
  fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
  return { packageRoot, pluginRoot };
}

describe("plugin install plan helpers", () => {
  it.each([" ClAwHuB:demo@ "])(
    "rejects the malformed explicit ClawHub selector %s before npm fallback",
    (raw) => {
      expect(resolvePluginInstallSourcePlan({ raw, mode: "install" })).toEqual({
        ok: false,
        error: `Unsupported ClawHub plugin spec: ${raw}`,
      });
    },
  );

  it("keeps explicit npm specs with local-looking suffixes on the registry path", () => {
    expect(resolvePluginInstallSourcePlan({ raw: "npm:plugin.js", mode: "install" })).toMatchObject(
      {
        ok: true,
        request: { source: "npm", spec: "plugin.js" },
      },
    );
  });

  it("trusts exact official external npm packages without remapping the spec", () => {
    const result = resolveCatalogOfficialExternalNpmPackageTrust(
      "@wecom/wecom-openclaw-plugin@2026.7.2",
    );

    expect(result).toEqual({
      pluginId: "wecom-openclaw-plugin",
      expectedIntegrity:
        "sha512-7kqdBIOF3SgDDoBoFtO6jxnxofbYSgbKdxZDNabD0y0jg2xKcVqlXZOOJ9+XQho/QOtIFrnRH2IRnPukFEYwJg==",
      trustedSourceLinkedOfficialInstall: true,
    });
  });

  it("does not trust npm package names outside the official external catalog", () => {
    const result = resolveCatalogOfficialExternalNpmPackageTrust("@acme/outside@1.0.0");

    expect(result).toBeNull();
  });

  it("rejects npm-spec matches that resolve to a different plugin id", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "npmSpec") {
          return {
            pluginId: "not-voice-call",
            localPath: installedPluginRoot("/tmp", "not-voice-call"),
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

  it("rejects plugin-id bundled matches when the catalog npm spec was overridden", () => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === "pluginId") {
          return {
            pluginId: "whatsapp",
            localPath: installedPluginRoot("/tmp", "whatsapp"),
            npmSpec: "@openclaw/whatsapp",
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

  it("does not fall back to source checkout bundles after npm package-not-found", () => {
    const { packageRoot, pluginRoot } = createSourceCheckoutPlugin("codex");
    try {
      const findBundledSource = vi.fn().mockReturnValue({
        pluginId: "codex",
        localPath: pluginRoot,
        npmSpec: "@openclaw/codex",
      });

      const result = resolveBundledInstallPlanForNpmFailure({
        rawSpec: "@openclaw/codex",
        code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
        findBundledSource,
      });

      expect(result).toBeNull();
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("allows bare plugin ids to fall back to source checkout bundles", () => {
    const { packageRoot, pluginRoot } = createSourceCheckoutPlugin("codex");
    try {
      const findBundledSource = vi.fn().mockReturnValue({
        pluginId: "codex",
        localPath: pluginRoot,
        npmSpec: "@openclaw/codex",
      });

      const result = resolveBundledInstallPlanForNpmFailure({
        rawSpec: "codex",
        code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
        findBundledSource,
      });

      expect(result?.bundledSource.pluginId).toBe("codex");
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
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
