import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { build } from "tsdown";
import { expect, it, vi } from "vitest";
import { collectPackageDistImportErrors } from "../scripts/lib/package-dist-imports.mjs";
import { createRuntimeDependencyOwnershipBuildPlugin } from "../scripts/lib/runtime-dependency-ownership-build-plugin.mts";
import {
  collectInstalledContextEngineRuntimeErrors as contextErrors,
  collectInstalledRootDependencyManifestErrors as dependencyErrors,
  collectInstalledPackageErrors,
  fetchRegistryJson,
  resolvePublishedInstallSourceVerification as verifySource,
  resolveInstalledBinaryCommandInvocation,
  retryNpmRegistryProvenanceRead,
  verifyAttestedReleasePublishWorkflow,
  verifyNpmProvenanceAttestation,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import {
  rewriteRootRuntimeImportsToStableAliases,
  writeStableRootRuntimeAliases,
} from "../scripts/runtime-postbuild.mts";
import { resolveNodeBootstrapRuntimeChunks } from "../src/gateway/worker-environments/node-bootstrap-runtime-chunks.js";
import { collectPackageDistInventory } from "../src/infra/package-dist-inventory.js";
import { RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH } from "../src/infra/runtime-dependency-ownership.js";
import { WORKER_BUNDLE_ENTRY_PATH } from "../src/shared/worker-bundle-hash.js";
import { withEnv } from "../src/test-utils/env.js";
import { createScriptTestHarness } from "./scripts/test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const makeInstalledPackageRoot = (manifest?: unknown) => {
  const root = createTempDir("openclaw-postpublish-");
  if (manifest !== undefined) {
    writePackageFile(root, "package.json", manifest);
  }
  return root;
};
const distScanLimits = { root: 20_000, worker: 10_000 };

function writeInstalledFile(root: string, relativePath: string, source = "export {};\n") {
  const file = join(root, relativePath);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function writePackageFile(root: string, relativePath: string, value: unknown): void {
  writeInstalledFile(root, relativePath, JSON.stringify(value));
}

function expectDependencyErrors(root: string, ...fragments: string[]) {
  expect(dependencyErrors(root)).toEqual(fragments.map((part) => expect.stringContaining(part)));
}

function probeVerifier(packageRoot: string, exportName: string, timeout = 3000) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      `import { ${exportName} as verify } from "./scripts/openclaw-npm-postpublish-verify.ts"; console.log(JSON.stringify(verify(process.argv[1]))); process.exit(0);`,
      packageRoot,
    ],
    { encoding: "utf8", timeout },
  );
  expect([result.error, result.status], result.stderr).toEqual([undefined, 0]);
  return JSON.parse(result.stdout);
}

it("keeps trusted release verification independent from target app dependencies", () => {
  const source = fs.readFileSync("scripts/openclaw-npm-postpublish-verify.ts", "utf8");

  expect(source).toContain('from "./lib/error-format.mts"');
  expect(source).not.toContain('from "../src/infra/errors.ts"');
});

it.each(["legacy", "current", "mismatched"])("verifies %s source manifests", (kind) => {
  const sourceRoot = makeInstalledPackageRoot({ name: "openclaw", version: "2026.8.34" });
  if (kind === "current") {
    writeInstalledFile(sourceRoot, "scripts/lib/runtime-dependency-ownership-build-plugin.mts");
  }
  if (kind === "mismatched") {
    expect(() => verifySource(sourceRoot, "2026.9.7")).toThrow("source checkout version mismatch");
  } else {
    expect(verifySource(sourceRoot, "2026.8.34")).toEqual({
      additionalCompanionManifestRoots: [join(sourceRoot, "extensions")],
      allowLegacyGeneratedOwnership: kind === "legacy",
    });
  }
});

