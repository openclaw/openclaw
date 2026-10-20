import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { createManagedPluginArtifactConsentHandler } from "./capability-consent.js";
import {
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  mergePluginDeclaredSurfaces,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
} from "./capability-summary.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function createArtifactFixture(files: Record<string, object | string>): string {
  const rootDir = makeTrackedTempDir("openclaw-plugin-capability-consent", tempDirs);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return rootDir;
}

function manifest(id: string, fields: Record<string, unknown> = {}) {
  return { id, configSchema: { type: "object" }, ...fields };
}

function childManifest(tool: string) {
  return manifest("child", { contracts: { tools: [tool, "read"] }, skills: ["child-skill"] });
}

function pluginFiles(
  id: string,
  fields: Record<string, unknown> = {},
  files: Record<string, object | string> = {},
) {
  return {
    "package.json": { openclaw: { extensions: ["./index.js"] } },
    "index.js": "export {};",
    "openclaw.plugin.json": manifest(id, fields),
    ...files,
  };
}

function createDeclaredSurface(
  overrides: Partial<PluginAcceptedDeclaredSurface> = {},
): PluginAcceptedDeclaredSurface {
  return {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
    ...overrides,
  };
}

describe("plugin capability consent", () => {
  it.each([
    { recordOfficialCapabilities: false, accepted: false },
    { recordOfficialCapabilities: true, accepted: false },
    { recordOfficialCapabilities: true, accepted: true },
  ])(
    "records official capability acceptance only after requested review ($recordOfficialCapabilities/$accepted)",
    async ({ recordOfficialCapabilities, accepted }) => {
      const artifactDir = createArtifactFixture(
        pluginFiles(
          "codex",
          { contracts: { tools: ["fixture.tool"] } },
          { "package.json": { name: "@openclaw/codex", openclaw: { extensions: ["./index.js"] } } },
        ),
      );
      const reviewed: string[] = [];
      const consent = createManagedPluginArtifactConsentHandler({
        config: {},
        source: "npm",
        spec: "@openclaw/codex@1.0.0",
        recordOfficialCapabilities,
        onCapabilityConsent: async (review) => {
          reviewed.push(review.pluginId);
          return accepted ? { reviewToken: review.reviewToken } : undefined;
        },
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/codex@1.0.0",
        integrity: "sha512-fixture",
      };
      const preparation = consent.onBeforePluginArtifactCommit({
        pluginId: "codex",
        mode: "install",
        stagedArtifactDir: artifactDir,
        sourceRecord: record,
      });
      if (recordOfficialCapabilities && !accepted) {
        await expect(preparation).rejects.toMatchObject({
          capabilityConsent: { pluginId: "codex" },
        });
      } else {
        await preparation;
        const prepared = consent.applyAcceptedSurface("codex", record);
        if (recordOfficialCapabilities) {
          expect(prepared).toMatchObject({
            acceptedSurface: { tools: ["fixture.tool"] },
            acceptedSurfaceAt: expect.any(String),
            acceptedSurfaceIntegrity: "sha512-fixture",
          });
          expect(prepared.acceptedSurfaceHash).toMatch(/^[a-f0-9]{64}$/u);
        } else {
          expect(prepared).not.toHaveProperty("acceptedSurface");
        }
      }
      expect(reviewed).toEqual(recordOfficialCapabilities ? ["codex"] : []);
    },
  );

  it.each<
    [string, boolean, boolean, { alias?: boolean; unmanaged?: boolean; missingPrevious?: boolean }?]
  >([
    ["native package entries", false, false],
    ["a configured file override", true, false],
    ["a configured file override mapped into an update stage", true, true],
    [
      "a configured file override after the previous payload was removed",
      true,
      true,
      { missingPrevious: true },
    ],
    ["a configured file symlink with its original manifest root", true, false, { alias: true }],
    ["a configured file symlink mapped into an update stage", true, true, { alias: true }],
    [
      "an unmanaged configured descendant outside the package entry set",
      true,
      false,
      { unmanaged: true },
    ],
  ])(
    "matches runtime discovery for %s",
    (
      _label,
      explicitPath,
      staged,
      { alias = false, unmanaged = false, missingPrevious = false } = {},
    ) => {
      const rootDir = createArtifactFixture({
        "package.json": {
          name: "multi-plugin-package",
          openclaw: { extensions: ["./index.js", "./plugins/child/child.js"] },
        },
        "openclaw.plugin.json": manifest("root", {
          channels: ["chat"],
          contracts: { tools: ["read"] },
        }),
        "index.js": "export {};",
        "plugins/child/openclaw.plugin.json": childManifest("write"),
        "plugins/child/child.js": "export {};",
        "plugins/openclaw.plugin.json": manifest("ignored-ancestor", {
          contracts: { tools: ["unreachable-tool"] },
        }),
        "extra/extra.js": "export {};",
        "extra/openclaw.plugin.json": manifest("unmanaged-extra", {
          contracts: { tools: ["unmanaged-tool"] },
        }),
      });
      const artifactDir = staged ? createArtifactFixture({}) : rootDir;
      if (staged) {
        fs.cpSync(rootDir, artifactDir, { recursive: true });
        fs.writeFileSync(
          path.join(artifactDir, "plugins/child/openclaw.plugin.json"),
          JSON.stringify(childManifest("staged-write")),
        );
      }
      if (alias) {
        for (const dir of new Set([rootDir, artifactDir])) {
          fs.symlinkSync("plugins/child/child.js", path.join(dir, "alias.js"));
        }
      }
      const configuredEntry = unmanaged
        ? "extra/extra.js"
        : alias
          ? "alias.js"
          : "plugins/child/child.js";
      const config = {
        plugins: {
          load: { paths: explicitPath ? [path.join(rootDir, configuredEntry)] : [] },
        },
      };
      if (missingPrevious) {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
      const runtimePaths = explicitPath ? [path.join(artifactDir, configuredEntry)] : [];
      const env = {
        HOME: artifactDir,
        OPENCLAW_STATE_DIR: path.join(artifactDir, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      };
      const runtime = loadInstalledPluginIndexWithDiscovery({
        config: { plugins: { load: { paths: runtimePaths } } },
        env,
        installRecords: { root: { source: "path", installPath: artifactDir } },
      });
      const ownedIds = new Set(
        runtime.index.plugins
          .filter((plugin) => resolveInstalledPluginIndexInstallOwner(plugin) === "root")
          .map((plugin) => plugin.pluginId),
      );
      const runtimeDeclared = mergePluginDeclaredSurfaces(
        runtime.manifestRegistry.plugins
          .filter((entry) => ownedIds.has(entry.id))
          .map(
            (entry) =>
              buildPluginCapabilitySummary({ manifest: entry, origin: entry.origin }).declared,
          ),
      );
      const includesChildManifest = explicitPath && !alias && !unmanaged;
      const expectedTools = includesChildManifest
        ? ["read", staged ? "staged-write" : "write"]
        : ["read"];
      const expected = createDeclaredSurface({
        channels: ["chat"],
        tools: expectedTools,
        contracts: expectedTools.map((tool) => `tools: ${tool}`),
        skills: includesChildManifest ? ["child-skill"] : [],
      });

      expect(
        runtime.index.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
      ).toEqual([]);
      expect(runtimeDeclared).toEqual(expected);
      expect(
        resolvePluginArtifactDeclaredSurface(artifactDir, env, {
          config,
          ...(staged ? { currentArtifactDir: rootDir } : {}),
        }),
      ).toEqual(expected);
    },
  );

  it("reviews native package extensions before a competing bundle manifest, like runtime discovery", () => {
    const rootDir = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["./index.js"] } },
      "index.js": "export {};",
      "openclaw.plugin.json": manifest("native", {
        contracts: { gatewayMethodDispatch: ["dangerous.gateway"] },
      }),
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./misleading-safe-skill"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir)).toEqual(
      createDeclaredSurface({ contracts: ["gatewayMethodDispatch: dangerous.gateway"] }),
    );
  });

  it("reviews a competing bundle before native fallback when the package declares no extensions", () => {
    const rootDir = createArtifactFixture({
      "openclaw.plugin.json": manifest("native", {
        contracts: { gatewayMethodDispatch: ["native.gateway"] },
      }),
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./bundle-skills"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir)).toEqual(
      createDeclaredSurface({ skills: ["./bundle-skills"] }),
    );
  });

  it("rejects package extension entries that escape the installed artifact", () => {
    const rootDir = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["../outside/index.js"] } },
      "openclaw.plugin.json": { id: "root", configSchema: { type: "object" } },
    });

    expect(() => resolvePluginArtifactDeclaredSurface(rootDir)).toThrow();
  });

  it.each([
    { previous: ["read"], next: ["write", "read"], widened: { tools: ["write"] } },
    { previous: ["read", "write"], next: ["read"], widened: {} },
  ])("identifies widening from $previous to $next", ({ previous, next, widened }) => {
    expect(
      diffDeclaredSurfaceWidening(
        createDeclaredSurface({ tools: previous }),
        createDeclaredSurface({ tools: next }),
      ),
    ).toEqual({ widened, hasWidening: Object.keys(widened).length > 0 });
  });

  it.each<[string, Partial<PluginInstallRecord>, boolean]>([
    ["missing acceptance", { acceptedSurface: undefined }, false],
    ["missing acceptance hash", { acceptedSurfaceHash: undefined }, false],
    ["a forged acceptance hash", { acceptedSurfaceHash: "0".repeat(64) }, false],
    [
      "a changed accepted snapshot",
      { acceptedSurface: createDeclaredSurface({ tools: ["write"] }) },
      false,
    ],
    [
      "a changed installed artifact",
      { integrity: "sha512-new", acceptedSurfaceIntegrity: "sha512-old" },
      false,
    ],
    [
      "an accepted artifact anchor that disappeared",
      { acceptedSurfaceIntegrity: "sha512-old" },
      false,
    ],
    ["matching declared surface without an available artifact digest", {}, true],
  ])("recognizes current acceptance for %s", (_label, record, current) => {
    const surface = createDeclaredSurface({ tools: ["read"] });
    const installRecord: PluginInstallRecord = {
      source: "npm",
      acceptedSurface: surface,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(surface),
      ...record,
    };
    expect(resolveAcceptedSurfaceCurrent(installRecord, surface)).toBe(current);
  });

  it("redacts source credentials before a capability review reaches a prompt or pending inspection", async () => {
    const url = new URL("https://example.invalid/plugins/demo.git");
    url.username = "fixture-user";
    url.password = "fixture-password";
    url.searchParams.set("token", "fixture-token");
    const record: PluginInstallRecord = { source: "git", spec: `git:${url.href}` };

    let reviewSpec: string | undefined;
    const consent = createManagedPluginArtifactConsentHandler({
      config: {},
      source: record.source,
      spec: record.spec,
      onCapabilityConsent: async (review) => {
        reviewSpec = review.source?.spec;
        return { reviewToken: review.reviewToken };
      },
    });
    await consent.onBeforePluginArtifactCommit({
      pluginId: "plugin",
      mode: "install",
      stagedArtifactDir: createArtifactFixture({
        "index.js": "export {};",
        "openclaw.plugin.json": manifest("plugin"),
      }),
    });

    expect(reviewSpec).toBe("git:https://***:***@example.invalid/plugins/demo.git?token=***");
    expect(record.spec).toBe(`git:${url.href}`);
  });

  it("selects the canonical installed artifact integrity in precedence order", () => {
    expect(
      [
        {
          integrity: "primary",
          npmIntegrity: "npm",
          clawpackSha256: "clawpack",
          gitCommit: "commit",
        },
        { npmIntegrity: "npm", gitCommit: "commit" },
        { clawpackSha256: "clawpack" },
        { gitCommit: "commit" },
        {},
      ].map(resolvePluginInstallRecordIntegrity),
    ).toEqual([
      { integrity: "primary", integrityKind: "ssri" },
      { integrity: "npm", integrityKind: "ssri" },
      { integrity: "clawpack", integrityKind: "sha256" },
      { integrity: "commit", integrityKind: "git-commit" },
      undefined,
    ]);
  });

  it.each(["missing", "invalid"])(
    "requires fresh review to repair a %s previous artifact",
    async (condition) => {
      const files = pluginFiles("plugin", { contracts: { tools: ["repair-tool"] } });
      const previousDir = createArtifactFixture(files);
      const stagedDir = createArtifactFixture(files);
      const acceptedSurface = resolvePluginArtifactDeclaredSurface(previousDir);
      const previousRecord = {
        source: "npm" as const,
        installPath: previousDir,
        integrity: "sha512-previous",
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceIntegrity: "sha512-previous",
      };
      if (condition === "missing") {
        fs.rmSync(previousDir, { recursive: true });
      } else {
        fs.writeFileSync(path.join(previousDir, "openclaw.plugin.json"), "{");
      }
      const params = {
        config: {},
        source: "npm" as const,
        previousRecords: { plugin: previousRecord },
      };
      const artifact = {
        pluginId: "plugin",
        stagedArtifactDir: stagedDir,
        mode: "update" as const,
      };
      await expect(
        createManagedPluginArtifactConsentHandler(params).onBeforePluginArtifactCommit(artifact),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });
      const reviewed: string[][] = [];
      const consent = createManagedPluginArtifactConsentHandler({
        ...params,
        onCapabilityConsent: async (review) => {
          reviewed.push(review.declared.tools);
          return { reviewToken: review.reviewToken };
        },
      });
      await consent.onBeforePluginArtifactCommit(artifact);
      expect(reviewed).toEqual([["repair-tool"]]);
      const repairedRecord: PluginInstallRecord = { source: "npm" };
      expect(consent.applyAcceptedSurface("plugin", repairedRecord).acceptedSurface).toEqual(
        acceptedSurface,
      );
    },
  );

  it("requires Claw-owner review even when an update has current plugin acceptance", async () => {
    const rootDir = createArtifactFixture(
      pluginFiles("plugin", { contracts: { tools: ["read"] } }),
    );
    const acceptedSurface = resolvePluginArtifactDeclaredSurface(rootDir);
    const previousRecords = {
      plugin: {
        source: "npm" as const,
        installPath: rootDir,
        integrity: "sha512-current",
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceIntegrity: "sha512-current",
      },
    };
    const artifact = { pluginId: "plugin", stagedArtifactDir: rootDir, mode: "update" as const };

    await expect(
      createManagedPluginArtifactConsentHandler({
        config: {},
        source: "npm",
        previousRecords,
        requireCapabilityConsent: true,
      }).onBeforePluginArtifactCommit(artifact),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });

    const reviewed: string[] = [];
    await createManagedPluginArtifactConsentHandler({
      config: {},
      source: "npm",
      previousRecords,
      requireCapabilityConsent: true,
      onCapabilityConsent: async (review) => {
        reviewed.push(review.reviewToken);
        return { reviewToken: review.reviewToken };
      },
    }).onBeforePluginArtifactCommit(artifact);
    expect(reviewed).toEqual([computeDeclaredSurfaceHash(acceptedSurface)]);
  });

  it("does not apply the official-plugin exemption to a Claw-managed install", async () => {
    const rootDir = createArtifactFixture({
      "package.json": {
        name: "@openclaw/acpx",
        openclaw: { extensions: ["./index.js"] },
      },
      "index.js": "export {};",
      "openclaw.plugin.json": manifest("acpx", { contracts: { tools: ["acpx.run"] } }),
    });
    const sourceRecord: PluginInstallRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/acpx",
      clawhubPackage: "@openclaw/acpx",
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    };
    const artifact = {
      pluginId: "acpx",
      stagedArtifactDir: rootDir,
      sourceRecord,
      mode: "install" as const,
    };
    const params = {
      config: {},
      source: "clawhub" as const,
      spec: sourceRecord.spec,
    };

    await createManagedPluginArtifactConsentHandler(params).onBeforePluginArtifactCommit(artifact);
    await expect(
      createManagedPluginArtifactConsentHandler({
        ...params,
        requireCapabilityConsent: true,
      }).onBeforePluginArtifactCommit(artifact),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "acpx" } });

    const reviewed: string[][] = [];
    await createManagedPluginArtifactConsentHandler({
      ...params,
      requireCapabilityConsent: true,
      onCapabilityConsent: async (review) => {
        reviewed.push(review.declared.tools);
        return { reviewToken: review.reviewToken };
      },
    }).onBeforePluginArtifactCommit(artifact);
    expect(reviewed).toEqual([["acpx.run"]]);
  });

  it("rejects reinstall without capability consent even when the plugin is disabled", async () => {
    const rootDir = createArtifactFixture(pluginFiles("plugin"));
    const consent = createManagedPluginArtifactConsentHandler({
      config: { plugins: { entries: { plugin: { enabled: false } } } },
      source: "npm",
      previousRecords: { plugin: { source: "npm", installPath: rootDir } },
    });

    await expect(
      consent.onBeforePluginArtifactCommit({
        pluginId: "plugin",
        stagedArtifactDir: rootDir,
        mode: "update",
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });
  });
});
