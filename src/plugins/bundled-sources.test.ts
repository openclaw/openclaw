import { beforeEach, describe, expect, it, vi } from "vitest";
import { findBundledPluginByNpmSpec, resolveBundledPluginSources } from "./bundled-sources.js";

const discoverOpenClawPluginsMock = vi.fn();
const loadPluginManifestMock = vi.fn();

vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
}));

vi.mock("./manifest.js", () => ({
  loadPluginManifest: (...args: unknown[]) => loadPluginManifestMock(...args),
}));

describe("bundled plugin sources", () => {
  beforeEach(() => {
    discoverOpenClawPluginsMock.mockReset();
    loadPluginManifestMock.mockReset();
  });

  it("resolves bundled sources keyed by plugin id", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "global",
          rootDir: "/global/feishu",
          packageName: "@openclaw/feishu",
          packageManifest: { install: { npmSpec: "@openclaw/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu",
          packageName: "@openclaw/feishu",
          packageManifest: { install: { npmSpec: "@openclaw/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu-dup",
          packageName: "@openclaw/feishu",
          packageManifest: { install: { npmSpec: "@openclaw/feishu" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/msteams",
          packageName: "@openclaw/msteams",
          packageManifest: { install: { npmSpec: "@openclaw/msteams" } },
        },
      ],
      diagnostics: [],
    });

    loadPluginManifestMock.mockImplementation((rootDir: string) => {
      if (rootDir === "/app/extensions/feishu") {
        return { ok: true, manifest: { id: "feishu" } };
      }
      if (rootDir === "/app/extensions/msteams") {
        return { ok: true, manifest: { id: "msteams" } };
      }
      return {
        ok: false,
        error: "invalid manifest",
        manifestPath: `${rootDir}/openclaw.plugin.json`,
      };
    });

    const map = resolveBundledPluginSources({});

    expect(Array.from(map.keys())).toEqual(["feishu", "msteams"]);
    expect(map.get("feishu")).toEqual({
      pluginId: "feishu",
      localPath: "/app/extensions/feishu",
      npmSpec: "@openclaw/feishu",
    });
  });

  it("finds bundled source by npm spec", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu",
          packageName: "@openclaw/feishu",
          packageManifest: { install: { npmSpec: "@openclaw/feishu" } },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestMock.mockReturnValue({ ok: true, manifest: { id: "feishu" } });

    const resolved = findBundledPluginByNpmSpec({ spec: "@openclaw/feishu" });
    const missing = findBundledPluginByNpmSpec({ spec: "@openclaw/not-found" });

    expect(resolved?.pluginId).toBe("feishu");
    expect(resolved?.localPath).toBe("/app/extensions/feishu");
    expect(missing).toBeUndefined();
  });
});
