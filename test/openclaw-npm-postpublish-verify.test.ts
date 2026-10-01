import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { build } from "tsdown";
import { describe, expect, it, vi } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { createRuntimeDependencyOwnershipBuildPlugin } from "../scripts/lib/runtime-dependency-ownership-build-plugin.mts";
import {
  buildPublishedInstallScenarios,
  collectInstalledBundledExtensionManifestErrors,
  collectInstalledContextEngineRuntimeErrors,
  collectInstalledRootDependencyManifestErrors,
  collectInstalledPackageErrors,
  fetchRegistryJson,
  parseOpenClawNpmPostpublishVerifyArgs,
  resolveInstalledBinaryCommandInvocation,
  retryNpmRegistryProvenanceRead,
  verifyNpmProvenanceAttestation,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import {
  rewriteRootRuntimeImportsToStableAliases,
  writeStableRootRuntimeAliases,
} from "../scripts/runtime-postbuild.mts";
import { packageActivationRuntimeEntrypoint } from "../src/infra/package-update-activation-runtime-assets.js";
import { RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH } from "../src/infra/runtime-dependency-ownership.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import { WORKER_BUNDLE_ENTRY_PATH } from "../src/shared/worker-bundle-hash.js";
import { withEnv } from "../src/test-utils/env.js";
import { createScriptTestHarness } from "./scripts/test-helpers.js";
import { toolingTsEntrypoints } from "./scripts/tooling-ts-runtime.test-support.js";

const { createTempDir } = createScriptTestHarness();
const makeInstalledPackageRoot = () => createTempDir("openclaw-postpublish-");
const INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT = 10_000;
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();

function writeInstalledFile(root: string, relativePath: string, source = "export {};\n") {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source, "utf8");
  return file;
}

function writePackageFile(root: string, relativePath: string, value: unknown): void {
  writeInstalledFile(root, relativePath, JSON.stringify(value));
}

function installedPackageErrors(packageRoot: string) {
  return collectInstalledPackageErrors({
    expectedVersion: "2026.3.23",
    installedVersion: "2026.3.23",
    packageRoot,
  });
}

describe("parseOpenClawNpmPostpublishVerifyArgs", () => {
  it("keeps trusted release verification independent from target app dependencies", () => {
    const source = readFileSync("scripts/openclaw-npm-postpublish-verify.ts", "utf8");

    expect(source).toContain('from "./lib/error-format.mts"');
    expect(source).not.toContain('from "../src/infra/errors.ts"');
  });

  it("rejects an extra empty operand before verification", () => {
    expect(() => parseOpenClawNpmPostpublishVerifyArgs(["2026.3.23", ""])).toThrow(
      "Unexpected openclaw npm postpublish verifier argument",
    );
  });
});

describe("buildPublishedInstallScenarios", () => {
  it("adds a stable-to-correction upgrade scenario for correction releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23-2")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
      {
        name: "upgrade-from-base-stable",
        installSpecs: ["openclaw@2026.3.23", "openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
    ]);
  });
});

