import { beforeEach, describe, expect, it, vi } from "vitest";

type DiscoverOpenClawPlugins = typeof import("./discovery.js").discoverOpenClawPlugins;
type LoadPluginManifest = typeof import("./manifest.js").loadPluginManifest;
type ResolveManifestProviderAuthChoices =
  typeof import("./provider-auth-choices.js").resolveManifestProviderAuthChoices;

const discoverOpenClawPlugins = vi.hoisted(() =>
  vi.fn<DiscoverOpenClawPlugins>(() => ({ candidates: [], diagnostics: [] })),
);
vi.mock("./discovery.js", () => ({
  discoverOpenClawPlugins,
}));

const loadPluginManifest = vi.hoisted(() => vi.fn<LoadPluginManifest>());
vi.mock("./manifest.js", async () => {
  const actual = await vi.importActual<typeof import("./manifest.js")>("./manifest.js");
  return {
    ...actual,
    loadPluginManifest,
  };
});

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoices>(() => []),
);
vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
}));

import {
  resolveProviderInstallCatalogEntries,
  resolveProviderInstallCatalogEntry,
} from "./provider-install-catalog.js";

describe("provider install catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [],
      diagnostics: [],
    });
    resolveManifestProviderAuthChoices.mockReturnValue([]);
  });

  it("merges manifest auth-choice metadata with discovery install metadata", () => {
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "openai",
          origin: "bundled",
          rootDir: "/repo/extensions/openai",
          source: "/repo/extensions/openai/index.ts",
          workspaceDir: "/repo",
          packageName: "@openclaw/openai",
          packageDir: "/repo/extensions/openai",
          packageManifest: {
            install: {
              npmSpec: "@openclaw/openai",
              defaultChoice: "npm",
              expectedIntegrity: "sha512-openai",
            },
          },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifest.mockReturnValue({
      ok: true,
      manifestPath: "/repo/extensions/openai/openclaw.plugin.json",
      manifest: {
        id: "openai",
        configSchema: {
          type: "object",
        },
      },
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai",
          localPath: "extensions/openai",
          defaultChoice: "npm",
          expectedIntegrity: "sha512-openai",
        },
      },
    ]);
  });

  it("falls back to package name and workspace-relative local path when install metadata is sparse", () => {
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "demo-provider",
          origin: "workspace",
          rootDir: "/repo/extensions/demo-provider",
          source: "/repo/extensions/demo-provider/index.ts",
          workspaceDir: "/repo",
          packageName: "@vendor/demo-provider",
          packageDir: "/repo/extensions/demo-provider",
          packageManifest: {},
        },
      ],
      diagnostics: [],
    });
    loadPluginManifest.mockReturnValue({
      ok: true,
      manifestPath: "/repo/extensions/demo-provider/openclaw.plugin.json",
      manifest: {
        id: "demo-provider",
        configSchema: {
          type: "object",
        },
      },
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
      },
    ]);

    expect(resolveProviderInstallCatalogEntries()).toEqual([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
        label: "Demo Provider API key",
        origin: "workspace",
        install: {
          npmSpec: "@vendor/demo-provider",
          localPath: "extensions/demo-provider",
          defaultChoice: "local",
        },
      },
    ]);
  });

  it("resolves one installable auth choice by id", () => {
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "vllm",
          origin: "global",
          rootDir: "/Users/test/.openclaw/extensions/vllm",
          source: "/Users/test/.openclaw/extensions/vllm/index.js",
          packageName: "@openclaw/vllm",
          packageDir: "/Users/test/.openclaw/extensions/vllm",
          packageManifest: {
            install: {
              npmSpec: "@openclaw/vllm",
            },
          },
        },
      ],
      diagnostics: [],
    });
    loadPluginManifest.mockReturnValue({
      ok: true,
      manifestPath: "/Users/test/.openclaw/extensions/vllm/openclaw.plugin.json",
      manifest: {
        id: "vllm",
        configSchema: {
          type: "object",
        },
      },
    });
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "vllm",
        providerId: "vllm",
        methodId: "server",
        choiceId: "vllm",
        choiceLabel: "vLLM",
        groupLabel: "vLLM",
      },
    ]);

    expect(resolveProviderInstallCatalogEntry("vllm")).toEqual({
      pluginId: "vllm",
      providerId: "vllm",
      methodId: "server",
      choiceId: "vllm",
      choiceLabel: "vLLM",
      groupLabel: "vLLM",
      label: "vLLM",
      origin: "global",
      install: {
        npmSpec: "@openclaw/vllm",
        defaultChoice: "npm",
      },
    });
  });

  it("skips untrusted workspace install candidates when requested", () => {
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "demo-provider",
          origin: "workspace",
          rootDir: "/repo/extensions/demo-provider",
          source: "/repo/extensions/demo-provider/index.ts",
          workspaceDir: "/repo",
          packageName: "@vendor/demo-provider",
          packageDir: "/repo/extensions/demo-provider",
          packageManifest: {
            install: {
              npmSpec: "@vendor/demo-provider",
            },
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveProviderInstallCatalogEntries({
        config: {
          plugins: {
            enabled: false,
          },
        },
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([]);
    expect(loadPluginManifest).not.toHaveBeenCalled();
  });

  it("skips untrusted workspace candidates without id hints before manifest load", () => {
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "",
          origin: "workspace",
          rootDir: "/repo/extensions/demo-provider",
          source: "/repo/extensions/demo-provider/index.ts",
          workspaceDir: "/repo",
          packageName: "@vendor/demo-provider",
          packageDir: "/repo/extensions/demo-provider",
          packageManifest: {
            install: {
              npmSpec: "@vendor/demo-provider",
            },
          },
        },
      ],
      diagnostics: [],
    });

    expect(
      resolveProviderInstallCatalogEntries({ includeUntrustedWorkspacePlugins: false }),
    ).toEqual([]);
    expect(loadPluginManifest).not.toHaveBeenCalled();
  });
});
