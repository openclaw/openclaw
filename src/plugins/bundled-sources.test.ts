import { beforeEach, describe, expect, it, vi } from "vitest";
import { findBundledPluginSource, resolveBundledPluginSources } from "./bundled-sources.js";

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

  it("omits npmSpec for private bundled packages without explicit install.npmSpec", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/memory-lancedb",
          packageName: "@openclaw/memory-lancedb",
          packagePrivate: true,
          packageManifest: {},
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/voice-call",
          packageName: "@openclaw/voice-call",
          packagePrivate: true,
          packageManifest: { install: { npmSpec: "@openclaw/voice-call" } },
        },
        {
          origin: "bundled",
          rootDir: "/app/extensions/feishu",
          packageName: "@openclaw/feishu",
          packageManifest: { install: { npmSpec: "@openclaw/feishu" } },
        },
      ],
      diagnostics: [],
    });

    loadPluginManifestMock.mockImplementation((rootDir: string) => {
      if (rootDir === "/app/extensions/memory-lancedb") {
        return { ok: true, manifest: { id: "memory-lancedb" } };
      }
      if (rootDir === "/app/extensions/voice-call") {
        return { ok: true, manifest: { id: "voice-call" } };
      }
      if (rootDir === "/app/extensions/feishu") {
        return { ok: true, manifest: { id: "feishu" } };
      }
      return { ok: false, error: "not found", manifestPath: `${rootDir}/openclaw.plugin.json` };
    });

    const map = resolveBundledPluginSources({});

    // Private package without explicit npmSpec should have no npmSpec
    expect(map.get("memory-lancedb")).toEqual({
      pluginId: "memory-lancedb",
      localPath: "/app/extensions/memory-lancedb",
      npmSpec: undefined,
    });

    // Private package WITH explicit install.npmSpec should keep its npmSpec
    expect(map.get("voice-call")).toEqual({
      pluginId: "voice-call",
      localPath: "/app/extensions/voice-call",
      npmSpec: "@openclaw/voice-call",
    });

    // Non-private package should use packageName as npmSpec fallback
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

    const resolved = findBundledPluginSource({
      lookup: { kind: "npmSpec", value: "@openclaw/feishu" },
    });
    const missing = findBundledPluginSource({
      lookup: { kind: "npmSpec", value: "@openclaw/not-found" },
    });

    expect(resolved?.pluginId).toBe("feishu");
    expect(resolved?.localPath).toBe("/app/extensions/feishu");
    expect(missing).toBeUndefined();
  });

  it("finds bundled source by plugin id", () => {
    discoverOpenClawPluginsMock.mockReturnValue({
      candidates: [
        {
          origin: "bundled",
          rootDir: "/app/extensions/diffs",
          packageName: "@openclaw/diffs",
          packageManifest: { install: { npmSpec: "@openclaw/diffs" } },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestMock.mockReturnValue({ ok: true, manifest: { id: "diffs" } });

    const resolved = findBundledPluginSource({
      lookup: { kind: "pluginId", value: "diffs" },
    });
    const missing = findBundledPluginSource({
      lookup: { kind: "pluginId", value: "not-found" },
    });

    expect(resolved?.pluginId).toBe("diffs");
    expect(resolved?.localPath).toBe("/app/extensions/diffs");
    expect(missing).toBeUndefined();
  });
});