const packageName = "openclaw";
const version = "2026.3.23";
const publishSha = "a".repeat(40);
const publishRef = `refs/tags/release-publish/${publishSha.slice(0, 12)}-123`;
const integrity = `sha512-${Buffer.from("registry integrity", "utf8").toString("base64")}`;
type ProvenanceOptions = Parameters<typeof verifyNpmProvenanceAttestation>[0];
const buildProvenancePayload = (
  releaseVersion: string,
  workflowRef: string,
  workflowSha?: string,
) => {
  const workflow = {
    repository: "https://github.com/openclaw/openclaw",
    path: ".github/workflows/openclaw-npm-release.yml",
    ref: workflowRef,
  };
  const dependency = {
    uri: `git+https://github.com/openclaw/openclaw@${workflowRef}`,
    digest: { gitCommit: workflowSha },
  };
  const digest = {
    sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
  };
  return {
    subject: [{ name: `pkg:npm/${packageName}@${releaseVersion}`, digest }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow },
        ...(workflowSha ? { resolvedDependencies: [dependency] } : {}),
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
};
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
  vi.fn<NonNullable<ProvenanceOptions["verifyBundle"]>>(async () => undefined);

function verifyProvenance(overrides: Partial<ProvenanceOptions> = {}) {
  return expect(
    verifyNpmProvenanceAttestation({
      packageName,
      version,
      integrity,
      attestations: attestationsFor(provenancePayload),
      verifyBundle: async () => undefined,
      ...overrides,
    }),
  );
}

it.each<[() => Response, { maxBodyBytes?: number; timeoutMs: number }, string]>([
  [
    () => new Response("x".repeat(65), { headers: { "content-length": "65" } }),
    { maxBodyBytes: 64, timeoutMs: 1234 },
    "npm registry https://registry.example/openclaw response body exceeded 64 bytes",
  ],
  [
    () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    { timeoutMs: 5 },
    "npm registry request timed out after 5ms: https://registry.example/openclaw",
  ],
])("bounds registry response reading %#", async (response, options, error) => {
  await expect(
    fetchRegistryJson("https://registry.example/openclaw", {
      fetchImpl: async () => response(),
      ...options,
    }),
  ).rejects.toThrow(error);
});

it("requires a trusted GitHub release identity for the exact SLSA provenance attestation", async () => {
  const verifyBundle = makeBundleVerifier();
  await verifyProvenance({ verifyBundle }).resolves.toBeUndefined();
  expect(verifyBundle.mock.calls[0]?.[1]).toEqual(releaseIdentity("refs/heads/release/2026.3.23"));

  const pinned = {
    attestations: attestationsFor(buildProvenancePayload(version, publishRef, publishSha)),
    expectedWorkflowRef: publishRef,
    expectedWorkflowSha: publishSha,
    verifyBundle,
  };
  await verifyProvenance(pinned).resolves.toBeUndefined();
  expect(verifyBundle.mock.calls[1]?.[1]).toEqual(releaseIdentity(publishRef));
  await verifyProvenance({ ...pinned, expectedWorkflowSha: "b".repeat(40) }).rejects.toThrow(
    "npm provenance SHA-pinned release-publish ref does not match the approved workflow ref and SHA",
  );
  await verifyProvenance({
    attestations: attestationsFor({
      ...provenancePayload,
      subject: [{ name: "pkg:npm/openclaw@2026.3.24", digest: {} }],
    }),
  }).rejects.toThrow("does not match");
});

it("derives attested release-publish tooling only after the trusted-source check", async () => {
  const attestations = attestationsFor(buildProvenancePayload(version, publishRef, publishSha));
  const verifyBundle = makeBundleVerifier();
  const verifyDerivedWorkflow = vi.fn();
  const verify = (overrides: Partial<ProvenanceOptions> = {}) =>
    verifyProvenance({ attestations, verifyBundle, verifyDerivedWorkflow, ...overrides });

  await verify().resolves.toBeUndefined();
  expect(verifyDerivedWorkflow).toHaveBeenCalledExactlyOnceWith({
    ref: publishRef,
    sha: publishSha,
  });
  expect(verifyBundle.mock.calls[0]?.[1]).toEqual(releaseIdentity(publishRef));

  verifyBundle.mockClear();
  await verify({
    verifyDerivedWorkflow: () => {
      throw new Error("protected release tooling tag is missing or unreadable.");
    },
  }).rejects.toThrow("protected release tooling tag is missing or unreadable.");
  expect(verifyBundle).not.toHaveBeenCalled();

  // An attested commit that does not match the tag's SHA prefix is never derived.
  await verify({
    attestations: attestationsFor(buildProvenancePayload(version, publishRef, "b".repeat(40))),
  }).rejects.toThrow("has no matching workflow revision to verify");

  // A partial explicit override stays strict instead of falling back to derivation.
  verifyDerivedWorkflow.mockClear();
  await verify({ expectedWorkflowRef: publishRef }).rejects.toThrow(
    "does not match the approved workflow ref and SHA",
  );
  expect(verifyDerivedWorkflow).not.toHaveBeenCalled();
});

it("trusts derived publish tooling only at the live exact tag on main", () => {
  const tag = publishRef.slice("refs/tags/".length);
  const runGh = (tagSha: string, mainStatus: string) => (args: string[]) =>
    args[1]?.includes("/git/ref/tags/")
      ? JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: tagSha } })
      : JSON.stringify({ status: mainStatus });
  const identity = { ref: publishRef, sha: publishSha };

  expect(() =>
    verifyAttestedReleasePublishWorkflow(identity, runGh(publishSha, "ahead")),
  ).not.toThrow();
  expect(() =>
    verifyAttestedReleasePublishWorkflow(identity, runGh("b".repeat(40), "ahead")),
  ).toThrow("bound to the wrong SHA");
  expect(() =>
    verifyAttestedReleasePublishWorkflow(identity, runGh(publishSha, "diverged")),
  ).toThrow("not reachable from current main");
});

