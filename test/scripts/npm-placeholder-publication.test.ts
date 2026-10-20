import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertFinalRegistryState,
  classifyRegistryState,
  createPlaceholderPublication,
  createPlaceholderTarball,
  parseSelectedPackages,
  publishPlaceholders,
  resolveSelectedPackageSources,
  verifyPlaceholderArtifact,
} from "../../scripts/npm-placeholder-publication.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const WORKFLOW = ".github/workflows/npm-placeholder-bootstrap.yml";
const packageName = "@openclaw/meta-provider";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { environment?: string; permissions?: Record<string, string>; steps?: Step[] };
type RegistryTags = Record<string, string>;
const step = (job: Job | undefined, name: string) => job?.steps?.find((item) => item.name === name);

function packageEntry(dir: string, name: string, fields: Record<string, unknown> = {}) {
  return {
    dir,
    manifest: {
      name,
      openclaw: {
        install: { npmSpec: name },
        build: { bundledDist: false },
        release: { publishToClawHub: true, publishToNpm: true },
      },
      ...fields,
    },
  };
}

function createRepo(packages: Array<{ dir: string; manifest: Record<string, unknown> }>) {
  const root = tempDirs.make("npm-placeholder-repo-");
  for (const entry of packages) {
    const dir = join(root, "extensions", entry.dir);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "package.json"), entry.manifest);
  }
  const catalogDir = join(root, "scripts", "lib");
  mkdirSync(catalogDir, { recursive: true });
  writeJson(join(catalogDir, "official-external-plugin-catalog.json"), {
    entries: packages.map(({ manifest: { name } }) => ({
      name,
      source: "official",
      openclaw: { install: { npmSpec: name } },
    })),
  });
  for (const name of ["provider", "channel"]) {
    writeFileSync(join(catalogDir, `official-external-${name}-catalog.json`), '{"entries":[]}\n');
  }
  return root;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function registryState(tags: RegistryTags, dist?: Record<string, unknown>, versions = {}) {
  return { "dist-tags": tags, versions: { ...versions, ...(dist ? { "0.0.0": { dist } } : {}) } };
}

function responses(...states: Array<Record<string, unknown> | undefined>) {
  const queue = states.map(registryResponse);
  return async () => queue.shift() ?? registryResponse();
}

function registryResponse(packument?: Record<string, unknown>) {
  return new Response(packument === undefined ? "" : JSON.stringify(packument), {
    status: packument === undefined ? 404 : 200,
    headers: { "content-type": "application/json" },
  });
}

function identity(name: string) {
  const tarball = createPlaceholderTarball(name);
  return {
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    shasum: createHash("sha1").update(tarball).digest("hex"),
  };
}

function planPublication(
  options: Omit<Parameters<typeof createPlaceholderPublication>[0], "targetSha" | "workflowSha">,
) {
  return createPlaceholderPublication({ targetSha: SHA, workflowSha: WORKFLOW_SHA, ...options });
}

function publishArtifact(
  options: Omit<
    Parameters<typeof publishPlaceholders>[0],
    "npmToken" | "targetSha" | "workflowSha"
  >,
) {
  return publishPlaceholders({
    npmToken: "test-token",
    targetSha: SHA,
    workflowSha: WORKFLOW_SHA,
    fetchImpl: async () => registryResponse(),
    registryAttempts: 1,
    sleep: async () => undefined,
    ...options,
  });
}

async function artifact(name: string, packument?: Record<string, unknown>) {
  const repoRoot = createRepo([packageEntry("fixture", name)]);
  const outputDir = join(tempDirs.make("npm-placeholder-parent-"), "artifact");
  await planPublication({
    repoRoot,
    outputDir,
    packages: name,
    fetchImpl: async () => registryResponse(packument),
  });
  return outputDir;
}

function classify(name: string, packument: Record<string, unknown>) {
  const expected = identity(name);
  return classifyRegistryState({
    expectedIntegrity: expected.integrity,
    expectedShasum: expected.shasum,
    packageName: name,
    registry: { status: 200, packument },
  });
}

