import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import {
  inspectPluginCapabilityArtifact,
  resolvePluginArtifactDeclaredSurface,
} from "./capability-artifact.js";
import { createManagedPluginArtifactConsentHandler } from "./capability-consent.js";
import {
  type PluginCapabilityConsentReview,
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  mergePluginDeclaredSurfaces,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
} from "./capability-summary.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import { recordPluginInstall } from "./installs.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { preparePluginUpdateCapabilityConsent } from "./update-capability-consent.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTrackedTempDirs(tempDirs));

function createArtifactFixture(files: Record<string, object | string>): string {
  const rootDir = makeTrackedTempDir("openclaw-plugin-capability-consent", tempDirs);
  writeArtifacts(rootDir, files);
  return rootDir;
}

function createConsent(
  options: Partial<Parameters<typeof createManagedPluginArtifactConsentHandler>[0]> = {},
) {
  return createManagedPluginArtifactConsentHandler({ config: {}, source: "npm", ...options });
}

function reviewedConsent(options: Parameters<typeof createConsent>[0] = {}, accepted = true) {
  const reviews: PluginCapabilityConsentReview[] = [];
  return {
    ...createConsent({
      ...options,
      onCapabilityConsent: async (review) => {
        reviews.push({ ...review, source: review.source && { ...review.source } });
        return accepted ? { reviewToken: review.reviewToken } : undefined;
      },
    }),
    reviews,
  };
}

function makeArtifact(
  stagedArtifactDir: string,
  pluginId = "plugin",
  mode: "install" | "update" = "install",
) {
  return { stagedArtifactDir, pluginId, mode };
}

function acceptedRecord(installPath: string, integrity: string): PluginInstallRecord {
  const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath);
  return {
    source: "npm",
    installPath,
    integrity,
    acceptedSurface,
    acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
    acceptedSurfaceIntegrity: integrity,
  };
}

function manifest(id: string, fields: Record<string, unknown> = {}) {
  return { id, configSchema: { type: "object" }, ...fields };
}

function childManifest(tool: string) {
  return manifest("child", { contracts: { tools: [tool, "read"] }, skills: ["child-skill"] });
}

function pluginFiles(id: string, fields: Record<string, unknown> = {}, packageName?: string) {
  return {
    "package.json": {
      ...(packageName ? { name: packageName } : {}),
      openclaw: { extensions: ["./index.js"] },
    },
    "index.js": "export {};",
    "openclaw.plugin.json": manifest(id, fields),
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

it.each([
  { enabled: true, ids: ["new-engine"] },
  { enabled: false, ids: ["new-engine"] },
  { enabled: true, ids: undefined },
  { enabled: false, ids: undefined },
])(
  "refreshes retained ownership through update record replacement: $enabled / $ids",
  async ({ enabled, ids }) => {
    const stage = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["./index.js"] } },
      "index.js": "throw new Error('metadata inspection must not run plugin');",
      "openclaw.plugin.json": {
        id: "plugin",
        kind: "context-engine",
        contextEngineIds: ids,
        configSchema: {},
      },
    });
    const previousRecord: PluginInstallRecord = {
      source: "npm",
      installPath: "/missing/old-artifact",
      contextEngineIdsByPlugin: { plugin: ["old-engine"], removedChild: ["removed-engine"] },
    };
    const config = {
      plugins: { entries: { plugin: { enabled } }, installs: { plugin: previousRecord } },
    };
    const consent = preparePluginUpdateCapabilityConsent({
      config,
      pluginId: "plugin",
      record: previousRecord,
      installPath: "/missing/old-artifact",
      packagePluginIds: ["plugin"],
      onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
    });
    await consent.onBeforePluginArtifactCommit({
      pluginId: "plugin",
      stagedArtifactDir: stage,
      mode: "update",
    });
    const next = recordPluginInstall(
      config,
      consent.acceptInstallRecord({ pluginId: "plugin", ...previousRecord, installPath: stage }),
    );
    expect(next.plugins?.installs?.plugin?.contextEngineIdsByPlugin).toEqual(
      ids ? { plugin: ids } : undefined,
    );
    expect(previousRecord.contextEngineIdsByPlugin).toEqual({
      plugin: ["old-engine"],
      removedChild: ["removed-engine"],
    });
  },
);