describe("npm registry provenance verification", () => {
  const packageName = "openclaw";
  const version = "2026.3.23";
  const integrity = `sha512-${Buffer.from("registry integrity", "utf8").toString("base64")}`;
  const buildProvenancePayload = (
    releaseVersion: string,
    workflowRef: string,
    workflowSha?: string,
  ) => ({
    subject: [
      {
        name: `pkg:npm/${packageName}@${releaseVersion}`,
        digest: {
          sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/openclaw/openclaw",
            path: ".github/workflows/openclaw-npm-release.yml",
            ref: workflowRef,
          },
        },
        ...(workflowSha
          ? {
              resolvedDependencies: [
                {
                  uri: `git+https://github.com/openclaw/openclaw@${workflowRef}`,
                  digest: { gitCommit: workflowSha },
                },
              ],
            }
          : {}),
      },
      runDetails: {
        builder: {
          id: "https://github.com/actions/runner/github-hosted",
        },
      },
    },
  });
  const provenancePayload = buildProvenancePayload(version, "refs/heads/release/2026.3.23");
  const attestationsFor = (payload: unknown) => [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        },
      },
    },
  ];

  const releaseIdentity = (ref: string) => ({
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: `https://github.com/openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@${ref}`,
  });
  const makeBundleVerifier = () =>
    vi.fn<NonNullable<Parameters<typeof verifyNpmProvenanceAttestation>[0]["verifyBundle"]>>(
      async () => undefined,
    );

  function verifyProvenance(
    overrides: Partial<Parameters<typeof verifyNpmProvenanceAttestation>[0]> = {},
  ) {
    return verifyNpmProvenanceAttestation({
      packageName,
      version,
      integrity,
      attestations: attestationsFor(provenancePayload),
      verifyBundle: async () => undefined,
      ...overrides,
    });
  }

  it("fetches npm registry JSON with bounded response handling", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({
        headers: {
          Accept: "application/json",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
      return new Response(JSON.stringify({ ok: true }));
    });

    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized npm registry response bodies", async () => {
    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl: async () =>
          new Response("x".repeat(65), { headers: { "content-length": "65" } }),
        maxBodyBytes: 64,
        timeoutMs: 1234,
      }),
    ).rejects.toThrow(
      "npm registry https://registry.example/openclaw response body exceeded 64 bytes",
    );
  });

  it("keeps npm registry timeouts active while reading response bodies", async () => {
    await expect(
      fetchRegistryJson("https://registry.example/openclaw", {
        fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
        timeoutMs: 5,
      }),
    ).rejects.toThrow(
      "npm registry request timed out after 5ms: https://registry.example/openclaw",
    );
  });

  it("requires a trusted GitHub release identity for the exact SLSA provenance attestation", async () => {
    const verifyBundle = makeBundleVerifier();
    await expect(verifyProvenance({ verifyBundle })).resolves.toBeUndefined();
    expect(verifyBundle.mock.calls[0]?.[1]).toEqual(
      releaseIdentity("refs/heads/release/2026.3.23"),
    );

    const sha = "a".repeat(40);
    const ref = `refs/tags/release-publish/${sha.slice(0, 12)}-123`;
    const pinned = {
      attestations: attestationsFor(buildProvenancePayload(version, ref, sha)),
      expectedWorkflowRef: ref,
      expectedWorkflowSha: sha,
      verifyBundle,
    };
    await expect(verifyProvenance(pinned)).resolves.toBeUndefined();
    expect(verifyBundle.mock.calls[1]?.[1]).toEqual(releaseIdentity(ref));
    await expect(
      verifyProvenance({ ...pinned, expectedWorkflowSha: "b".repeat(40) }),
    ).rejects.toThrow(
      "npm provenance SHA-pinned release-publish ref does not match the approved workflow ref and SHA",
    );
    await expect(
      verifyProvenance({
        attestations: attestationsFor({
          ...provenancePayload,
          subject: [{ name: "pkg:npm/openclaw@2026.3.24", digest: {} }],
        }),
      }),
    ).rejects.toThrow("does not match");
  });

  it("trusts later extended-stable patches from the canonical branch", async () => {
    const verifyBundle = makeBundleVerifier();
    const releaseVersion = "2026.6.34";
    const ref = "refs/heads/extended-stable/2026.6.33";
    await verifyProvenance({
      version: releaseVersion,
      attestations: attestationsFor(buildProvenancePayload(releaseVersion, ref)),
      verifyBundle,
    });
    expect(verifyBundle.mock.calls[0]?.[1]).toEqual(releaseIdentity(ref));
  });

  it.each([
    ["ordinary release from a feature branch", version, "refs/heads/feature/untrusted"],
    ["later patch on a noncanonical branch", "2026.6.34", "refs/heads/extended-stable/2026.6.34"],
    ["patch below 33", "2026.6.32", "refs/heads/extended-stable/2026.6.33"],
    ["correction suffix", "2026.6.33-1", "refs/heads/extended-stable/2026.6.33"],
  ])("rejects untrusted release provenance for %s", async (_label, releaseVersion, workflowRef) => {
    const verifyBundle = makeBundleVerifier();

    await expect(
      verifyProvenance({
        version: releaseVersion,
        attestations: attestationsFor(buildProvenancePayload(releaseVersion, workflowRef)),
        verifyBundle,
      }),
    ).rejects.toThrow(
      `does not bind ${releaseVersion} to the trusted OpenClaw GitHub release workflow`,
    );
    expect(verifyBundle).not.toHaveBeenCalled();
  });

  it("rejects a matching provenance payload when Sigstore cannot verify its bundle", async () => {
    await expect(
      verifyProvenance({
        verifyBundle: async () => {
          throw new Error("forged bundle");
        },
      }),
    ).rejects.toThrow("failed Sigstore verification");
  });

  it("retries incomplete or briefly stale provenance while npm publish propagates", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      retryNpmRegistryProvenanceRead(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error(
              "npm provenance attestation does not bind 2026.3.23 to the trusted OpenClaw GitHub release workflow.",
            );
          }
          if (attempts === 2) {
            throw new Error(
              "npm registry provenance metadata is incomplete for openclaw@2026.3.23.",
            );
          }
          return "verified";
        },
        {
          attempts: 3,
          delay: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      ),
    ).resolves.toBe("verified");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("collectInstalledPackageErrors", () => {
  it("requires the activation runtime and allowlisted facade sidecars", () => {
    const packageRoot = makeInstalledPackageRoot();
    const requiredArtifacts = [
      [
        "dist/facade-activation-check.runtime.js",
        "installed package is missing required facade activation runtime: dist/facade-activation-check.runtime.js",
      ],
      [
        "dist/extensions/image-generation-core/runtime-api.js",
        "installed package allows bundled runtime facade image-generation-core/runtime-api.js but is missing required runtime sidecar: dist/extensions/image-generation-core/runtime-api.js.",
      ],
    ] as const;
    const missingErrors = installedPackageErrors(packageRoot);
    for (const [relativePath, error] of requiredArtifacts) {
      expect(missingErrors).toContain(error);
      writeInstalledFile(packageRoot, relativePath);
    }
    const installedErrors = installedPackageErrors(packageRoot);
    for (const [, error] of requiredArtifacts) {
      expect(installedErrors).not.toContain(error);
    }
  });

  function writeExpectedBundledExtensionManifests(
    packageRoot: string,
    omittedIds: readonly string[] = [],
  ): void {
    const omitted = new Set(omittedIds);
    for (const relativePath of requiredBundledPluginPackPaths) {
      const match = /^dist\/extensions\/([^/]+)\//u.exec(relativePath);
      if (!match || omitted.has(match[1] ?? "")) {
        continue;
      }
      writeInstalledFile(
        packageRoot,
        relativePath,
        relativePath.endsWith(".json") ? "{}\n" : "export {};\n",
      );
    }
    writePackageFile(
      packageRoot,
      "dist/postinstall-inventory.json",
      requiredBundledPluginPackPaths,
    );
  }

  it("rejects an oversized worker before the full verifier reads its contents", () => {
    const packageRoot = makeInstalledPackageRoot();

    writeInstalledFile(packageRoot, "package.json", '{"version":"2026.3.23"}\n');
    const workerPath = writeInstalledFile(
      packageRoot,
      `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`,
      "/* Failed to load legacy context engine runtime. */\n",
    );
    truncateSync(workerPath, 80 * 1024 * 1024 + 1);

    const errors = installedPackageErrors(packageRoot);
    const sizeError = `installed package root dist file 'worker/${WORKER_BUNDLE_ENTRY_PATH}' is invalid or exceeds 83886080 bytes.`;

    expect(errors.filter((error) => error === sizeError)).toEqual([sizeError]);
    expect(errors).not.toContain(
      "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
    );
  });

  it("rejects an unresolved legacy context loader in a self-contained worker", () => {
    const packageRoot = makeInstalledPackageRoot();
    writeInstalledFile(
      packageRoot,
      `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`,
      "/* Failed to load legacy context engine runtime. */\n",
    );

    expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([
      "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
    ]);
  });

  it("rejects a missing installed bundled provider directory", () => {
    const providerId = "ollama";
    const packageRoot = makeInstalledPackageRoot();

    writeInstalledFile(packageRoot, "package.json", '{"version":"2026.3.23"}\n');
    writeExpectedBundledExtensionManifests(packageRoot, [providerId]);

    const missingManifestPath = join(packageRoot, "dist", "extensions", providerId, "package.json");
    const expectedError = `installed bundled extension manifest missing: ${missingManifestPath}.`;
    const missingArtifactErrors = requiredBundledPluginPackPaths
      .filter((relativePath) => relativePath.startsWith(`dist/extensions/${providerId}/`))
      .map((relativePath) =>
        relativePath.endsWith("/package.json")
          ? expectedError
          : `installed bundled plugin artifact missing: ${relativePath}.`,
      );

    expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toStrictEqual(
      missingArtifactErrors,
    );
    expect(installedPackageErrors(packageRoot)).toContain(expectedError);
  });

  it("rejects an installed bundled artifact omitted from its inventory", () => {
    const relativePath = "dist/extensions/ollama/provider-discovery.js";
    const packageRoot = makeInstalledPackageRoot();

    writeExpectedBundledExtensionManifests(packageRoot);
    writeInstalledFile(
      packageRoot,
      "dist/postinstall-inventory.json",
      JSON.stringify(requiredBundledPluginPackPaths.filter((entry) => entry !== relativePath)),
    );

    expect(collectInstalledBundledExtensionManifestErrors(packageRoot)).toContain(
      `installed bundled plugin artifact omitted from dist inventory: ${relativePath}.`,
    );
  });

  function expectedMissingManifests(packageRoot: string) {
    return expect.arrayContaining(
      ["ollama", "lmstudio"].flatMap((id) => [
        `installed bundled extension manifest missing: ${join(packageRoot, "dist/extensions", id, "package.json")}.`,
        `installed bundled plugin artifact missing: dist/extensions/${id}/openclaw.plugin.json.`,
      ]),
    );
  }

  it("verifies every bundled manifest when the build filter exists before module initialization", () => {
    const packageRoot = makeInstalledPackageRoot();

    const probe = withEnv({ OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "ollama" }, () =>
      spawnSync(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(toolingTsEntrypoints.npmPostpublish),
          ).slice(0, -1),
          "--input-type=module",
          "--eval",
          [
            `import { collectInstalledBundledExtensionManifestErrors } from ${JSON.stringify(resolveRuntimeWorkerUrl(toolingTsEntrypoints.npmPostpublish).href)};`,
            `process.stdout.write(JSON.stringify(collectInstalledBundledExtensionManifestErrors(${JSON.stringify(packageRoot)})));`,
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: process.env,
          timeout: 30_000,
        },
      ),
    );

    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(expectedMissingManifests(packageRoot));
  });

  it("surfaces invalid installed bundled extension manifests", () => {
    const packageRoot = makeInstalledPackageRoot();

    writeInstalledFile(packageRoot, "package.json", '{"version":"2026.3.23"}\n');
    writeExpectedBundledExtensionManifests(packageRoot);
    writeInstalledFile(packageRoot, "dist/extensions/telegram/package.json", "{not-json\n");
    writeInstalledFile(packageRoot, "dist/extensions/telegram/runtime-api.js", "export {};\n");

    const manifestErrors = collectInstalledBundledExtensionManifestErrors(packageRoot);
    expect(manifestErrors).toHaveLength(1);
    expect(manifestErrors[0]).toContain(
      "installed bundled extension manifest invalid: failed to parse",
    );
    expect(manifestErrors[0]).toContain("dist/extensions/telegram/package.json");

    expect(installedPackageErrors(packageRoot)).toContain(manifestErrors[0]);
  });
});

