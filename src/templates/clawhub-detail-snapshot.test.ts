import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { readClawHubTemplateDetail } from "./clawhub-source.js";

const mock = vi.hoisted(() => ({ detail: vi.fn(), release: vi.fn(), archive: vi.fn() }));
// mock-isolation: The catalog reads a fixed public release without network access.
vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: mock.detail,
  fetchClawHubPackageVersion: mock.release,
  fetchClawHubPackageSecurity: async () => {
    throw new Error("No audit available");
  },
}));
// mock-isolation: The fixture stands in for the immutable download.
vi.mock("../infra/clawhub-artifacts.js", () => ({ downloadClawHubPackageArchive: mock.archive }));
// mock-isolation: Fixture extraction returns a private, test-owned source directory.
vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: async ({
    onExtracted,
  }: {
    onExtracted: (rootDir: string) => unknown;
  }) => await onExtracted(fixtureRoot),
}));
// mock-isolation: Remove a fixture file after real verification to detect a second open.
vi.mock("./reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reader.js")>();
  return {
    ...actual,
    async readTemplateManifestFile(...args: Parameters<typeof actual.readTemplateManifestFile>) {
      const verified = await actual.readTemplateManifestFile(...args);
      await fs.unlink(path.join(args[0], "SOUL.md"));
      return verified;
    },
  };
});

const dirs = createTrackedTempDirs();
let fixtureRoot: string;
afterEach(async () => await dirs.cleanup());

it("projects the personality excerpt from verified bytes without reopening SOUL.md", async () => {
  const packageName = "@example/research-briefing";
  const version = "1.0.0";
  const pkg = {
    name: packageName,
    displayName: "Research Briefing",
    family: "template",
    channel: "community",
    isOfficial: false,
    latestVersion: version,
    updatedAt: 1,
  };
  mock.detail.mockResolvedValue({ package: pkg, owner: { handle: "example" } });
  fixtureRoot = await dirs.make("clawhub-detail-snapshot-");
  const archivePath = path.join(fixtureRoot, "fixture.tgz");
  const archive = Buffer.from("fixture archive bytes");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const npmIntegrity = "sha512-fixture";
  mock.archive.mockResolvedValue({
    archivePath,
    artifact: "clawpack",
    sha256Hex: sha256,
    npmIntegrity,
    cleanup: async () => {},
  });
  mock.release.mockResolvedValue({
    package: pkg,
    version: {
      version,
      artifact: { kind: "npm-pack", sha256, npmIntegrity },
      templateManifestSummary: {
        schemaVersion: 1,
        agent: { id: "research-briefing" },
        workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 0 },
        packages: { skillCount: 0, pluginCount: 0 },
        mcpServerCount: 0,
        cronJobCount: 0,
      },
    },
  });
  await Promise.all([
    fs.writeFile(archivePath, archive),
    fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ name: packageName, version, openclaw: { template: "CLAW.md" } }),
    ),
    fs.writeFile(
      path.join(fixtureRoot, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: research-briefing }\nworkspace:\n  bootstrapFiles:\n    SOUL.md: { source: SOUL.md }\n---\n",
    ),
    fs.writeFile(path.join(fixtureRoot, "SOUL.md"), "# Research brief\n"),
  ]);

  const detail = await readClawHubTemplateDetail({ packageName, version });
  expect(detail.contents.instructions).toEqual([
    { name: "SOUL.md", source: "SOUL.md", excerpt: "Research brief" },
  ]);
});