it.each([
  ["ordinary release from a feature branch", version, "refs/heads/feature/untrusted"],
  ["later patch on a noncanonical branch", "2026.6.34", "refs/heads/extended-stable/2026.6.34"],
])("rejects untrusted release provenance for %s", async (_label, releaseVersion, workflowRef) => {
  const verifyBundle = makeBundleVerifier();

  await verifyProvenance({
    version: releaseVersion,
    attestations: attestationsFor(buildProvenancePayload(releaseVersion, workflowRef)),
    verifyBundle,
  }).rejects.toThrow(
    `does not bind ${releaseVersion} to the trusted OpenClaw GitHub release workflow`,
  );
  expect(verifyBundle).not.toHaveBeenCalled();
});

it("rejects a matching provenance payload when Sigstore cannot verify its bundle", async () => {
  await verifyProvenance({
    verifyBundle: async () => {
      throw new Error("forged bundle");
    },
  }).rejects.toThrow("failed Sigstore verification");
});

it("retries incomplete or briefly stale provenance while npm publish propagates", async () => {
  const delays: number[] = [];
  const failures = [
    "npm registry metadata is incomplete for openclaw@2026.3.23.",
    "npm registry provenance metadata is incomplete for openclaw@2026.3.23.",
  ];
  const read = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error(failures[0]))
    .mockRejectedValueOnce(new Error(failures[1]))
    .mockResolvedValue("verified");
  await expect(
    retryNpmRegistryProvenanceRead(read, {
      attempts: 3,
      delay: async (delayMs) => void delays.push(delayMs),
    }),
  ).resolves.toBe("verified");
  expect(read).toHaveBeenCalledTimes(3);
  expect(delays).toEqual([1000, 2000]);
});

it.each([
  "npm provenance attestation does not bind 2026.3.23 to the trusted OpenClaw GitHub release workflow.",
  "npm registry signature verification timed out after an integrity mismatch.",
])("does not retry permanent provenance or integrity mismatch: %s", async (message) => {
  const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error(message));
  await expect(
    retryNpmRegistryProvenanceRead(read, {
      attempts: 3,
      delay: async () => {
        throw new Error("unexpected retry");
      },
    }),
  ).rejects.toThrow(message);
  expect(read).toHaveBeenCalledOnce();
});

it("rejects an oversized worker before the full verifier reads its contents", () => {
  const packageRoot = makeInstalledPackageRoot();

  writeInstalledFile(packageRoot, "package.json", '{"version":"2026.3.23"}\n');
  const workerPath = writeInstalledFile(
    packageRoot,
    `dist/worker/${WORKER_BUNDLE_ENTRY_PATH}`,
    "/* Failed to load legacy context engine runtime. */\n",
  );
  fs.truncateSync(workerPath, 80 * 1024 * 1024 + 1);

  const errors = collectInstalledPackageErrors({
    expectedVersion: version,
    installedVersion: version,
    packageRoot,
  });
  const sizeError = `installed package root dist file 'worker/${WORKER_BUNDLE_ENTRY_PATH}' is invalid or exceeds 83886080 bytes.`;

  expect(errors.filter((error) => error === sizeError)).toEqual([sizeError]);
  expect(errors).not.toContain(
    "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
  );
});