describe("collectInstalledContextEngineRuntimeErrors", () => {
  it("ignores extension-owned JavaScript assets", () => {
    const packageRoot = makeInstalledPackageRoot();

    writeInstalledFile(
      packageRoot,
      "dist/extensions/diffs/assets/viewer-runtime.js",
      'throw new Error("Failed to load legacy context engine runtime.");\n',
    );

    expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toStrictEqual([]);
  });

  it("refuses unbounded packaged dist scans", () => {
    const packageRoot = makeInstalledPackageRoot();

    for (let index = 0; index <= INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT; index += 1) {
      writeInstalledFile(packageRoot, `dist/chunk-${index}.js`);
    }

    expect(collectInstalledContextEngineRuntimeErrors(packageRoot)).toEqual([
      `installed package root dist contains more than ${INSTALLED_ROOT_DIST_JS_FILE_SCAN_LIMIT} JavaScript files; refusing to scan unbounded package contents.`,
    ]);
  });
});

describe("resolveInstalledBinaryCommandInvocation", () => {
  it("wraps the Windows installed npm shim without Node shell argv", () => {
    expect(
      resolveInstalledBinaryCommandInvocation(
        "C:/openclaw prefix",
        ["agent", "--message", "hello world"],
        {
          comSpec: "C:\\Windows\\System32\\cmd.exe",
          platform: "win32",
        },
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\openclaw prefix\\openclaw.cmd" agent --message "hello world""',
      ],
      windowsVerbatimArguments: true,
    });
  });
});