it.each([
  { recordOfficialCapabilities: false, accepted: false },
  { recordOfficialCapabilities: true, accepted: false },
  { recordOfficialCapabilities: true, accepted: true },
])(
  "records official capability acceptance only after requested review ($recordOfficialCapabilities/$accepted)",
  async ({ recordOfficialCapabilities, accepted }) => {
    const artifactDir = createArtifactFixture(
      pluginFiles("codex", { contracts: { tools: ["fixture.tool"] } }, "@openclaw/codex"),
    );
    const consent = reviewedConsent(
      {
        spec: "@openclaw/codex@1.0.0",
        recordOfficialCapabilities,
      },
      accepted,
    );
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex@1.0.0",
      integrity: "sha512-fixture",
    };
    const preparation = consent.onBeforePluginArtifactCommit({
      ...makeArtifact(artifactDir, "codex"),
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
    expect(consent.reviews.map((review) => review.pluginId)).toEqual(
      recordOfficialCapabilities ? ["codex"] : [],
    );
  },
);

it.each<
  [string, boolean, boolean, { alias?: boolean; unmanaged?: boolean; missingPrevious?: boolean }?]
>([
  ["native package entries", false, false],
  ["a configured file override", true, false],
  ["staged file override", true, true],
  ["override with missing previous payload", true, true, { missingPrevious: true }],
  ["file symlink", true, false, { alias: true }],
  ["staged file symlink", true, true, { alias: true }],
  ["unmanaged descendant", true, false, { unmanaged: true }],
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

    expect(runtime.index.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual(
      [],
    );
    expect(runtimeDeclared).toEqual(expected);
    expect(
      resolvePluginArtifactDeclaredSurface(artifactDir, env, {
        config,
        ...(staged ? { currentArtifactDir: rootDir } : {}),
      }),
    ).toEqual(expected);
  },
);

it.each([true, false])(
  "resolves native/bundle precedence with declared extensions=%s",
  (native) => {
    const files: Record<string, object | string> = {
      "openclaw.plugin.json": manifest("native", {
        contracts: { gatewayMethodDispatch: ["native.gateway"] },
      }),
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./bundle-skills"] },
    };
    if (native) {
      files["package.json"] = { openclaw: { extensions: ["./index.js"] } };
      files["index.js"] = "export {};";
    }
    expect(resolvePluginArtifactDeclaredSurface(createArtifactFixture(files))).toEqual(
      createDeclaredSurface(
        native
          ? { contracts: ["gatewayMethodDispatch: native.gateway"] }
          : { skills: ["./bundle-skills"] },
      ),
    );
  },
);

it("rejects package extension entries that escape the installed artifact", () => {
  const rootDir = createArtifactFixture({
    "package.json": { openclaw: { extensions: ["../outside/index.js"] } },
    "openclaw.plugin.json": { id: "root", configSchema: { type: "object" } },
  });

  expect(() => resolvePluginArtifactDeclaredSurface(rootDir)).toThrow();
});

it.skipIf(process.platform === "win32")(
  "reports the discovery rejection when a valid plugin artifact is world-writable",
  () => {
    const rootDir = createArtifactFixture(pluginFiles("permissions"));
    fs.chmodSync(rootDir, 0o777);

    expect(() => inspectPluginCapabilityArtifact(rootDir)).toThrow(
      `blocked plugin candidate: world-writable path (${fs.realpathSync(rootDir)},`,
    );

    fs.chmodSync(rootDir, 0o755);
    expect(inspectPluginCapabilityArtifact(rootDir)).toMatchObject({
      manifest: { id: "permissions" },
    });
  },
);

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
  ["changed snapshot", { acceptedSurface: createDeclaredSurface({ tools: ["write"] }) }, false],
  ["changed artifact", { integrity: "sha512-new", acceptedSurfaceIntegrity: "sha512-old" }, false],
  ["missing artifact anchor", { acceptedSurfaceIntegrity: "sha512-old" }, false],
  ["matching without digest", {}, true],
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

  const consent = reviewedConsent({ source: record.source, spec: record.spec });
  await consent.onBeforePluginArtifactCommit({
    pluginId: "plugin",
    mode: "install",
    stagedArtifactDir: createArtifactFixture({
      "index.js": "export {};",
      "openclaw.plugin.json": manifest("plugin"),
    }),
  });

  expect(consent.reviews.map((review) => review.source?.spec)).toEqual([
    "git:https://***:***@example.invalid/plugins/demo.git?token=***",
  ]);
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
    const previousRecord = acceptedRecord(previousDir, "sha512-previous");
    if (condition === "missing") {
      fs.rmSync(previousDir, { recursive: true });
    } else {
      fs.writeFileSync(path.join(previousDir, "openclaw.plugin.json"), "{");
    }
    const params = { previousRecords: { plugin: previousRecord } };
    const request = makeArtifact(stagedDir, "plugin", "update");
    await expect(createConsent(params).onBeforePluginArtifactCommit(request)).rejects.toMatchObject(
      { capabilityConsent: { pluginId: "plugin" } },
    );
    const consent = reviewedConsent(params);
    await consent.onBeforePluginArtifactCommit(request);
    expect(consent.reviews.map((review) => review.declared.tools)).toEqual([["repair-tool"]]);
    expect(
      consent.applyAcceptedSurface<PluginInstallRecord>("plugin", { source: "npm" })
        .acceptedSurface,
    ).toEqual(previousRecord.acceptedSurface);
  },
);

