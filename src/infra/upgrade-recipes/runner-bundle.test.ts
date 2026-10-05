import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeUpgradeRecipeRunnerBundle } from "../../../scripts/compose-upgrade-runner-bundle.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { verifyRecipeUpdateRunner } from "../../cli/update-cli/update-recipe-context.js";
import { approvedContext } from "../../cli/update-cli/update-recipe-context.test-support.js";
import type { AuthenticatedUpgradeRecipeCatalog } from "./catalog.js";
import {
  verifyUpgradeRecipeRunnerBundle,
  type UpgradeRecipeRunnerBundleManifest,
} from "./runner-bundle.js";

// These are closure-owner unit tests; catalog.test.ts separately exercises real TUF verification.
const trust = vi.hoisted(() => ({ assertCurrent: vi.fn() }));
vi.mock("./catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./catalog.js")>()),
  assertUpgradeRecipeCatalogCurrent: trust.assertCurrent,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => trust.assertCurrent.mockReset());
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const base = dirs.make("upgrade-runner-");
  const root = path.join(base, "retained");
  await fs.mkdir(root, { mode: 0o700 });
  const files: UpgradeRecipeRunnerBundleManifest["files"] = [];
  for (const [name, role, executable] of [
    ["node", "runtime", true],
    ["updater.mjs", "runner", false],
    ["sqlite.node", "native-dependency", false],
  ] as const) {
    const bytes = Buffer.from(`inert fixture ${name}; must never execute during verification`);
    await fs.writeFile(path.join(root, name), bytes, { mode: executable ? 0o700 : 0o600 });
    files.push({
      path: name,
      artifactId: name.replace(".", "-"),
      sha256: hash(bytes),
      length: bytes.length,
      role,
      executable,
    });
  }
  const manifest: UpgradeRecipeRunnerBundleManifest = {
    schemaVersion: 1,
    protocol: 1,
    platform: { os: "linux", arch: "x64" },
    runtime: { path: "node", kind: "node", version: "24.21.0" },
    entrypoint: "updater.mjs",
    bootstrapArtifactId: "bootstrap",
    externalModules: [],
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "runner-manifest.json"), manifestBytes, { mode: 0o600 });
  const catalog: AuthenticatedUpgradeRecipeCatalog = {
    catalog: {
      schemaVersion: 1,
      id: "fixture",
      artifacts: [
        { id: "bootstrap", sha256: "f".repeat(64), length: 10 },
        { id: "manifest", sha256: hash(manifestBytes), length: manifestBytes.length },
        ...files.map((file) => ({ id: file.artifactId, sha256: file.sha256, length: file.length })),
      ],
      releases: [],
      recipes: [],
      adapters: [],
      qualifications: [],
    },
    digest: "a".repeat(64),
    revokedRecipes: [],
    revokedArtifactIds: [],
    admission: {
      targetPath: "catalog.json",
      sha256: "a".repeat(64),
      length: 100,
      rootSha256: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      metadataVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
      metadataDigests: {
        root: "b".repeat(64),
        timestamp: "c".repeat(64),
        snapshot: "d".repeat(64),
        targets: "e".repeat(64),
      },
    },
  };
  const platform: { os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64" } = {
    os: "linux",
    arch: "x64",
  };
  return {
    root,
    catalog,
    manifest,
    options: {
      catalog,
      bundleRoot: root,
      manifestArtifactId: "manifest",
      platform,
      forbiddenRoots: [path.join(base, "installation"), path.join(base, "workspace")],
    },
  };
}
describe("retained upgrade runner closure verification", () => {
  it("composes an exact offline bundle without executing release inputs", async () => {
    const f = await fixture();
    const output = path.join(path.dirname(f.root), "composed");
    const result = await composeUpgradeRecipeRunnerBundle({
      outputDirectory: output,
      manifest: {
        schemaVersion: f.manifest.schemaVersion,
        protocol: f.manifest.protocol,
        platform: f.manifest.platform,
        runtime: f.manifest.runtime,
        entrypoint: f.manifest.entrypoint,
        bootstrapArtifactId: f.manifest.bootstrapArtifactId,
        externalModules: f.manifest.externalModules,
      },
      files: f.manifest.files.map((file) =>
        Object.assign({}, file, { source: path.join(f.root, file.path) }),
      ),
    });
    const manifestArtifact = f.catalog.catalog.artifacts.find((entry) => entry.id === "manifest");
    if (!manifestArtifact) {
      throw new Error("Missing manifest fixture");
    }
    manifestArtifact.sha256 = result.manifestSha256;
    manifestArtifact.length = result.manifestLength;
    const verified = await verifyUpgradeRecipeRunnerBundle({ ...f.options, bundleRoot: output });
    expect(verified.closureDigest).toBe(result.closureDigest);
    await expect(
      composeUpgradeRecipeRunnerBundle({
        outputDirectory: output,
        manifest: {
          schemaVersion: f.manifest.schemaVersion,
          protocol: f.manifest.protocol,
          platform: f.manifest.platform,
          runtime: f.manifest.runtime,
          entrypoint: f.manifest.entrypoint,
          bootstrapArtifactId: f.manifest.bootstrapArtifactId,
          externalModules: f.manifest.externalModules,
        },
        files: f.manifest.files.map((file) =>
          Object.assign({}, file, { source: path.join(f.root, file.path) }),
        ),
      }),
    ).rejects.toThrow();
  });
  it("verifies exact runtime/runner/native bytes without executing them", async () => {
    const f = await fixture();
    const result = await verifyUpgradeRecipeRunnerBundle(f.options);
    expect(result.runtimePath).toBe(path.join(f.root, "node"));
    expect(result.entrypointPath).toBe(path.join(f.root, "updater.mjs"));
    expect(result.nativeDependencies).toEqual(["sqlite.node"]);
    expect(result.closureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(trust.assertCurrent).toHaveBeenCalledTimes(3);
  });
  it.each([
    "changed",
    "missing",
    "extra",
    "symlink",
    "permissions",
    "runtime-mode",
    "wrong-platform",
    "forbidden-root",
  ])("rejects mismatched closure: %s", async (kind) => {
    const f = await fixture();
    const runtime = path.join(f.root, "node");
    if (kind === "changed") {
      await fs.writeFile(runtime, "changed bytes");
    }
    if (kind === "missing") {
      await fs.unlink(runtime);
    }
    if (kind === "extra") {
      await fs.writeFile(path.join(f.root, "undeclared.mjs"), "extra", { mode: 0o600 });
    }
    if (kind === "symlink") {
      await fs.rename(runtime, path.join(f.root, "outside"));
      await fs.symlink(path.join(f.root, "outside"), runtime);
    }
    if (kind === "permissions") {
      await fs.chmod(runtime, 0o777);
    }
    if (kind === "runtime-mode") {
      await fs.chmod(runtime, 0o600);
    }
    if (kind === "wrong-platform") {
      f.options.platform = { os: "linux", arch: "arm64" };
    }
    if (kind === "forbidden-root") {
      f.options.forbiddenRoots.push(f.root);
    }
    await expect(verifyUpgradeRecipeRunnerBundle(f.options)).rejects.toThrow();
  });
  it("does not accept matching local hashes absent authenticated manifest admission", async () => {
    const f = await fixture();
    trust.assertCurrent.mockImplementationOnce(() => {
      throw new Error("metadata-untrusted");
    });
    await expect(verifyUpgradeRecipeRunnerBundle(f.options)).rejects.toThrow("metadata-untrusted");
  });
  it("refuses changed authenticated dependency identities", async () => {
    const f = await fixture();
    const artifact = f.catalog.catalog.artifacts.find((entry) => entry.id === "node");
    if (!artifact) {
      throw new Error("Missing fixture artifact");
    }
    artifact.sha256 = "f".repeat(64);
    await expect(verifyUpgradeRecipeRunnerBundle(f.options)).rejects.toThrow(
      /authenticated artifact identities/,
    );
  });
});

// The real bundle verifier observes disk bytes; only TUF admission is isolated above.
it("rejects a catalog-valid selected runner not covered by the original qualification", async () => {
  const input = await fixture();
  const verified = await verifyUpgradeRecipeRunnerBundle(input.options);
  const recipe = approvedContext();
  recipe.runner = {
    root: input.root,
    manifestArtifactId: "manifest",
    manifestDigest: verified.manifestDigest,
    closureDigest: verified.closureDigest,
  };
  recipe.catalog.forbiddenRoots = input.options.forbiddenRoots;
  recipe.maintenance.expected.runtimeExecutable = verified.runtimePath;
  recipe.route.qualificationId = "qualified-a";
  const executor = {
    runnerManifestArtifactId: "manifest",
    runtimeArtifactId: "node",
    bootstrapArtifactId: "bootstrap",
  };
  input.catalog.catalog.qualifications = [
    {
      id: "qualified-a",
      recipe: recipe.route.recipe,
      sourceReleaseId: "source",
      targetReleaseId: "target",
      installKind: "npm",
      platform:
        input.options.platform.os === "linux"
          ? { os: "linux", arch: "x64", serviceMode: "systemd" }
          : recipe.route.platform,
      runtimeFamily: "node",
      stateContractClass: "state",
      evidenceArtifactId: "evidence",
      executor,
    },
  ];
  await expect(verifyRecipeUpdateRunner(recipe, input.catalog)).resolves.toEqual(verified);
  for (const field of [
    "runnerManifestArtifactId",
    "runtimeArtifactId",
    "bootstrapArtifactId",
  ] as const) {
    const original = executor[field];
    const artifact = input.catalog.catalog.artifacts.find((item) => item.id === original)!;
    input.catalog.catalog.artifacts.push({ ...artifact, id: `${original}-other` });
    executor[field] = `${original}-other`;
    await expect(verifyRecipeUpdateRunner(recipe, input.catalog)).rejects.toThrow(
      /differs from the approved/,
    );
    executor[field] = original;
  }
});