describe("collectInstalledRootDependencyManifestErrors", () => {
  function makeCompanionImportFixture(params: {
    source?: string;
    fileName?: string;
    companions?: Array<{ id: string; name?: string; dependencies: Record<string, string> }>;
    ownership?: unknown;
  }): { installRoot: string; packageRoot: string } {
    const installRoot = makeInstalledPackageRoot();
    const packageRoot = join(installRoot, "openclaw");
    writePackageFile(packageRoot, "package.json", {
      name: "openclaw",
      dependencies: {},
    });
    if (params.ownership !== undefined) {
      writePackageFile(packageRoot, RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH, params.ownership);
    }
    for (const companion of params.companions ?? [
      { id: "discord", dependencies: { "@discordjs/voice": "0.19.2" } },
    ]) {
      writePackageFile(installRoot, `@openclaw/${companion.id}/package.json`, {
        name: companion.name ?? `@openclaw/${companion.id}`,
        dependencies: companion.dependencies,
      });
    }
    writeInstalledFile(
      packageRoot,
      `dist/${params.fileName ?? "companion-runtime.js"}`,
      params.source ?? companionSource,
    );
    return { installRoot, packageRoot };
  }

  it("accepts Bun built-in modules without npm dependency declarations", () => {
    const packageRoot = makeInstalledPackageRoot();

    writePackageFile(packageRoot, "package.json", {
      dependencies: {},
    });
    writeInstalledFile(
      packageRoot,
      "dist/bun-sqlite-library.js",
      'import { Database } from "bun:sqlite";\nconst { dlopen } = require("bun:ffi");\nexport { Database, dlopen };\n',
    );

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
  });

  const companionSource = 'const voice = require("@discordjs/voice");\nexport { voice };\n';
  const companionOwnership = {
    chunks: {
      "companion-runtime.js": {
        sha256: createHash("sha256").update(companionSource).digest("hex"),
        extensions: ["discord"],
      },
    },
  };
  const legacyCompanionSource = [
    'import { createRequire } from "node:module";',
    "//#region extensions/discord/src/voice/sdk-runtime.ts",
    'const voice = createRequire(import.meta.url)("@discordjs/voice");',
    "//#endregion",
    "export { voice };",
    "",
  ].join("\n");
  const writeTrustedDiscordManifest = (installRoot: string) => {
    const manifestRoot = join(installRoot, "trusted-extensions");
    writePackageFile(manifestRoot, "discord/package.json", {
      name: "@openclaw/discord",
      dependencies: { "@discordjs/voice": "0.19.2" },
    });
    return manifestRoot;
  };

  function makeLegacyFixture(source = legacyCompanionSource, fileName?: string) {
    const { installRoot, packageRoot } = makeCompanionImportFixture({
      companions: [],
      source,
      fileName,
    });
    const trustedManifestRoot = writeTrustedDiscordManifest(installRoot);
    return {
      packageRoot,
      legacyErrors: () =>
        collectInstalledRootDependencyManifestErrors(packageRoot, [trustedManifestRoot], true),
    };
  }

  it("accepts byte-matched ownership from an additional trusted companion manifest root", () => {
    const { installRoot, packageRoot } = makeCompanionImportFixture({
      companions: [],
      ownership: companionOwnership,
    });
    const trustedManifestRoot = writeTrustedDiscordManifest(installRoot);

    expect(
      collectInstalledRootDependencyManifestErrors(packageRoot, [trustedManifestRoot]),
    ).toStrictEqual([]);
  });

  it("uses generated region ownership only when the compatibility gate is enabled", () => {
    const { packageRoot, legacyErrors } = makeLegacyFixture();
    const missingDependency =
      "installed package root is missing declared runtime dependency '@discordjs/voice' for dist importers: companion-runtime.js. Add it to package.json dependencies/optionalDependencies.";

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([missingDependency]);
    expect(legacyErrors()).toStrictEqual([]);
  });

  it("preserves plugin ownership through hoisted static imports", () => {
    const { packageRoot, legacyErrors } = makeLegacyFixture();
    writeFileSync(
      join(packageRoot, "dist/plugin-runtime.js"),
      [
        'import "./companion-runtime.js";',
        "//#region extensions/discord/src/runtime.ts",
        "export const enabled = true;",
        "//#endregion",
      ].join("\n"),
    );
    expect(legacyErrors()).toEqual([]);
    writePackageFile(packageRoot, "package.json", { main: "dist/root.js" });
    writeInstalledFile(packageRoot, "dist/root.js", 'import "./plugin-runtime.js";');
    expect(legacyErrors()).toEqual([
      expect.stringContaining("dist importers: companion-runtime.js."),
    ]);
  });

  it.each([
    { main: "dist/nested", fileName: "nested/index.js" },
    { bin: { openclaw: "./dist/companion-runtime.js" } },
    { exports: { "./*": "./dist/*.js" }, fileName: "nested/runtime.js" },
  ])("keeps legacy public entrypoints root-owned: %j", ({ fileName, ...entrypoints }) => {
    const { packageRoot, legacyErrors } = makeLegacyFixture(undefined, fileName);
    writePackageFile(packageRoot, "package.json", { name: "openclaw", ...entrypoints });
    expect(legacyErrors()).toEqual([expect.stringContaining("@discordjs/voice")]);
  });

  it.each([
    {
      name: "a loader bound inside a plugin region and used outside",
      source: [
        'import { createRequire } from "node:module";',
        "//#region extensions/discord/src/runtime.ts",
        "const load = createRequire(import.meta.url);",
        'const voice = load("@discordjs/voice");',
        "//#endregion",
        'load("@discordjs/voice");',
      ].join("\n"),
    },
    {
      name: "region markers inside a template literal",
      source:
        'const text = `//#region extensions/discord/src/runtime.ts\n${require("@discordjs/voice")}\n//#endregion`;',
    },
  ])("rejects legacy ownership for $name", ({ source }) => {
    const { legacyErrors } = makeLegacyFixture(source);
    expect(legacyErrors()).toEqual([expect.stringContaining("@discordjs/voice")]);
  });

  it.each<{
    name: string;
    companions: Array<{ id: string; name?: string; dependencies: Record<string, string> }>;
  }>([
    { name: "missing companion", companions: [] },
    {
      name: "wrong companion identity",
      companions: [
        {
          id: "discord",
          name: "unrelated-package",
          dependencies: { "@discordjs/voice": "0.19.2" },
        },
      ],
    },
    {
      name: "dependency declared only by another companion",
      companions: [
        { id: "discord", dependencies: {} },
        { id: "msteams", dependencies: { "@discordjs/voice": "0.19.2" } },
      ],
    },
  ])("rejects chunk ownership with $name", ({ companions }) => {
    const { packageRoot } = makeCompanionImportFixture({
      companions,
      ownership: companionOwnership,
    });

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
      "installed package root is missing declared runtime dependency '@discordjs/voice' for dist importers: companion-runtime.js. Add it to package.json dependencies/optionalDependencies.",
    ]);
  });

  it("does not authorize changed chunk bytes", () => {
    const { packageRoot } = makeCompanionImportFixture({
      ownership: companionOwnership,
      source: `${companionSource}export const changed = true;\n`,
    });

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
      expect.stringContaining("companion-runtime.js"),
    ]);
  });

  it.each([
    {
      name: "another build output importing the same dependency",
      fileName: "config-doctor/runtime.js",
      source: 'require("@discordjs/voice");\n',
      missingImporter: "config-doctor/runtime.js",
      companionFileName: "companion-runtime.js",
    },
    {
      name: "a directory root require reaching the annotated chunk",
      fileName: "root-runtime.cjs",
      source: 'require("./nested");\n',
      missingImporter: "nested/index.js",
      companionFileName: "nested/index.js",
    },
  ])("does not exempt $name", ({ fileName, source, missingImporter, companionFileName }) => {
    const { packageRoot } = makeCompanionImportFixture({
      ownership: {
        chunks: { [companionFileName]: companionOwnership.chunks["companion-runtime.js"] },
      },
      fileName: companionFileName,
    });

    writeInstalledFile(packageRoot, `dist/${fileName}`, source);
    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
      `installed package root is missing declared runtime dependency '@discordjs/voice' for dist importers: ${missingImporter}. Add it to package.json dependencies/optionalDependencies.`,
    ]);
  });

  it("rejects malformed emitted ownership metadata", () => {
    const { packageRoot } = makeCompanionImportFixture({
      ownership: {
        chunks: {
          "companion-runtime.js": {
            sha256: createHash("sha256").update(companionSource).digest("hex"),
            extensions: ["discord", "discord"],
          },
        },
      },
    });

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual([
      expect.stringContaining("installed package runtime dependency ownership is invalid"),
    ]);
  });

  it("accepts optional or externalized runtime imports", () => {
    const packageRoot = makeInstalledPackageRoot();

    writePackageFile(packageRoot, "package.json", {
      dependencies: {},
    });
    writeInstalledFile(
      packageRoot,
      "dist/optional-runtime.js",
      ['await import("@a2ui/markdown-it");', 'await import("@lancedb/lancedb");', ""].join("\n"),
    );
    writeInstalledFile(
      packageRoot,
      "dist/externalized-plugin-runtime.js",
      [
        'import * as lark from "@larksuiteoapi/node-sdk";',
        'import prism from "prism-media";',
        "export { lark, prism };",
        "",
      ].join("\n"),
    );
    writeInstalledFile(
      packageRoot,
      "dist/plugin-sdk/channel-test-helpers.js",
      'import { expect, it } from "vitest";\nexport { expect, it };\n',
    );

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toStrictEqual([]);
  });

  it.each([
    [
      "block shadow",
      '{ const require = (name) => name; require("view-name"); } require("root-runtime");',
      ["root-runtime", "view-name"],
    ],
    [
      "assigned destructured binding",
      'import { createRequire } from "node:module"; let { load } = loaders; load = createRequire(import.meta.url); load("root-runtime");',
      ["root-runtime"],
    ],
    [
      "factory with alternative root alias",
      'import { createRequire } from "node:module"; const root = createRequire(import.meta.url); let make = createRequire; const load = make(import.meta.url); make = root; load("root-runtime");',
      ["root-runtime"],
    ],
    [
      "conditional roots",
      'import { createRequire } from "node:module"; const require = usePlugin ? createRequire(pluginPath) : createRequire(import.meta.url); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "logical factory",
      'import { createRequire } from "node:module"; const preferred = null; const make = preferred || createRequire; const require = make(import.meta.url); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "comma factory",
      'import { createRequire } from "node:module"; const require = (0, createRequire)(import.meta.url); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "quoted namespace",
      'import * as module from "node:module"; const require = module["createRequire"](import.meta["url"]); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "quoted factory binding",
      'const { "createRequire": make } = require("node:module"); const load = make(__filename); load("root-runtime");',
      ["root-runtime"],
    ],
    [
      "awaited builtin",
      'const { createRequire: make } = await import("node:module"); const require = make(import.meta.url); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "process namespace accessor",
      'const processNamespace = require("node:process"); const load = processNamespace.getBuiltinModule("node:module").createRequire(__filename); load("root-runtime");',
      ["root-runtime"],
    ],
    [
      "caller-derived package anchor",
      'import { createRequire } from "node:module"; import fs from "node:fs/promises"; import path from "node:path"; async function build(opts) { const root = await fs.realpath(path.resolve(opts.root ?? process.cwd())); const require = createRequire(path.join(root, "package.json")); require("plugin-build-tool"); }',
      [],
    ],
    [
      "unknown dynamic caller property",
      'import { createRequire } from "node:module"; function build(opts, key, choose) { const selection = choose ? opts : opaqueOptions(); const require = createRequire(selection[key]); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "array destructuring loader write",
      'import { createRequire } from "node:module"; function build(anchor) { let require = createRequire(anchor); [require] = [createRequire(import.meta.url)]; require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "iteration loader write",
      'import { createRequire } from "node:module"; function build(anchor) { let require = createRequire(anchor); for (require of [createRequire(import.meta.url)]) { require("root-runtime"); } }',
      ["root-runtime"],
    ],
    [
      "function wrapper remains unknown",
      'import { createRequire as make } from "node:module"; const load = make(import.meta.url); function require(name) { return load(name); } require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "unknown supplied loader with caller default",
      'import { createRequire } from "node:module"; function build(root, loaders) { const [require = createRequire(root)] = loaders; require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "initialized CommonJS require before assignment",
      'require("root-runtime"); var require = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json");',
      ["root-runtime"],
    ],
    [
      "opaque projected input default",
      'import { createRequire } from "node:module"; function build(options) { let alias; ({ alias = options } = {}); normalize(alias); const require = createRequire(options.filename); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "raw caller after loop remains conservative",
      'import { createRequire } from "node:module"; function build(options) { for (const key in options) consume(key); const require = createRequire(options.filename); require("plugin-build-tool"); }',
      ["plugin-build-tool"],
    ],
    [
      "nested parameter default remains unknown",
      'import { createRequire } from "node:module"; function build({ nested: { filename } = { filename: import.meta.url } }) { const require = createRequire(filename); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "locally changed cwd",
      'import { createRequire } from "node:module"; import path from "node:path"; import { fileURLToPath } from "node:url"; process.chdir(path.dirname(fileURLToPath(import.meta.url))); const require = createRequire(path.resolve("bridge.cjs")); require("root-runtime");',
      ["root-runtime"],
    ],
    [
      "template coercion before snapshot",
      'import { createRequire } from "node:module"; function build(options) { const unused = `${options}`; const require = createRequire(options.filename); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "effectful parameter default before snapshot",
      'import { createRequire } from "node:module"; import path from "node:path"; function build(options, ignored = Object.assign(options, { filename: import.meta.url })) { const root = path.resolve(options.filename); const require = createRequire(root); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "ignored factory argument effect",
      'import { createRequire } from "node:module"; function build(location) { const require = createRequire(location, location.href = import.meta.url); require("root-runtime"); }',
      ["root-runtime"],
    ],
    [
      "pending normalization is not a string snapshot",
      'import { createRequire } from "node:module"; import fs from "node:fs/promises"; function build(options) { const pending = fs.realpath(options.filename); normalize(pending); return (async () => { const root = await pending; const require = createRequire(root); require("root-runtime"); })(); }',
      ["root-runtime"],
    ],
    [
      "compiled control UI builder ordering",
      'import { createRequire } from "node:module"; import fs from "node:fs/promises"; import path from "node:path"; async function build(params) { const rootDir = await fs.realpath(params.rootDir); const entry = await fs.realpath(path.resolve(rootDir, params.source)); if (!entry) throw new Error("missing entry"); const require = createRequire(path.join(rootDir, "package.json")); require("plugin-build-tool"); }',
      [],
    ],
  ])("follows lexical require ownership: %s", (_name, source, dependencies) => {
    const packageRoot = makeInstalledPackageRoot();
    writePackageFile(packageRoot, "package.json", { dependencies: {} });
    writeInstalledFile(packageRoot, "dist/runtime.js", source);
    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual(
      dependencies.map(
        (name) =>
          `installed package root is missing declared runtime dependency '${name}' for dist importers: runtime.js. Add it to package.json dependencies/optionalDependencies.`,
      ),
    );
  });

  it.each([
    {
      expected: [
        "installed package root dist file 'runtime/oversized.js' is invalid or exceeds 6291456 bytes.",
      ],
      name: "rejects oversized arbitrary nested dist files",
      relativePath: "runtime/oversized.js",
    },
    {
      expected: [],
      name: "accepts the oversized worker deploy entrypoint",
      relativePath: `worker/${WORKER_BUNDLE_ENTRY_PATH}`,
      source: `/* ${"x".repeat(6 * 1024 * 1024)} */\nthis is not valid JavaScript`,
    },
    {
      expected: [],
      name: "accepts the oversized sealed package-update recovery helper",
      relativePath: packageActivationRuntimeEntrypoint.distWorkerPath,
    },
  ])("$name", ({ expected, relativePath, source }) => {
    const packageRoot = makeInstalledPackageRoot();

    writePackageFile(packageRoot, "package.json", {
      dependencies: {},
    });
    const filePath = join(packageRoot, "dist", relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, source ?? `/* ${"x".repeat(6 * 1024 * 1024)} */\n`);

    expect(collectInstalledRootDependencyManifestErrors(packageRoot)).toEqual(expected);
  });
});