it.each(["current acceptance", "official provenance"] as const)(
  "requires Template-owner review despite %s",
  async (basis) => {
    const official = basis === "official provenance";
    const pluginId = official ? "acpx" : "plugin";
    const tools = [official ? "acpx.run" : "read"];
    const rootDir = createArtifactFixture(
      pluginFiles(pluginId, { contracts: { tools } }, official ? "@openclaw/acpx" : undefined),
    );
    const sourceRecord: PluginInstallRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/acpx",
      clawhubPackage: "@openclaw/acpx",
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    };
    const artifact = {
      pluginId,
      stagedArtifactDir: rootDir,
      mode: official ? ("install" as const) : ("update" as const),
      ...(official ? { sourceRecord } : {}),
    };
    const options = official
      ? { source: "clawhub" as const, spec: sourceRecord.spec }
      : { previousRecords: { plugin: acceptedRecord(rootDir, "sha512-current") } };
    if (official) {
      await createConsent(options).onBeforePluginArtifactCommit(artifact);
    }
    const required = { ...options, requireCapabilityConsent: true };
    await expect(
      createConsent(required).onBeforePluginArtifactCommit(artifact),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId } });
    const consent = reviewedConsent(required);
    await consent.onBeforePluginArtifactCommit(artifact);
    expect(
      consent.reviews.map(({ reviewToken: token, declared }) => ({ token, tools: declared.tools })),
    ).toEqual([
      {
        token: computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(rootDir)),
        tools,
      },
    ]);
  },
);

it("rejects reinstall without capability consent even when the plugin is disabled", async () => {
  const rootDir = createArtifactFixture(pluginFiles("plugin"));
  const consent = createConsent({
    config: { plugins: { entries: { plugin: { enabled: false } } } },
    previousRecords: { plugin: { source: "npm", installPath: rootDir } },
  });

  await expect(
    consent.onBeforePluginArtifactCommit(makeArtifact(rootDir, "plugin", "update")),
  ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });
});