it("verifies every bundled manifest when the build filter exists before module initialization", () => {
  const packageRoot = makeInstalledPackageRoot();
  const errors = withEnv({ OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: "ollama" }, () =>
    probeVerifier(packageRoot, "collectInstalledBundledExtensionManifestErrors", 30_000),
  );
  expect(errors).toEqual(
    expect.arrayContaining(
      ["ollama", "lmstudio"].flatMap((id) => [
        `installed bundled extension manifest missing: ${join(packageRoot, "dist/extensions", id, "package.json")}.`,
        `installed bundled plugin artifact missing: dist/extensions/${id}/openclaw.plugin.json.`,
      ]),
    ),
  );
});

it.each([
  ["root", distScanLimits.root + 1],
  ["worker", distScanLimits.worker],
] as const)("bounds the %s packaged dist scan", (scope, count) => {
  const packageRoot = makeInstalledPackageRoot();
  if (scope === "worker") {
    writeInstalledFile(packageRoot, "dist/root.js");
  }
  for (let index = 0; index < count; index += 1) {
    writeInstalledFile(
      packageRoot,
      scope === "root" ? `dist/chunk-${index}.js` : `dist/worker/worker-chunk-${index}.mjs`,
    );
  }
  expect(contextErrors(packageRoot)).toStrictEqual(
    scope === "worker"
      ? []
      : [
          `installed package root dist contains more than ${distScanLimits.root} JavaScript files; refusing to scan unbounded package contents.`,
        ],
  );
});

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
    args: ["/d", "/s", "/c", '""C:\\openclaw prefix\\openclaw.cmd" agent --message "hello world""'],
    windowsVerbatimArguments: true,
  });
});

it("finishes vendor call graphs while retaining root dependency checks", () => {
  const packageRoot = makeInstalledPackageRoot({ name: "openclaw", dependencies: {} });
  const calls = ["const value0 = opaque();"];
  for (let index = 1; index <= 28; index++) {
    calls.push(`const value${index} = opaque(value${index - 1}, value${index - 1});`);
  }
  writeInstalledFile(
    packageRoot,
    "dist/vendor.js",
    `${calls.join("\n")}\nrequire("root-runtime");`,
  );
  // A subprocess deadline is necessary because the original synchronous graph scan never yields.
  expect(probeVerifier(packageRoot, "collectInstalledRootDependencyManifestErrors")).toEqual([
    "installed package root is missing declared runtime dependency 'root-runtime' for dist importers: vendor.js. Add it to package.json dependencies/optionalDependencies.",
  ]);
});

function makeCompanionImportFixture(params: {
  source?: string;
  fileName?: string;
  ownership?: unknown;
}): string {
  const packageRoot = makeInstalledPackageRoot({ name: "openclaw", dependencies: {} });
  if (params.ownership !== undefined) {
    writePackageFile(packageRoot, RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH, params.ownership);
  }
  writeInstalledFile(
    packageRoot,
    `dist/${params.fileName ?? "companion-runtime.js"}`,
    params.source ?? companionSource,
  );
  return packageRoot;
}

const companionSource = 'require("@discordjs/voice");';
const discordManifest = {
  name: "@openclaw/discord",
  dependencies: { "@discordjs/voice": "0.19.2" },
};
const companionOwnership = (extensions = ["discord"]) => ({
  chunks: {
    "companion-runtime.js": {
      sha256: createHash("sha256").update(companionSource).digest("hex"),
      extensions,
    },
  },
});
const pluginRegion = (source: string) =>
  `//#region extensions/discord/src/voice/sdk-runtime.ts\n${source}\n//#endregion`;
