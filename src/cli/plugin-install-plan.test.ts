// Plugin install plan tests cover install planning for local, registry, and bundled plugins.
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  resolveBundledInstallPlanForCatalogEntry,
  resolvePluginInstallSourcePlan,
} from "../plugins/install-source-plan.js";
import { resolveCatalogOfficialExternalNpmPackageTrust } from "../plugins/official-external-install-trust.js";

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

  it.each([
    [
      "rejects npm-spec matches that resolve to a different plugin id",
      "npmSpec",
      { pluginId: "voice-call", npmSpec: "@openclaw/voice-call" },
      { pluginId: "not-voice-call", npmSpec: "@openclaw/voice-call" },
    ],
    [
      "rejects plugin-id bundled matches when the catalog npm spec was overridden",
      "pluginId",
      { pluginId: "whatsapp", npmSpec: "@vendor/whatsapp-fork" },
      { pluginId: "whatsapp", npmSpec: "@openclaw/whatsapp" },
    ],
  ] as const)("%s", (_name, matchKind, catalog, bundled) => {
    const findBundledSource = vi
      .fn()
      .mockImplementation(({ kind }: { kind: "pluginId" | "npmSpec"; value: string }) => {
        if (kind === matchKind) {
          return {
            pluginId: bundled.pluginId,
            localPath: installedPluginRoot("/tmp", bundled.pluginId),
            npmSpec: bundled.npmSpec,
          };
        }
        return undefined;
      });

    const result = resolveBundledInstallPlanForCatalogEntry({
      ...catalog,
      findBundledSource,
    });

    expect(result).toBeNull();
  });
});
