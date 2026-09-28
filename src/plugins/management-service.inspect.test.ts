import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bundleMcp from "./bundle-mcp.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import {
  emptyMetadataSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), officialCatalog: vi.fn(), mcpAuth: vi.fn() }));

vi.mock("../agents/mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: (...args: unknown[]) => mocks.mcpAuth(...args),
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

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { inspectManagedPlugin } = await import("./management-service.js");

describe("managed plugin inspection", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    clearManagedPluginCatalogCache();
    mocks.metadata.mockReset();
    mocks.officialCatalog.mockReset();
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
    mocks.mcpAuth.mockReset();
  });

  it("projects each matching MCP connection's stored OAuth state without credential details", async () => {
    const snapshot = metadataSnapshot({ enabled: true });
    const states = [
      "unauthenticated",
      "pending-authorization",
      "requires-authorization",
      "authorized",
    ] as const;
    const servers = Object.fromEntries(
      states.map((state, i) => [
        `connection-${i}`,
        {
          transport: "streamable-http" as const,
          url: `https://example.test/${state}`,
          auth: "oauth" as const,
        },
      ]),
    );
    snapshot.plugins[0]!.mcpServers = servers;
    mocks.metadata.mockReturnValue({
      ...snapshot,
      manifestRegistry: { plugins: snapshot.plugins, diagnostics: [] },
    });
    mocks.mcpAuth.mockResolvedValue(states.map((state) => ({ state, expiresAt: 100 })));

    const inspection = await inspectManagedPlugin({
      config: { plugins: { entries: { workboard: { enabled: true } } }, mcp: { servers } },
      pluginId: "workboard",
      env: {},
    });

    expect(inspection.mcpAuth).toEqual(
      states.map((state, i) => ({ serverName: `connection-${i}`, state })),
    );
    expect(mocks.mcpAuth).toHaveBeenCalledWith(
      states.map((state, i) =>
        expect.objectContaining({
          serverName: `connection-${i}`,
          serverUrl: `https://example.test/${state}`,
          principal: "operator",
        }),
      ),
    );
  });

  it.each([
    { enabled: false },
    { command: "node" },
    { auth: undefined },
    { oauth: { identity: "per-requester" as const } },
    { oauth: { authProfileId: "existing-account" } },
    { url: "https://other.example.test/mcp" },
  ])("omits ineligible or unrelated MCP credentials: %j", async (override) => {
    const server: McpServerConfig = {
      transport: "streamable-http",
      url: "https://example.test/mcp",
      auth: "oauth",
    };
    const snapshot = metadataSnapshot({ enabled: true });
    snapshot.plugins[0]!.mcpServers = { docs: server };
    mocks.metadata.mockReturnValue({
      ...snapshot,
      manifestRegistry: { plugins: snapshot.plugins, diagnostics: [] },
    });

    const inspection = await inspectManagedPlugin({
      config: {
        plugins: { entries: { workboard: { enabled: true } } },
        mcp: { servers: { docs: { ...server, ...override } } },
      },
      pluginId: "workboard",
      env: {},
    });

    expect(inspection.mcpAuth).toBeUndefined();
    expect(mocks.mcpAuth).not.toHaveBeenCalled();
  });

  it("does not attribute a later plugin's same-name MCP server to the shadowed plugin", async () => {
    const server = { url: "https://example.test/mcp", auth: "oauth" as const };
    const snapshot = metadataSnapshot({ enabled: true });
    snapshot.plugins[0]!.mcpServers = { docs: server };
    const other = { ...snapshot.plugins[0]!, id: "other" };
    mocks.metadata.mockReturnValue({
      ...snapshot,
      manifestRegistry: { plugins: [...snapshot.plugins, other], diagnostics: [] },
    });

    const inspection = await inspectManagedPlugin({
      config: {
        plugins: { entries: { workboard: { enabled: true }, other: { enabled: true } } },
        mcp: { servers: { docs: server } },
      },
      pluginId: "workboard",
      env: {},
    });

    expect(inspection.mcpAuth).toBeUndefined();
    expect(mocks.mcpAuth).not.toHaveBeenCalled();
  });

  it("reuses MCP ownership until config or metadata changes while reading OAuth state live", async () => {
    const server = { url: "https://example.test/mcp", auth: "oauth" as const };
    const snapshot = metadataSnapshot({ enabled: true });
    snapshot.plugins[0]!.mcpServers = { docs: server };
    const other = { ...snapshot.plugins[0]!, id: "other" };
    const metadata = {
      ...snapshot,
      manifestRegistry: { plugins: [...snapshot.plugins, other], diagnostics: [] },
    };
    bindPluginMetadataSnapshotCache(metadata, createPluginCache());
    mocks.metadata.mockReturnValue(metadata);
    const config: OpenClawConfig = {
      plugins: { entries: { workboard: { enabled: true }, other: { enabled: false } } },
      mcp: { servers: { docs: server } },
    };
    const inspect = (currentConfig = config) =>
      inspectManagedPlugin({ config: currentConfig, pluginId: "workboard", env: {} });
    const load = vi.spyOn(bundleMcp, "loadEnabledBundleMcpConfig");
    mocks.mcpAuth.mockResolvedValue([{ state: "unauthenticated" }]);
    expect((await inspect()).mcpAuth).toEqual([{ serverName: "docs", state: "unauthenticated" }]);
    mocks.mcpAuth.mockResolvedValue([{ state: "authorized" }]);
    expect((await inspect()).mcpAuth).toEqual([{ serverName: "docs", state: "authorized" }]);
    expect(load).toHaveBeenCalledOnce();
    expect(mocks.mcpAuth).toHaveBeenCalledTimes(2);

    const shadowedConfig = {
      ...config,
      plugins: { entries: { workboard: { enabled: true }, other: { enabled: true } } },
    };
    expect((await inspect(shadowedConfig)).mcpAuth).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect((await inspect()).mcpAuth).toEqual([{ serverName: "docs", state: "authorized" }]);
    expect(load).toHaveBeenCalledTimes(2);

    const replacement = {
      ...metadata,
      manifestRegistry: { plugins: [other], diagnostics: [] },
    };
    bindPluginMetadataSnapshotCache(replacement, createPluginCache());
    mocks.metadata.mockReturnValue(replacement);
    expect((await inspect(shadowedConfig)).mcpAuth).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(3);
    mocks.metadata.mockReturnValue(metadata);
    expect((await inspect()).mcpAuth).toEqual([{ serverName: "docs", state: "authorized" }]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("omits resolver-owned requester credentials from operator plugin inspection", async () => {
    const server = { url: "https://example.test/mcp", auth: "oauth" as const };
    const snapshot = metadataSnapshot({ enabled: true });
    snapshot.plugins[0]!.mcpServers = { docs: server };
    mocks.metadata.mockReturnValue({
      ...snapshot,
      manifestRegistry: { plugins: snapshot.plugins, diagnostics: [] },
    });
    const registry = createEmptyPluginRegistry();
    registry.mcpServerConnectionResolvers.push({
      pluginId: "workboard",
      source: "/plugins/workboard/index.ts",
      resolver: { serverName: "docs", resolve: async () => null },
    });

    const inspection = await withPluginRuntimeRegistryScope(registry, () =>
      inspectManagedPlugin({
        config: {
          plugins: { entries: { workboard: { enabled: true } } },
          mcp: { servers: { docs: server } },
        },
        pluginId: "workboard",
        env: {},
      }),
    );

    expect(inspection.mcpAuth).toBeUndefined();
    expect(mocks.mcpAuth).not.toHaveBeenCalled();
  });

  it.each([
    { value: undefined, env: {}, status: "missing" },
    { value: "private-literal", env: {}, status: "configured" },
    { value: undefined, env: { ALTERNATIVE_KEY: "private-env" }, status: "configured" },
    {
      value: { source: "file", provider: "vault", id: "/private/key" },
      env: {},
      status: "configured",
    },
    { value: { invalid: true }, env: {}, status: "invalid" },
    { value: "${WORKBOARD_KEY}", env: {}, status: "unresolved", unresolved: true },
  ])(
    "projects only public credential status $status",
    async ({ value, env, status, unresolved }) => {
      mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: true }));
      const registry = createEmptyPluginRegistry();
      registry.webSearchProviders.push({
        pluginId: "workboard",
        source: "/plugins/workboard/index.ts",
        provider: {
          id: "workboard",
          label: "Workboard",
          hint: "Search",
          placeholder: "",
          signupUrl: "",
          credentialPath: "plugins.entries.workboard.config.apiKey",
          credentialLabel: "Workboard key",
          envVars: ["WORKBOARD_KEY", "ALTERNATIVE_KEY"],
          getCredentialValue: () => undefined,
          setCredentialValue: () => {},
          createTool: () => null,
        },
      });
      const config: OpenClawConfig = {
        plugins: { entries: { workboard: { enabled: true, config: { apiKey: value } } } },
      };
      if (unresolved) {
        const path = "plugins.entries.workboard.config.apiKey";
        setConfigResolutionFacts(
          config,
          createConfigResolutionFacts(
            [{ configPath: path, varName: "WORKBOARD_KEY" }],
            new Map([[path, "WORKBOARD_KEY"]]),
          ),
        );
      }
      const inspection = await withPluginRuntimeRegistryScope(registry, () =>
        inspectManagedPlugin({ config, pluginId: "workboard", env }),
      );
      expect(inspection.credentials).toEqual([
        {
          path: ["plugins", "entries", "workboard", "config", "apiKey"],
          label: "Workboard key",
          envVars: ["WORKBOARD_KEY", "ALTERNATIVE_KEY"],
          status,
        },
      ]);
    },
  );

  it("inspects bundled plugin metadata with its effective default hook grants", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: true }));

    const inspection = await inspectManagedPlugin({
      config: { plugins: { entries: { workboard: { enabled: true } } } },
      env: {},
      pluginId: "workboard",
    });

    expect(inspection).toMatchObject({
      ok: true,
      plugin: {
        id: "workboard",
        name: "Workboard",
        description: "Coordinate agent work in a shared board.",
        origin: "bundled",
        installed: true,
        enabled: true,
      },
      source: { kind: "bundled" },
      reviewToken: expect.stringMatching(/^[a-f\d]{64}$/),
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: true },
        },
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
    expect(inspection).not.toHaveProperty("trust");
  });

  it("inspects tracked external provenance, pinned integrity, operator grants, and trust", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "community-plugin",
        name: "Community Plugin",
        enabled: false,
        origin: "global",
        installRecord: {
          source: "clawhub",
          installPath: "/tmp/community-plugin",
          spec: "clawhub:community/plugin",
          resolvedSpec: "clawhub:community/plugin@1.2.3",
          clawhubPackage: "community/plugin",
          integrity: "sha512-primary",
          npmIntegrity: "sha512-secondary",
          clawpackSha256: "archive-digest",
          clawhubTrustDisposition: "review-required",
          clawhubTrustReasons: ["Install script"],
          clawhubTrustCheckedAt: "2026-08-25T00:00:00.000Z",
          clawhubTrustAcknowledgedAt: "2026-08-25T01:00:00.000Z",
          clawhubTrustPending: false,
          clawhubTrustStale: true,
        },
      }),
    );

    const inspection = await inspectManagedPlugin({
      config: {
        plugins: {
          entries: {
            "community-plugin": {
              enabled: false,
              hooks: { allowPromptInjection: false, allowConversationAccess: true },
              llm: { allowModelOverride: true },
            },
          },
        },
      },
      env: {},
      pluginId: "community-plugin",
    });

    expect(inspection).toMatchObject({
      plugin: { id: "community-plugin", name: "Community Plugin", enabled: false },
      source: {
        kind: "clawhub",
        spec: "clawhub:community/plugin@1.2.3",
        packageName: "community/plugin",
        integrity: "sha512-primary",
        integrityKind: "ssri",
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: false, configured: false },
          allowConversationAccess: { effective: true, configured: true },
        },
        llm: { allowModelOverride: true },
      },
      trust: {
        disposition: "review-required",
        reasons: ["Install script"],
        checkedAt: "2026-08-25T00:00:00.000Z",
        acknowledgedAt: "2026-08-25T01:00:00.000Z",
        pending: false,
        stale: true,
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
  });

  it("does not misrepresent an npm SHA-1 shasum as pinned SHA-256 integrity", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "community-plugin",
        name: "Community Plugin",
        enabled: false,
        origin: "global",
        installRecord: {
          source: "npm",
          installPath: "/tmp/community-plugin",
          shasum: "0123456789abcdef0123456789abcdef01234567",
          npmShasum: "fedcba9876543210fedcba9876543210fedcba987",
        },
      }),
    );

    const inspection = await inspectManagedPlugin({
      config: { plugins: { entries: { "community-plugin": { enabled: false } } } },
      env: {},
      pluginId: "community-plugin",
    });

    expect(inspection.source).toEqual({
      kind: "npm",
      packageName: "@openclaw/community-plugin",
    });
  });

  it.each(["spec", "resolvedSpec"] as const)(
    "redacts credentials from the persisted %s without changing the install record",
    async (field) => {
      const url = new URL("https://example.invalid/plugins/demo.git");
      url.username = "fixture-user";
      url.password = "fixture-password";
      url.searchParams.set("token", "fixture-token");
      url.searchParams.set("ref", "stable");
      const spec = `git:${url.href}`;
      const metadata = metadataSnapshot({
        id: "community-plugin",
        origin: "global",
        enabled: false,
        installRecord: { source: "git", installPath: "/tmp/community-plugin", [field]: spec },
      });
      mocks.metadata.mockReturnValue(metadata);

      const inspection = await inspectManagedPlugin({
        config: {},
        env: {},
        pluginId: "community-plugin",
      });

      expect(inspection.source?.spec).toBe(
        "git:https://***:***@example.invalid/plugins/demo.git?token=***&ref=stable",
      );
      expect(metadata.index.installRecords["community-plugin"]?.[field]).toBe(spec);
    },
  );

  it.each([false, true])(
    "inspects the pinned catalog candidate with npm available: %s",
    async (npm) => {
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const entry = {
        ...hostedFeedDiffsEntry,
        install: {
          candidates: [
            ...hostedFeedDiffsEntry.install.candidates,
            ...(npm
              ? [
                  {
                    sourceRef: "public-npm",
                    package: "@vendor/diffs-npm",
                    version: "1.2.3",
                    integrity: "sha512-bnBtLXBpbg==",
                  },
                ]
              : []),
          ],
        },
      };
      mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [entry] });

      const inspection = await inspectManagedPlugin({ config: {}, env: {}, pluginId: "diffs" });

      expect(inspection).toMatchObject({
        plugin: {
          id: "diffs",
          name: "Diffs",
          origin: "official",
          installed: false,
          enabled: false,
        },
        source: {
          kind: "official-catalog",
          packageName: npm ? "@vendor/diffs-npm" : "@openclaw/diffs",
          spec: npm ? "@vendor/diffs-npm@1.2.3" : "clawhub:@openclaw/diffs@2026.6.11",
          integrity: npm ? "sha512-bnBtLXBpbg==" : expect.stringMatching(/^sha256-/),
          integrityKind: npm ? "ssri" : "sha256",
        },
        grants: {
          hooks: {
            allowPromptInjection: { effective: true },
            allowConversationAccess: { effective: false },
          },
        },
      });
      expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
    },
  );

  it("rejects inspection ids absent from installed metadata and the official catalog", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    await expect(
      inspectManagedPlugin({ config: {}, env: {}, pluginId: "unknown" }),
    ).rejects.toMatchObject({ kind: "invalid-request", message: 'Plugin "unknown" not found.' });
  });
});
