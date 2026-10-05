import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthenticatedUpgradeRecipeCatalog } from "./catalog.js";
import { verifyAuthenticatedUpgradeInstallation } from "./installation-identity.js";

// File-closure proof only. Real signature/expiry admission is covered by catalog.test.ts.
vi.mock("./catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./catalog.js")>()),
  assertUpgradeRecipeCatalogCurrent: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "upgrade-source-identity-"));
  roots.push(home);
  const root = path.join(home, "installation");
  const artifactsDirectory = path.join(home, "artifacts");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(artifactsDirectory, { mode: 0o700 });
  const bytes = Buffer.from('{"name":"openclaw","version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, "package.json"), bytes, { mode: 0o644 });
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      releaseId: "source",
      buildId: "source-build",
      packageArtifactId: "source-package",
      directories: [],
      files: [
        {
          path: "package.json",
          kind: "file",
          length: bytes.length,
          sha256: hash(bytes),
          mode: 0o644,
        },
      ],
    }),
  );
  await fs.writeFile(path.join(artifactsDirectory, "source-manifest"), manifest, { mode: 0o600 });
  const catalog: AuthenticatedUpgradeRecipeCatalog = {
    catalog: {
      schemaVersion: 1,
      id: "fixture",
      artifacts: [{ id: "source-manifest", sha256: hash(manifest), length: manifest.length }],
      releases: [
        {
          id: "source",
          version: "1.0.0",
          buildId: "source-build",
          commit: "a".repeat(40),
          artifactId: "source-package",
          installationManifestArtifactId: "source-manifest",
          runtimeFamily: "node",
          stateContracts: { state: 0, agent: 0 },
        },
      ],
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
      length: 1,
      rootSha256: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      metadataVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
      metadataDigests: { root: "a", timestamp: "b", snapshot: "c", targets: "d" },
    },
  };
  return { catalog, root, releaseId: "source", artifactsDirectory, forbiddenRoots: [root] };
}

it("binds all installed bytes without executing the inspected application", async () => {
  const input = await fixture();
  expect(await verifyAuthenticatedUpgradeInstallation(input)).toMatchObject({
    releaseId: "source",
    buildId: "source-build",
    fileCount: 1,
  });
});

it("refuses a version-only identity and a tampered manifest", async () => {
  const input = await fixture();
  const release = input.catalog.catalog.releases[0];
  if (!release) {
    throw new Error("Missing fixture release");
  }
  delete release.installationManifestArtifactId;
  await expect(verifyAuthenticatedUpgradeInstallation(input)).rejects.toThrow(
    "authenticated installed-file manifest",
  );
  release.installationManifestArtifactId = "source-manifest";
  await fs.appendFile(path.join(input.artifactsDirectory, "source-manifest"), " ");
  await expect(verifyAuthenticatedUpgradeInstallation(input)).rejects.toThrow("identity differs");
});

it("preserves changed and undeclared local content instead of treating it as a known release", async () => {
  const input = await fixture();
  const extra = path.join(input.root, "local-plugin.js");
  await fs.writeFile(extra, "local authored code");
  await expect(verifyAuthenticatedUpgradeInstallation(input)).rejects.toThrow("undeclared file");
  expect(await fs.readFile(extra, "utf8")).toBe("local authored code");
  await fs.rm(extra);
  const original = path.join(input.root, "package.json");
  const bytes = await fs.readFile(original);
  bytes[1] = "x".charCodeAt(0);
  await fs.writeFile(original, bytes);
  await expect(verifyAuthenticatedUpgradeInstallation(input)).rejects.toThrow(
    "digest or filesystem identity",
  );
  expect(await fs.readFile(original)).toEqual(bytes);
});

it("refuses symlink substitution and an artifact cache inside the replaced installation", async () => {
  const input = await fixture();
  await expect(
    verifyAuthenticatedUpgradeInstallation({ ...input, artifactsDirectory: input.root }),
  ).rejects.toThrow("external artifact storage");
  const source = path.join(input.root, "package.json");
  const elsewhere = path.join(path.dirname(input.root), "borrowed.json");
  await fs.rename(source, elsewhere);
  await fs.symlink(elsewhere, source);
  await expect(verifyAuthenticatedUpgradeInstallation(input)).rejects.toThrow("file type differs");
  expect((await fs.lstat(source)).isSymbolicLink()).toBe(true);
});