const legacyCompanionSource = `import { createRequire } from "node:module";\n${pluginRegion('createRequire(import.meta.url)("@discordjs/voice");')}`;
function makeLegacyFixture(source = legacyCompanionSource, fileName?: string) {
  const packageRoot = makeCompanionImportFixture({ source, fileName });
  const trustedManifestRoot = join(packageRoot, "trusted-extensions");
  writePackageFile(trustedManifestRoot, "discord/package.json", discordManifest);
  return {
    packageRoot,
    legacyErrors: () => dependencyErrors(packageRoot, [trustedManifestRoot], true),
  };
}

it.each(["//#region", "//"])(
  "uses generated source ownership only when the compatibility gate is enabled (%s)",
  (label) => {
    const source = legacyCompanionSource
      .replace("//#region", label)
      .replace("//#endregion", label === "//" ? "" : "//#endregion");
    const { packageRoot, legacyErrors } = makeLegacyFixture(source);
    expectDependencyErrors(packageRoot, "@discordjs/voice");
    expect(legacyErrors()).toStrictEqual([]);
  },
);

it.each(["//#region", "//"])(
  "does not infer plugin ownership from labels inside strings (%s)",
  (label) => {
    const source = `const text = \`\n${label} extensions/discord/src/voice/sdk-runtime.ts\nconst harmless = true;\n//#endregion\n\`;\nrequire("@discordjs/voice");`;
    const { legacyErrors } = makeLegacyFixture(source);
    expect(legacyErrors()).toEqual([expect.stringContaining("@discordjs/voice")]);
  },
);

it("preserves plugin ownership through hoisted static imports", () => {
  const { packageRoot, legacyErrors } = makeLegacyFixture();
  writeInstalledFile(
    packageRoot,
    "dist/plugin-runtime.js",
    `import "./companion-runtime.js";\n${pluginRegion("export const enabled = true;")}`,
  );
  expect(legacyErrors()).toEqual([]);
  writePackageFile(packageRoot, "package.json", { main: "dist/root.js" });
  writeInstalledFile(packageRoot, "dist/root.js", 'import "./plugin-runtime.js";');
  expect(legacyErrors()).toEqual([
    expect.stringContaining("dist importers: companion-runtime.js."),
  ]);
});

it("keeps legacy directory entrypoints root-owned", () => {
  const { packageRoot, legacyErrors } = makeLegacyFixture(undefined, "nested/index.js");
  writePackageFile(packageRoot, "package.json", { name: "openclaw", main: "dist/nested" });
  expect(legacyErrors()).toEqual([expect.stringContaining("@discordjs/voice")]);
});

it.each(["//#region", "//"])(
  "rejects legacy ownership for a loader used outside its plugin region (%s)",
  (label) => {
    const source =
      `import { createRequire } from "node:module";\n${pluginRegion('const load = createRequire(import.meta.url); load("@discordjs/voice");')}\n// src/root.ts\nload("@discordjs/voice");`
        .replace("//#region", label)
        .replace("//#endregion", label === "//" ? "" : "//#endregion");
    const { legacyErrors } = makeLegacyFixture(source);
    expect(legacyErrors()).toEqual([expect.stringContaining("@discordjs/voice")]);
  },
);

it.each<[string, Parameters<typeof makeCompanionImportFixture>[0], string[]]>([
  ["Bun built-ins", { source: 'import "bun:sqlite"; require("bun:ffi");' }, []],
  [
    "optional A2UI",
    {
      fileName: "canvas-host/a2ui/a2ui.bundle.js",
      source: 'import("@a2ui/markdown-it").catch(() => null);',
    },
    [],
  ],
  [
    "changed bytes",
    { ownership: companionOwnership(), source: `${companionSource}export const changed = true;` },
    ["companion-runtime.js"],
  ],
  [
    "malformed ownership",
    { ownership: companionOwnership(["discord", "discord"]) },
    ["installed package runtime dependency ownership is invalid"],
  ],
])("checks dependency ownership for %s", (_name, fixture, errors) => {
  expectDependencyErrors(makeCompanionImportFixture(fixture), ...errors);
});