describe("runtime dependency ownership build contract", () => {
  async function buildInstalledFixture(
    rootSource: string,
    pluginSources: Record<string, string> = {},
  ) {
    const root = realpathSync(createTempDir("runtime-dependency-ownership-"));
    const files = {
      "package.json": JSON.stringify({ name: "openclaw", version: "2026.7.33", type: "module" }),
      "src/root.js": rootSource,
      "extensions/example/index.js": `
      export { value } from "../../src/shared.js";
      export const load = () => import("./lazy.js");
    `,
      "extensions/example/observer.js": 'export { value } from "../../src/shared.js";',
      "src/shared.js": 'export { value } from "fixture-runtime";',
      "extensions/example/lazy.js": 'export { lazy } from "fixture-lazy";',
      ...pluginSources,
    };
    for (const [name, source] of Object.entries(files)) {
      writeInstalledFile(root, name, source);
    }
    const { bundles } = await build({
      config: false,
      tsconfig: false,
      cwd: root,
      entry: {
        root: "src/root.js",
        "extensions/example/index": "extensions/example/index.js",
        "extensions/example/observer": "extensions/example/observer.js",
      },
      outDir: "dist",
      format: "esm",
      platform: "node",
      dts: false,
      logLevel: "silent",
      deps: { neverBundle: ["fixture-runtime", "fixture-lazy"] },
      plugins: [createRuntimeDependencyOwnershipBuildPlugin(root)],
    });
    try {
      writeFileSync(
        join(root, "dist/extensions/example/package.json"),
        JSON.stringify({
          name: "@openclaw/example",
          dependencies: { "fixture-runtime": "1.0.0", "fixture-lazy": "1.0.0" },
        }),
      );
      return root;
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  }

  it("preserves ownership through real postbuild runtime rewrites and forwarding aliases", async () => {
    const root = await buildInstalledFixture("export const ready = true;", {
      "extensions/example/index.js": 'export { value, load } from "./shared.runtime.js";',
      "extensions/example/observer.js": 'export { value, load } from "./shared.runtime.js";',
      "extensions/example/shared.runtime.js": `
        export { value } from "fixture-runtime";
        export const load = () => import("./downstream.runtime.js");
      `,
      "extensions/example/downstream.runtime.js": 'export { lazy } from "fixture-lazy";',
    });
    expect(collectInstalledRootDependencyManifestErrors(root)).toEqual([]);

    rewriteRootRuntimeImportsToStableAliases({ rootDir: root });
    writeStableRootRuntimeAliases({ rootDir: root });

    const dist = join(root, "dist");
    const sharedChunk = readdirSync(dist).find((name) => /^shared\.runtime-.*\.m?js$/u.test(name));
    expect(sharedChunk).toBeDefined();
    expect(readFileSync(join(dist, sharedChunk!), "utf8")).toContain('"./downstream.runtime.js"');
    expect(existsSync(join(dist, "shared.runtime.js"))).toBe(true);
    expect(existsSync(join(dist, "downstream.runtime.js"))).toBe(true);
    expect(collectInstalledRootDependencyManifestErrors(root)).toEqual([]);
  });

  it("verifies real static and dynamic plugin chunks against their owning manifest", async () => {
    const root = await buildInstalledFixture("export const ready = true;");
    expect(collectInstalledRootDependencyManifestErrors(root)).toEqual([]);

    writeFileSync(
      join(root, "dist/extensions/example/package.json"),
      JSON.stringify({ name: "@openclaw/example", dependencies: {} }),
    );
    expect(collectInstalledRootDependencyManifestErrors(root)).toEqual([
      expect.stringContaining("missing declared runtime dependency 'fixture-lazy'"),
      expect.stringContaining("missing declared runtime dependency 'fixture-runtime'"),
    ]);
  });

  it.each([
    [
      "createRequire import",
      `import { createRequire } from "node:module";
       export const value = createRequire(import.meta.url)("fixture-runtime");`,
    ],
    ["root-shared chunk", 'export { value } from "./shared.js";'],
  ])("rejects a root %s even when a plugin owns the same dependency", async (_name, source) => {
    const root = await buildInstalledFixture(source);
    expect(collectInstalledRootDependencyManifestErrors(root)).toEqual([
      expect.stringContaining("missing declared runtime dependency 'fixture-runtime'"),
    ]);
  });
});
