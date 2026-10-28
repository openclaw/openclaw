import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { joinClawHubPluginCatalog } from "./catalog-discovery.js";
import {
  emptyMetadataSnapshot,
  hostedDiffsEntry,
  metadataSnapshot,
  mockHostedOfficialCatalog,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  providerAuthChoices: vi.fn(),
  pluginVersionCategories: vi.fn(),
  pluginDetail: vi.fn(),
  recommendedInstalls: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: (...args: unknown[]) => mocks.providerAuthChoices(...args),
}));

vi.mock("../infra/clawhub-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-plugin-catalog.js")>()),
  fetchClawHubPluginVersionCategories: (...args: unknown[]) =>
    mocks.pluginVersionCategories(...args),
  fetchClawHubPluginDetail: (...args: unknown[]) => mocks.pluginDetail(...args),
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: (...args: unknown[]) => mocks.recommendedInstalls(...args),
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const {
  listManagedPlugins,
  resolveManagedPluginIconSources,
  resolveManagedPluginActivityIconSource,
  resolveManagedSetupCatalogIconUrl,
} = await import("./management-service.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const listLocalPlugins = (config: OpenClawConfig = {}) =>
  listManagedPlugins({ config, env: {}, officialCatalog: { entries: [] } });
const iconSources = (pluginId: string, config: OpenClawConfig = {}, env = {}) =>
  resolveManagedPluginIconSources({ config, env, pluginId });
const activityIcon = (pluginId: string, toolName?: string) =>
  resolveManagedPluginActivityIconSource({ config: {}, env: {}, pluginId, toolName });
const mockMetadata = (params: Parameters<typeof metadataSnapshot>[0]) =>
  mocks.metadata.mockReturnValue(metadataSnapshot(params));
const categoryRequest = (baseUrl = "https://clawhub.ai", version = "4.5.6") => ({
  baseUrl,
  skipAuth: true,
  packages: [{ name: "community/memory", version }],
});
function installedMemory(clawhubUrl?: string, version = "4.5.6", materialize = false) {
  const metadata = metadataSnapshot({
    enabled: true,
    id: "community-memory",
    name: "Community Memory",
    origin: "global",
    packageVersion: "4.5.6",
    installRecord: { source: "clawhub", clawhubUrl, clawhubPackage: "community/memory", version },
  });
  if (materialize) {
    const root = tempDirs.make("managed-plugin-installed-");
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    metadata.index.plugins[0]!.rootDir = root;
    metadata.byPluginId.get("community-memory")!.rootDir = root;
    metadata.index.installRecords["community-memory"]!.installPath = root;
  }
  return metadata;
}

describe("managed plugin catalog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

  beforeEach(() => {
    clearManagedPluginCatalogCache();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.providerAuthChoices.mockReturnValue([]);
    mocks.pluginVersionCategories.mockResolvedValue([]);
    mocks.pluginDetail.mockResolvedValue({});
    mocks.recommendedInstalls.mockReturnValue([]);
    mockHostedOfficialCatalog(mocks.officialCatalog, []);
  });

  it.each([true, false])(
    "reports native web UI from the selected installed manifest (%s)",
    async (native) => {
      const snapshot = metadataSnapshot({ enabled: false });
      snapshot.plugins[0]!.uiCapabilities = ["page"];
      if (native) {
        snapshot.plugins[0]!.controlUi = { entry: "dist/browser/index.js" };
      }
      mocks.metadata.mockReturnValue(snapshot);
      const result = await listLocalPlugins();
      expect(result.plugins[0]).toMatchObject({ id: "workboard", hasNativeUi: native });
    },
  );

  describe("authored credential validation", () => {
    const secretRef = { source: "store", provider: "default", id: "TEST_PLUGIN_KEY" };
    const configured = (config?: Record<string, unknown>, enabled = true): OpenClawConfig => ({
      plugins: { entries: { "ref-plugin": { enabled, ...(config ? { config } : {}) } } },
    });

    beforeEach(() => {
      mockMetadata({
        enabled: true,
        id: "ref-plugin",
        configSchema: {
          type: "object",
          required: ["apiKey"],
          properties: {
            apiKey: { type: "object" },
          },
        },
      });
    });

    it.each(["active", "captured"])(
      "validates the %s runtime's authored refs across a catalog await",
      async (mode) => {
        const source = configured({ apiKey: secretRef });
        const runtime = configured({ apiKey: "synthetic-resolved-value" });
        setRuntimeConfigSnapshot(runtime, source);
        const config = mode === "captured" ? captureRuntimeConfig(runtime) : runtime;
        // Captured requests can already predate the current publication on entry.
        if (mode === "captured") {
          setRuntimeConfigSnapshot(configured(), configured());
        }
        mocks.officialCatalog.mockImplementationOnce(async () => {
          setRuntimeConfigSnapshot(configured(), configured({ apiKey: 42 }));
          return { source: "hosted", entries: [] };
        });

        const catalog = await listManagedPlugins({ config, env: {} });

        expect(catalog.plugins[0]).toMatchObject({ id: "ref-plugin", state: "enabled" });
        expect(catalog.plugins[0]).not.toHaveProperty("error");
        expect(runtime.plugins?.entries?.["ref-plugin"]?.config?.apiKey).toBe(
          "synthetic-resolved-value",
        );
        expect(source.plugins?.entries?.["ref-plugin"]?.config?.apiKey).toEqual(secretRef);
      },
    );

    it.each([
      ["invalid authored config", { apiKey: "synthetic-invalid-plaintext" }, "error"],
      ["missing authored config", undefined, "needs-setup"],
    ] as const)("preserves %s", async (_name, authoredConfig, state) => {
      const source = configured(authoredConfig, false);
      const runtime = configured({ apiKey: secretRef }, false);
      setRuntimeConfigSnapshot(runtime, source);

      const catalog = await listManagedPlugins({ config: runtime, env: {} });

      expect(catalog.plugins[0]).toMatchObject({ state });
      if (state === "error") {
        expect(catalog.plugins[0]?.error).toBe("apiKey: must be object");
      }
    });

    it("does not replace an explicit candidate with the active source", async () => {
      setRuntimeConfigSnapshot(
        configured({ apiKey: "synthetic-resolved-value" }),
        configured({ apiKey: secretRef }),
      );
      const candidate = configured({ apiKey: "synthetic-invalid-candidate" });

      const catalog = await listManagedPlugins({ config: candidate, env: {} });

      expect(catalog.plugins[0]).toMatchObject({
        state: "error",
        error: "apiKey: must be object",
      });
    });
  });

  it("does not transfer bundled endorsement to a package identity impostor", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mockHostedOfficialCatalog(mocks.officialCatalog, [
      {
        ...hostedDiffsEntry,
        name: "community/impostor",
        openclaw: {
          ...hostedDiffsEntry.openclaw,
          install: { clawhubSpec: "clawhub:community/impostor", defaultChoice: "clawhub" },
        },
      },
    ]);

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([]);
  });

  const privateRegistry = "https://private.example/clawhub";
  it.each([
    ["foreign registry", "clawhub", `${privateRegistry}/`, undefined, false],
    ["public registry", "clawhub", "https://clawhub.ai/", undefined, true],
    ["custom primary override", "clawhub", `${privateRegistry}/`, privateRegistry, true],
    [
      "custom secondary override",
      "clawhub",
      `${privateRegistry}/`,
      privateRegistry,
      true,
      "CLAWHUB_URL",
    ],
    ["different custom registry", "clawhub", "https://other.example/", privateRegistry, false],
    ["public npm counterpart", "npm", undefined, undefined, true],
    ["public npm counterpart on custom registry", "npm", undefined, privateRegistry, false],
    ["unproven registry", "clawhub", undefined, undefined, false],
  ] as const)(
    "binds remote discovery to the effective registry: %s",
    async (
      _label,
      source,
      clawhubUrl,
      activeRegistry,
      matches,
      registryEnv: "OPENCLAW_CLAWHUB_URL" | "CLAWHUB_URL" = "OPENCLAW_CLAWHUB_URL",
    ) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", undefined);
      vi.stubEnv("CLAWHUB_URL", undefined);
      vi.stubEnv(registryEnv, activeRegistry);
      const packageName = "@openclaw/diffs";
      mockMetadata({
        enabled: false,
        id: "diffs",
        origin: "global",
        categories: ["tools"],
        installRecord:
          source === "clawhub"
            ? { source, clawhubUrl, clawhubPackage: packageName, version: "1.0.0" }
            : { source, spec: packageName, resolvedName: packageName },
      });

      const local = await listLocalPlugins();
      const [entry] = joinClawHubPluginCatalog({
        local,
        remote: [
          {
            packageName,
            displayName: "Remote Diffs",
            family: "code-plugin",
            isOfficial: true,
            categories: ["tools"],
          },
        ],
      });

      expect(local.plugins[0]).toMatchObject({ id: "diffs", installed: true });
      expect(entry?.local).toMatchObject({
        installed: matches,
        action: matches ? "manage" : "install",
      });
      expect(entry?.local.pluginId).toBe(matches ? "diffs" : undefined);
      const sources = await iconSources("diffs");
      const expectedRegistry =
        source === "npm" ? "https://clawhub.ai" : clawhubUrl?.replace(/\/+$/, "");
      expect(sources).toEqual(
        expectedRegistry ? [{ kind: "clawhub", baseUrl: expectedRegistry, packageName }] : [],
      );
      expect(local.plugins[0]?.hasIcon).toBe(expectedRegistry ? true : undefined);
    },
  );

  it.each([
    { enabled: true, contracts: { videoGenerationProviders: ["video"] }, expected: ["media"] },
    { enabled: true, contracts: { imageGenerationProviders: ["image"] }, expected: ["media"] },
    { enabled: true, contracts: { musicGenerationProviders: ["music"] }, expected: ["media"] },
    { enabled: false, contracts: { videoGenerationProviders: ["video"] }, expected: undefined },
    { enabled: true, contracts: { speechProviders: ["speech"] }, expected: undefined },
  ])(
    "derives Media discovery only for enabled generation plugins (%j)",
    async ({ enabled, contracts, expected }) => {
      mockMetadata({
        enabled,
        id: "model-provider",
        categories: ["models"],
        contracts,
      });
      const catalog = await listLocalPlugins({
        plugins: { entries: { "model-provider": { enabled } } },
      });
      const plugin = expectDefined(catalog.plugins[0], "managed model provider");
      expect(plugin.categories).toEqual(["models"]);
      expect(plugin.enabled).toBe(enabled);
      if (expected) {
        expect(plugin).toHaveProperty("capabilityCategories", expected);
      } else {
        expect(plugin).not.toHaveProperty("capabilityCategories");
      }
      expect(mocks.pluginVersionCategories).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "serves installed rows during category enrichment (offline: %s)",
    async (offline) => {
      mocks.metadata.mockReturnValue(installedMemory("https://clawhub.ai", "4.5.6", true));
      const categories =
        createDeferred<Array<{ name: string; version: string; categories: string[] }>>();
      mocks.pluginVersionCategories.mockReturnValue(categories.promise);
      const params = {
        config: {},
        env: {},
        officialCatalog: { entries: [] },
        cachedCatalogOnly: true,
      };
      const pending = listManagedPlugins(params);
      try {
        const first = await Promise.race([pending, nextTurn().then(() => undefined)]);
        expect(first?.plugins).toContainEqual(
          expect.objectContaining({ id: "community-memory", installed: true }),
        );
        expect(first?.diagnostics).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining("pending") }),
        );
      } finally {
        if (offline) {
          categories.reject(new Error("offline"));
        } else {
          categories.resolve([
            { name: "community/memory", version: "4.5.6", categories: ["memory", "tools"] },
          ]);
        }
        await pending;
      }
      const prepared = await listLocalPlugins();
      expect(await listManagedPlugins(params)).toEqual(prepared);
      expect(prepared.plugins[0]).toMatchObject({
        id: "community-memory",
        installed: true,
        enabled: true,
        state: "enabled",
        clawhubPackage: "community/memory",
      });
      expect(prepared.plugins[0]?.categories).toEqual(offline ? undefined : ["memory", "tools"]);
      expect(prepared.plugins[0]).not.toHaveProperty("category");
      if (offline) {
        expect(prepared.plugins[0]).not.toHaveProperty("categories");
        expect(prepared.diagnostics).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining("unavailable") }),
        );
      }
      expect(mocks.pluginVersionCategories).toHaveBeenCalledOnce();
      expect(mocks.pluginVersionCategories).toHaveBeenCalledWith(categoryRequest());
    },
  );

  it.each(["registry", "version"])(
    "keeps category enrichment scoped to the installed ClawHub %s",
    async (scope) => {
      mocks.pluginVersionCategories.mockImplementation(
        async ({
          baseUrl,
          packages,
        }: {
          baseUrl: string;
          packages: Array<{ version: string }>;
        }) => [
          {
            name: "community/memory",
            version: packages[0]?.version,
            categories: [
              baseUrl.includes("private") && packages[0]?.version === "4.5.6" ? "tools" : "memory",
            ],
          },
        ],
      );

      mocks.metadata.mockReturnValue(installedMemory("https://private.example/clawhub/"));
      const privateCatalog = await listLocalPlugins();
      const nextUrl =
        scope === "registry" ? "https://public.example" : "https://private.example/clawhub";
      const nextVersion = scope === "version" ? "7.8.9" : "4.5.6";
      mocks.metadata.mockReturnValue(installedMemory(nextUrl, nextVersion));
      const publicCatalog = await listLocalPlugins();

      expect(mocks.pluginVersionCategories.mock.calls).toEqual([
        [categoryRequest("https://private.example/clawhub")],
        [categoryRequest(nextUrl, nextVersion)],
      ]);
      expect(privateCatalog.plugins[0]?.categories).toEqual(["tools"]);
      expect(publicCatalog.plugins[0]?.categories).toEqual(["memory"]);
    },
  );

  it.each(["installed", "official"] as const)(
    "does not project or resolve %s manifest icon URLs",
    async (origin) => {
      const id = "workboard";
      const icon = "https://cdn.example.test/icon.svg";
      const metadata =
        origin === "installed" ? metadataSnapshot({ enabled: false }) : emptyMetadataSnapshot();
      if (origin === "installed") {
        Object.assign(expectDefined(metadata.byPluginId.get(id), "icon fixture"), { icon });
      }
      mocks.metadata.mockReturnValue(metadata);
      const officialCatalog = {
        entries:
          origin === "official"
            ? [
                {
                  name: "@openclaw/workboard",
                  openclaw: {
                    plugin: { id },
                    catalog: { featured: true },
                    icon,
                  },
                },
              ]
            : [],
      };
      const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
      expect(catalog.plugins[0]).toMatchObject({ id });
      expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
      expect(catalog.plugins[0]).not.toHaveProperty("icon");
      expect(await iconSources(id)).toEqual([]);
    },
  );

  it("resolves the portable package icon", async () => {
    const iconPath = "/tmp/workboard/assets/icon.png";
    mockMetadata({
      enabled: false,
      iconPath,
      channels: ["workboard-chat"],
    });

    const catalog = await listManagedPlugins({ config: {}, env: {} });
    const resolved = await iconSources("workboard");

    expect(catalog.plugins[0]).toMatchObject({
      id: "workboard",
      hasIcon: true,
      channelIds: ["workboard-chat"],
    });
    expect(resolved).toEqual([{ kind: "file", path: iconPath, rootPath: "/tmp/workboard" }]);
    expect(catalog.plugins[0]).not.toHaveProperty("hasActivityIcon");
    expect(catalog.plugins[0]).not.toHaveProperty("activityIconTools");
    expect(await activityIcon("workboard")).toBeUndefined();
  });

  it.each([
    ["external publisher, including an OpenClaw package scope", "global", "clawhub", "alice", true],
    ["OpenClaw publisher", "global", "clawhub", "OpenClaw", false],
    ["unknown publisher", "global", "clawhub", undefined, false],
    ["bundled plugin", "bundled", "clawhub", "alice", false],
    ["npm scope is not publisher provenance", "global", "npm", "alice", false],
    ["local package is not publisher provenance", "global", "path", "alice", false],
  ] as const)(
    "gates tool branding on authoritative provenance: %s",
    async (_label, origin, source, ownerHandle, eligible) => {
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          enabled: true,
          origin,
          iconPath: "/tmp/workboard/assets/icon.png",
          categories: ["tools"],
          installRecord: {
            source,
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "@openclaw/workboard",
            spec: "@openclaw/workboard",
          },
        }),
      );
      mocks.pluginDetail.mockResolvedValue({ ownerHandle });

      const catalog = await listLocalPlugins();

      expect(catalog.plugins[0]?.hasIcon).toBe(true);
      expect(catalog.plugins[0]?.hasToolBrandIcon).toBe(eligible ? true : undefined);
      expect(mocks.pluginDetail).toHaveBeenCalledTimes(
        origin !== "bundled" && source === "clawhub" ? 1 : 0,
      );
    },
  );

  it("prepares registry-scoped tool publisher facts without blocking the cold list", async () => {
    const installed = (clawhubUrl: string) =>
      metadataSnapshot({
        enabled: true,
        origin: "global",
        categories: ["tools"],
        installRecord: { source: "clawhub", clawhubUrl, clawhubPackage: "community/workboard" },
      });
    mocks.metadata.mockReturnValue(installed("https://clawhub.ai"));
    const detail = createDeferred<{ ownerHandle: string }>();
    mocks.pluginDetail.mockReturnValue(detail.promise);
    const params = {
      config: {},
      env: {},
      officialCatalog: { entries: [] },
      cachedCatalogOnly: true,
    };
    const first = await listManagedPlugins(params);
    expect(first.plugins[0]?.hasIcon).toBe(true);
    expect(first.plugins[0]).not.toHaveProperty("hasToolBrandIcon");
    detail.resolve({ ownerHandle: "alice" });
    expect((await listLocalPlugins()).plugins[0]?.hasToolBrandIcon).toBe(true);
    expect((await listManagedPlugins(params)).plugins[0]?.hasToolBrandIcon).toBe(true);
    expect(mocks.pluginDetail).toHaveBeenCalledOnce();
    expect(mocks.pluginDetail).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      packageName: "community/workboard",
      skipAuth: true,
    });

    mocks.metadata.mockReturnValue(installed("https://private.example/clawhub"));
    mocks.pluginDetail.mockRejectedValue(new Error("offline"));
    expect((await listLocalPlugins()).plugins[0]).not.toHaveProperty("hasToolBrandIcon");
    await listLocalPlugins();
    expect(mocks.pluginDetail).toHaveBeenCalledTimes(2);
    clearManagedPluginCatalogCache();
    mocks.pluginDetail.mockResolvedValue({ ownerHandle: "openclaw" });
    expect((await listLocalPlugins()).plugins[0]).not.toHaveProperty("hasToolBrandIcon");
    expect(mocks.pluginDetail).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    "resolves exact tool activity icons with default=%s without exposing paths",
    async (hasDefault) => {
      const activityIconPath = "/tmp/workboard/assets/activity.svg";
      const searchPath = "/tmp/workboard/assets/activity/Task.Search.svg";
      const protoPath = "/tmp/workboard/assets/activity/__proto__.svg";
      const taskPath = "/tmp/workboard/assets/activity/task.svg";
      mockMetadata({
        enabled: hasDefault,
        activityIconPath: hasDefault ? activityIconPath : undefined,
        toolActivityIconPaths: hasDefault
          ? Object.fromEntries([
              ["__proto__", protoPath],
              ["Task.Search", searchPath],
            ])
          : { task: taskPath },
      });
      const catalog = await listLocalPlugins();
      expect(catalog.plugins[0]).toMatchObject({
        id: "workboard",
        activityIconTools: hasDefault ? ["Task.Search", "__proto__"] : ["task"],
      });
      if (hasDefault) {
        expect(catalog.plugins[0]).toHaveProperty("hasActivityIcon", true);
      } else {
        expect(catalog.plugins[0]).not.toHaveProperty("hasActivityIcon");
      }
      expect(catalog.plugins[0]).not.toHaveProperty("activityIconPath");
      expect(catalog.plugins[0]).not.toHaveProperty("toolActivityIconPaths");
      expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
      const probes: Array<[string | undefined, string | undefined]> = hasDefault
        ? [
            [undefined, activityIconPath],
            ["Task.Search", searchPath],
            ["task.search", activityIconPath],
            ["__proto__", protoPath],
            ["toString", activityIconPath],
          ]
        : [
            ["task", taskPath],
            [undefined, undefined],
          ];
      for (const [toolName, expectedPath] of probes) {
        expect(await activityIcon("workboard", toolName)).toEqual(
          expectedPath
            ? { kind: "file", path: expectedPath, rootPath: "/tmp/workboard" }
            : undefined,
        );
      }
      expect(await activityIcon("absent", "Task.Search")).toBeUndefined();
    },
  );

  it("allows only provider-choice and bundled setup catalog icon URLs", async () => {
    const providerIcon = "https://cdn.example.test/provider.svg";
    const recommendedIcon = "https://cdn.example.test/tool.png";
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.providerAuthChoices.mockReturnValue([{ choiceId: "provider", icon: providerIcon }]);
    mocks.recommendedInstalls.mockReturnValue([{ id: "tool", icon: recommendedIcon }]);
    const resolve = (iconUrl: string) => resolveManagedSetupCatalogIconUrl({ config: {}, iconUrl });
    expect(resolve(providerIcon)).toBe(providerIcon);
    expect(resolve(`${" ".repeat(2048)}${providerIcon} `)).toBe(providerIcon);
    expect(resolve(recommendedIcon)).toBe(recommendedIcon);
    expect(resolve("https://untrusted.example/icon.png")).toBeUndefined();
    expect(resolve("http://127.0.0.1/private.png")).toBeUndefined();
    expect(mocks.providerAuthChoices).toHaveBeenCalledWith({
      config: {},
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
  });
});