it.each([
  ...[
    'import { createRequire } from "node:module"; let { load } = loaders; load = createRequire(import.meta.url); load("root-runtime");',
    'import { createRequire } from "node:module"; const root = createRequire(import.meta.url); let make = createRequire; const load = make(import.meta.url); make = root; load("root-runtime");',
    'import { createRequire } from "node:module"; const require = usePlugin ? createRequire(pluginPath) : createRequire(import.meta.url); require("root-runtime");',
    'import { createRequire } from "node:module"; const require = (0, createRequire)(import.meta.url); require("root-runtime");',
    'import * as module from "node:module"; const require = module["createRequire"](import.meta["url"]); require("root-runtime");',
    'const { "createRequire": make } = require("node:module"); const load = make(__filename); load("root-runtime");',
    'const { createRequire: make } = await import("node:module"); const require = make(import.meta.url); require("root-runtime");',
    'const processNamespace = require("node:process"); const load = processNamespace.getBuiltinModule("node:module").createRequire(__filename); load("root-runtime");',
    'import { createRequire } from "node:module"; function build(opts, key, choose) { const selection = choose ? opts : opaqueOptions(); const require = createRequire(selection[key]); require("root-runtime"); }',
    'import { createRequire } from "node:module"; function build(anchor) { let require = createRequire(anchor); [require] = [createRequire(import.meta.url)]; require("root-runtime"); }',
    'import { createRequire } from "node:module"; function build(anchor) { let require = createRequire(anchor); for (require of [createRequire(import.meta.url)]) { require("root-runtime"); } }',
    'import { createRequire as make } from "node:module"; const load = make(import.meta.url); function require(name) { return load(name); } require("root-runtime");',
    'import { createRequire } from "node:module"; function build(root, loaders) { const [require = createRequire(root)] = loaders; require("root-runtime"); }',
    'require("root-runtime"); var require = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json");',
    'import { createRequire } from "node:module"; function build(options) { let alias; ({ alias = options } = {}); normalize(alias); const require = createRequire(options.filename); require("root-runtime"); }',
    'import { createRequire } from "node:module"; function build({ nested: { filename } = { filename: import.meta.url } }) { const require = createRequire(filename); require("root-runtime"); }',
    'import { createRequire } from "node:module"; import path from "node:path"; import { fileURLToPath } from "node:url"; process.chdir(path.dirname(fileURLToPath(import.meta.url))); const require = createRequire(path.resolve("bridge.cjs")); require("root-runtime");',
    'import { createRequire } from "node:module"; function build(options) { const unused = `${options}`; const require = createRequire(options.filename); require("root-runtime"); }',
    'import { createRequire } from "node:module"; import path from "node:path"; function build(options, ignored = Object.assign(options, { filename: import.meta.url })) { const root = path.resolve(options.filename); const require = createRequire(root); require("root-runtime"); }',
    'import { createRequire } from "node:module"; function build(location) { const require = createRequire(location, location.href = import.meta.url); require("root-runtime"); }',
    'import { createRequire } from "node:module"; import fs from "node:fs/promises"; function build(options) { const pending = fs.realpath(options.filename); normalize(pending); return (async () => { const root = await pending; const require = createRequire(root); require("root-runtime"); })(); }',
  ].map((source): [string, string[]] => [source, ["root-runtime"]]),
  [
    'import { createRequire } from "node:module"; import fs from "node:fs/promises"; import path from "node:path"; async function build(opts) { const root = await fs.realpath(path.resolve(opts.root ?? process.cwd())); const require = createRequire(path.join(root, "package.json")); require("plugin-build-tool"); }',
    [],
  ],
  [
    'import { createRequire } from "node:module"; function build(options) { for (const key in options) consume(key); const require = createRequire(options.filename); require("plugin-build-tool"); }',
    ["plugin-build-tool"],
  ],
] satisfies Array<[string, string[]]>)(
  "follows lexical require ownership: %s",
  (source, dependencies) => {
    const packageRoot = makeInstalledPackageRoot({ dependencies: {} });
    writeInstalledFile(packageRoot, "dist/runtime.js", source);
    expect(dependencyErrors(packageRoot)).toEqual(
      dependencies.map(
        (dependency) =>
          `installed package root is missing declared runtime dependency '${dependency}' for dist importers: runtime.js. Add it to package.json dependencies/optionalDependencies.`,
      ),
    );
  },
);