describe("npm placeholder publication", () => {
  it("preserves selected multi-package order and binds unique release-enabled manifests", async () => {
    const names = ["@openclaw/zoom-meetings", "@openclaw/comfy-provider"] as const;
    const root = createRepo([
      packageEntry("comfy", names[1]),
      packageEntry("zoom-meetings", names[0]),
    ]);
    const outputDir = join(tempDirs.make("npm-placeholder-output-parent-"), "publication");
    const manifest = await createPlaceholderPublication({
      repoRoot: root,
      outputDir,
      packages: names.join(","),
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => registryResponse(),
    });

    expect(manifest.packages.map((entry) => entry.packageName)).toEqual(names);
    expect(manifest.packages.map((entry) => entry.packageDir)).toEqual([
      "extensions/zoom-meetings",
      "extensions/comfy",
    ]);
    expect(manifest.packages.every((entry) => entry.action === "publish")).toBe(true);
    expect(manifest.packages.every((entry) => entry.newPackage)).toBe(true);
    expect(readFileSync(join(outputDir, "npm-placeholder-manifest.json"), "utf8")).toContain(
      `"targetSha": "${SHA}"`,
    );
  });

  it("creates deterministic canonical two-file placeholder tarballs", () => {
    const first = createPlaceholderTarball("@openclaw/comfy-provider");
    const second = createPlaceholderTarball("@openclaw/comfy-provider");

    expect(first).toEqual(second);
    expect(first.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("requires three stable registry observations during planning", async () => {
    const root = createRepo([packageEntry("comfy", packageName)]);

    await expect(
      planPublication({
        repoRoot: root,
        outputDir: join(tempDirs.make("npm-placeholder-unstable-parent-"), "publication"),
        packages: packageName,
        fetchImpl: responses(undefined, registryState({}), undefined),
      }),
    ).rejects.toThrow("npm registry state changed during placeholder planning");
  });

  it("rejects mismatched 0.0.0 bytes and conflicting placeholder tags", () => {
    expect(() =>
      classify(
        packageName,
        registryState(
          { placeholder: "0.0.0" },
          {
            integrity: "sha512-different",
            shasum: "different",
          },
        ),
      ),
    ).toThrow("npm registry tarball bytes differ");
    expect(() => classify(packageName, registryState({ placeholder: "1.2.3" }))).toThrow(
      "placeholder dist-tag points to 1.2.3",
    );
  });

  it("publishes serially and preserves every non-placeholder dist-tag", async () => {
    const names = ["@openclaw/byteplus-provider", "@openclaw/meta-provider"] as const;
    const root = createRepo([packageEntry("byteplus", names[0]), packageEntry("meta", names[1])]);
    const artifactDir = join(tempDirs.make("npm-placeholder-artifact-parent-"), "artifact");
    const tags = { latest: "2026.7.2", beta: "2026.7.2-beta.7" };
    const versions = { "2026.7.2": {} };
    const existingMeta = registryState(tags, undefined, versions);
    const manifest = await planPublication({
      repoRoot: root,
      outputDir: artifactDir,
      packages: names.join(","),
      fetchImpl: async (input) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes(encodeURIComponent(names[0]))
          ? registryResponse()
          : registryResponse(existingMeta),
    });
    expect(manifest.packages).toHaveLength(2);
    const calls: string[][] = [];
    const tempRoot = tempDirs.make("npm-placeholder-token-success-");
    const result = await publishArtifact({
      artifactDir,
      fetchImpl: responses(
        undefined,
        registryState({ placeholder: "0.0.0" }, identity(names[0])),
        existingMeta,
        registryState({ ...tags, placeholder: "0.0.0" }, identity(names[1]), versions),
      ),
      npmRunner: (args) => calls.push(args),
      tempRoot,
    });

    expect(calls.map(([command, tarball]) => [command, tarball && basename(tarball)])).toEqual(
      manifest.packages.map((entry) => ["publish", entry.tarball.name]),
    );
    expect(result.results.map((entry) => entry.packageName)).toEqual(names);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("rejects malicious package input, duplicate identity, and unsafe manifest paths", () => {
    expect(() => parseSelectedPackages("@openclaw/good,../../evil")).toThrow(
      "Invalid OpenClaw package name",
    );
    expect(() => parseSelectedPackages("@openclaw/good,@openclaw/good")).toThrow("duplicates");

    const duplicateRoot = createRepo([
      packageEntry("one", "@openclaw/good"),
      packageEntry("two", "@openclaw/good"),
    ]);
    expect(() => resolveSelectedPackageSources(duplicateRoot, ["@openclaw/good"])).toThrow(
      "must map uniquely",
    );

    const unsafeRoot = createRepo([packageEntry("good", "@openclaw/good")]);
    writeFileSync(join(unsafeRoot, "extensions", "good", "package.json"), "{}\n");
    expect(() => resolveSelectedPackageSources(unsafeRoot, ["@openclaw/good"])).toThrow(
      "must map uniquely",
    );

    const privateRoot = createRepo([
      packageEntry("private", "@openclaw/private", { publishConfig: { access: "private" } }),
    ]);
    expect(() => resolveSelectedPackageSources(privateRoot, ["@openclaw/private"])).toThrow(
      "not a public release-enabled npm plugin",
    );
  });

  it("fails final verification when any pre-existing dist-tag changes", () => {
    const expected = identity(packageName);
    expect(() =>
      assertFinalRegistryState(
        { packageName, preExistingDistTags: { latest: "2026.7.2" }, tarball: expected },
        {
          status: 200,
          packument: registryState({ latest: "2026.7.1", placeholder: "0.0.0" }, expected),
        },
      ),
    ).toThrow("non-placeholder dist-tag changed");
  });

  it("rejects manifest state combinations that could lie about registry creation", async () => {
    const artifactDir = await artifact(packageName);
    const manifestPath = join(artifactDir, "npm-placeholder-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.packages[0].action = "skip";
    writeJson(manifestPath, manifest);

    await expect(publishArtifact({ artifactDir })).rejects.toThrow(
      "dist-tag snapshot is not canonical",
    );
  });

  it("removes token-bearing npm config after mutation and readback failure", async () => {
    const artifactDir = await artifact(packageName);
    const tempRoot = tempDirs.make("npm-placeholder-token-failure-");

    await expect(
      publishArtifact({
        artifactDir,
        npmRunner: () => {
          throw new Error("ambiguous npm failure");
        },
        tempRoot,
      }),
    ).rejects.toThrow("mutation failed and exact registry readback did not converge");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("repairs a missing placeholder tag and accepts exact readback after an ambiguous error", async () => {
    const expected = identity(packageName);
    const before = registryState({ latest: "2026.7.2" }, expected);
    const artifactDir = await artifact(packageName, before);
    const calls: string[][] = [];
    const tempRoot = tempDirs.make("npm-placeholder-tag-token-");

    const result = await publishArtifact({
      artifactDir,
      fetchImpl: responses(
        before,
        registryState({ latest: "2026.7.2", placeholder: "0.0.0" }, expected),
      ),
      npmRunner: (args) => {
        calls.push(args);
        throw new Error("ambiguous npm failure");
      },
      tempRoot,
    });

    expect(calls).toEqual([["dist-tag", "add", `${packageName}@0.0.0`, "placeholder"]]);
    expect(result.results).toEqual([{ action: "tag", newPackage: false, packageName }]);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("preserves prototype-looking npm dist-tags as ordinary tag entries", () => {
    const expected = identity(packageName);
    const distTags = JSON.parse(
      '{"__proto__":"2026.7.1","latest":"2026.7.2","placeholder":"0.0.0"}',
    );

    expect(classify(packageName, registryState(distTags, expected))).toEqual({
      action: "skip",
      newPackage: false,
      nonPlaceholderTags: Object.fromEntries([
        ["__proto__", "2026.7.1"],
        ["latest", "2026.7.2"],
      ]),
    });
  });

  it("keeps npm credentials isolated to the protected serial publish step", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs?: Record<string, Job>;
    };
    const { plan, verify, publish } = workflow.jobs ?? {};
    expect(workflow.concurrency).toEqual({
      group: "npm-placeholder-release",
      "cancel-in-progress": false,
    });
    for (const job of [plan, verify]) {
      expect(job?.environment).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("NPM_TOKEN");
    }
    expect(step(verify, "Verify immutable placeholder publication")).toBeDefined();
    expect(publish).toMatchObject({
      environment: "npm-release",
      permissions: { actions: "read", contents: "read", "id-token": "write" },
    });
    const publishStep = step(publish, "Publish verified placeholders serially");
    expect(publishStep?.env?.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(readFileSync("scripts/npm-placeholder-publication.mjs", "utf8")).toContain(
      '"--provenance"',
    );
    expect(publishStep?.run).not.toContain("npm trust");
    expect(readFileSync(WORKFLOW, "utf8")).toContain("plugin-npm-release.yml");
    const digestStep = step(plan, "Bind immutable artifact digest");
    expect(digestStep?.env?.RAW_DIGEST).toBe("${{ steps.upload.outputs.artifact-digest }}");
    expect(digestStep?.run).toContain("digest=sha256:${RAW_DIGEST}");
    for (const job of [verify, publish]) {
      expect(step(job, "Resolve immutable artifact metadata")?.run).toContain(".digest == $digest");
    }
  });

  it("binds the artifact name to the exact workflow run and producer attempt", async () => {
    await expect(
      verifyPlaceholderArtifact({
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: 1,
        artifactName: "npm-placeholder-publication-123-2",
        artifactSizeBytes: 1,
        consumerRunAttempt: 1,
        outputDir: "/tmp/unused",
        producerRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: 123,
        targetRoot: "/tmp/unused",
        targetSha: SHA,
        token: "test-token",
        workflowSha: WORKFLOW_SHA,
      }),
    ).rejects.toThrow("artifact name does not match its workflow run and attempt");
  });
});
