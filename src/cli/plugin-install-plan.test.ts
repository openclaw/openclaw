// Plugin install plan tests cover install planning for local, registry, and bundled plugins.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveBundledInstallPlanForCatalogEntry,
  resolvePluginInstallSourcePlan,
} from "../plugins/install-source-plan.js";
import { resolveCatalogOfficialExternalNpmPackageTrust } from "../plugins/official-external-install-trust.js";

describe("plugin install plan helpers", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "selects the local source a symlinked parent path names, not its lexical sibling",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-install-plan-"));
      tempDirs.push(root);
      fs.mkdirSync(path.join(root, "physical", "nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "physical", "selected-sibling"));
      fs.mkdirSync(path.join(root, "selected-sibling"));
      fs.symlinkSync(path.join(root, "physical", "nested"), path.join(root, "selected"), "dir");

      const plan = resolvePluginInstallSourcePlan({
        raw: `${root}${path.sep}selected${path.sep}..${path.sep}selected-sibling`,
        mode: "install",
      });

      // `selected/../selected-sibling` names `physical/selected-sibling` for the filesystem.
      expect(plan).toMatchObject({
        ok: true,
        request: { source: "local", path: path.join(root, "physical", "selected-sibling") },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps trimming surrounding whitespace from an accepted local source",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-install-plan-"));
      tempDirs.push(root);
      fs.mkdirSync(path.join(root, "plugin"));

      const plan = resolvePluginInstallSourcePlan({ raw: `${root}/plugin `, mode: "install" });

      expect(plan).toMatchObject({
        ok: true,
        request: { source: "local", path: path.join(root, "plugin") },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a not-found plan when a regular file blocks the parent traversal",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-install-plan-"));
      tempDirs.push(root);
      fs.writeFileSync(path.join(root, "file"), "");

      const plan = resolvePluginInstallSourcePlan({
        raw: `${root}/file/child/plugin`,
        mode: "install",
      });

      expect(plan).toMatchObject({
        ok: false,
        error: `Plugin path not found: ${root}/file/child/plugin`,
      });
    },
  );

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