const pluginDependencies = { "fixture-runtime": "1.0.0", "fixture-lazy": "1.0.0" };
function writePluginManifest(
  root: string,
  owner: string,
  dependencies: Record<string, string> = pluginDependencies,
) {
  const manifest = { name: `@openclaw/${owner}`, dependencies };
  writePackageFile(root, `dist/extensions/${owner}/package.json`, manifest);
}

async function buildInstalledFixture(
  rootSource: string,
  pluginSources: Record<string, string> = {},
  extraEntries: Record<string, string> = {},
) {
  const root = fs.realpathSync(createTempDir("runtime-dependency-ownership-"));
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
      ...extraEntries,
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
    writePluginManifest(root, "example");
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
  expectDependencyErrors(root);

  rewriteRootRuntimeImportsToStableAliases({ rootDir: root });
  writeStableRootRuntimeAliases({ rootDir: root });

  expectDependencyErrors(root);
});

it.each<[string, Record<string, string>, Record<string, string>]>([
  ["example", {}, {}],
  [
    "other",
    {
      "extensions/other/index.js": 'export { value } from "../../src/shared.js";',
      "src/shared.js": `
          export { value } from "fixture-runtime";
          export const load = () => import("../extensions/example/lazy.js");
        `,
      "extensions/example/lazy.js": `
          export { lazy } from "fixture-lazy";
          export const back = () => import("../../src/shared.js");
        `,
    },
    { "extensions/other/index": "extensions/other/index.js" },
  ],
])("checks static, dynamic and cyclic chunk ownership for %s", async (owner, sources, entries) => {
  const root = await buildInstalledFixture("export const ready = true;", sources, entries);
  writePluginManifest(root, owner);
  expectDependencyErrors(root);

  writePluginManifest(root, owner, {});
  expectDependencyErrors(
    root,
    "missing declared runtime dependency 'fixture-lazy'",
    "missing declared runtime dependency 'fixture-runtime'",
  );
});

it("rejects a root-shared chunk even when a plugin owns the same dependency", async () => {
  const root = await buildInstalledFixture('export { value } from "./shared.js";');
  expectDependencyErrors(root, "missing declared runtime dependency 'fixture-runtime'");
});

it.each([false, true])(
  "omits private SDK test workers from the built node distribution (QA: %s)",
  async (qa) => {
    const root = await buildInstalledFixture(
      "export const ready = true;",
      {
        "test/helpers/sqlite-worker-fault.ts": `
        export const marker = "qa-only";
        export const faultWorker = () => new URL("./sqlite-worker-fault.worker.mjs", import.meta.url);
      `,
        "src/plugin-sdk/sqlite-runtime-testing.ts":
          'export { marker, faultWorker } from "../../test/helpers/sqlite-worker-fault.ts";',
        "src/plugin-sdk/test-state.ts":
          'export { faultWorker } from "../../test/helpers/sqlite-worker-fault.ts";',
        "extensions/qa-lab/index.js":
          'export { marker } from "../../src/plugin-sdk/sqlite-runtime-testing.ts";',
      },
      {
        "plugin-sdk/sqlite-runtime-testing": "src/plugin-sdk/sqlite-runtime-testing.ts",
        "plugin-sdk/test-state": "src/plugin-sdk/test-state.ts",
        ...(qa ? { "extensions/qa-lab/index": "extensions/qa-lab/index.js" } : {}),
      },
    );
    const manifest = {
      files: [
        "dist/",
        "!dist/extensions/qa-lab/**",
        "!dist/plugin-sdk/sqlite-runtime-testing.*",
        "!dist/plugin-sdk/test-state.*",
      ],
    };
    const { files } = await resolveNodeBootstrapRuntimeChunks(
      root,
      await collectPackageDistInventory(root, { packageManifest: manifest }),
      manifest.files,
    );
    expect(files).toEqual(expect.arrayContaining([expect.stringMatching(/^dist\/root\.m?js$/u)]));
    expect(
      collectPackageDistImportErrors({
        files,
        readText: (file) => fs.readFileSync(join(root, file), "utf8"),
      }),
    ).toEqual([]);
  },
);
