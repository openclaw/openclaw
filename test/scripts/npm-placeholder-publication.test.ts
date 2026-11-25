import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
import { writeJsonFile as writeJson } from "../helpers/temp-repo.js";

const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const binding = { targetSha: SHA, workflowSha: WORKFLOW_SHA };
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
    writeJson(join(dir, "package.json"), entry.manifest);
  }
  const catalogDir = join(root, "scripts", "lib");
  writeJson(join(catalogDir, "official-external-plugin-catalog.json"), {
    entries: packages.map(({ manifest: { name } }) => ({
      name,
      source: "official",
      openclaw: { install: { npmSpec: name } },
    })),
  });
  for (const name of ["provider", "channel"]) {
    writeJson(join(catalogDir, `official-external-${name}-catalog.json`), { entries: [] });
  }
  return root;
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

async function publication(
  entries = [packageEntry("fixture", packageName)],
  fetchImpl: typeof fetch = async () => registryResponse(),
  packages = entries.map(({ manifest }) => manifest.name).join(","),
) {
  const artifactDir = join(tempDirs.make("npm-placeholder-parent-"), "artifact");
  const manifest = await createPlaceholderPublication({
    ...binding,
    repoRoot: createRepo(entries),
    outputDir: artifactDir,
    packages,
    fetchImpl,
  });
  const publish = (
    options: Pick<
      Parameters<typeof publishPlaceholders>[0],
      "fetchImpl" | "npmRunner" | "tempRoot"
    > = {},
  ) =>
    publishPlaceholders({
      ...binding,
      artifactDir,
      npmToken: "test-token",
      fetchImpl: async () => registryResponse(),
      registryAttempts: 1,
      sleep: async () => undefined,
      ...options,
    });
  return { artifactDir, manifest, publish };
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
  it("creates deterministic canonical two-file placeholder tarballs", () => {
    const first = createPlaceholderTarball(packageName);
    expect(first).toEqual(createPlaceholderTarball(packageName));
    expect(first.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("requires three stable registry observations during planning", async () => {
    await expect(
      publication(undefined, responses(undefined, registryState({}), undefined)),
    ).rejects.toThrow("npm registry state changed during placeholder planning");
  });

  it("rejects mismatched 0.0.0 bytes and conflicting placeholder tags", () => {
    expect(() =>
      classify(
        packageName,
        registryState(
          { placeholder: "0.0.0" },
          { integrity: "sha512-different", shasum: "different" },
        ),
      ),
    ).toThrow("npm registry tarball bytes differ");
    expect(() => classify(packageName, registryState({ placeholder: "1.2.3" }))).toThrow(
      "placeholder dist-tag points to 1.2.3",
    );
  });

  it("publishes serially and preserves every non-placeholder dist-tag", async () => {
    const names = ["@openclaw/byteplus-provider", "@openclaw/meta-provider"] as const;
    const tags = { latest: "2026.7.2", beta: "2026.7.2-beta.7" };
    const versions = { "2026.7.2": {} };
    const existingMeta = registryState(tags, undefined, versions);
    const { manifest, publish } = await publication(
      [packageEntry("meta", names[1]), packageEntry("byteplus", names[0])],
      async (input) =>
        (typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).includes(encodeURIComponent(names[0]))
          ? registryResponse()
          : registryResponse(existingMeta),
      names.join(","),
    );
    expect(manifest.targetSha).toBe(SHA);
    expect(manifest.packages.map((entry) => [entry.packageName, entry.packageDir])).toEqual([
      [names[0], "extensions/byteplus"],
      [names[1], "extensions/meta"],
    ]);
    const calls: string[][] = [];
    const tempRoot = tempDirs.make("npm-placeholder-token-success-");
    const result = await publish({
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
    for (const args of calls) {
      expect(args).toContain("--provenance");
    }
    expect(result.results.map((entry) => entry.packageName)).toEqual(names);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("rejects malicious package input, duplicate identity, and unsafe manifest paths", () => {
    expect(() => parseSelectedPackages("@openclaw/good,../../evil")).toThrow(
      "Invalid OpenClaw package name",
    );
    expect(() => parseSelectedPackages("@openclaw/good,@openclaw/good")).toThrow("duplicates");

    for (const [entries, error] of [
      [[packageEntry("one", packageName), packageEntry("two", packageName)], "must map uniquely"],
      [[{ dir: "missing", manifest: {} }], "must map uniquely"],
      [
        [packageEntry("private", packageName, { publishConfig: { access: "private" } })],
        "not a public release-enabled npm plugin",
      ],
    ] as const) {
      expect(() => resolveSelectedPackageSources(createRepo([...entries]), [packageName])).toThrow(
        error,
      );
    }
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
    const { artifactDir, manifest, publish } = await publication();
    const manifestPath = join(artifactDir, "npm-placeholder-manifest.json");
    manifest.packages[0].action = "skip";
    writeJson(manifestPath, manifest);

    await expect(publish()).rejects.toThrow("dist-tag snapshot is not canonical");
  });

  it.each([false, true])(
    "cleans credentials after ambiguous mutation (exact readback=%s)",
    async (converges) => {
      const expected = identity(packageName);
      const before = registryState({ latest: "2026.7.2" }, expected);
      const { publish } = await publication(undefined, async () =>
        registryResponse(converges ? before : undefined),
      );
      const calls: string[][] = [];
      const tempRoot = tempDirs.make("npm-placeholder-token-");
      const result = publish({
        fetchImpl: converges
          ? responses(before, registryState({ latest: "2026.7.2", placeholder: "0.0.0" }, expected))
          : responses(),
        npmRunner: (args) => {
          calls.push(args);
          throw new Error("ambiguous npm failure");
        },
        tempRoot,
      });

      if (converges) {
        const published = await result;
        expect(calls).toEqual([["dist-tag", "add", `${packageName}@0.0.0`, "placeholder"]]);
        expect(published.results).toEqual([{ action: "tag", newPackage: false, packageName }]);
      } else {
        await expect(result).rejects.toThrow(
          "mutation failed and exact registry readback did not converge",
        );
      }
      expect(readdirSync(tempRoot)).toEqual([]);
    },
  );

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
    expect(publish).toMatchObject({
      environment: "npm-release",
      permissions: { actions: "read", contents: "read", "id-token": "write" },
    });
    const publishStep = step(publish, "Publish verified placeholders serially");
    expect(publishStep?.env?.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
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
        ...binding,
        token: "test-token",
      }),
    ).rejects.toThrow("artifact name does not match its workflow run and attempt");
  });
});
