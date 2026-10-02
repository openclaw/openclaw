import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  detail: vi.fn(),
  version: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  trust: vi.fn(),
  extract: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../infra/clawhub-packages.js", () => ({
  listClawHubPackages: mocks.list,
  searchClawHubPackages: mocks.search,
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageVersion: mocks.version,
  fetchClawHubPackageArtifact: mocks.artifact,
}));
vi.mock("../infra/clawhub-artifacts.js", () => ({
  downloadClawHubPackageArchive: mocks.download,
}));
vi.mock("../infra/clawhub-install-trust.js", () => ({
  checkClawHubPackageTrust: mocks.trust,
}));
vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: mocks.extract,
}));
vi.mock("./reader.js", () => ({
  readClawManifestFile: mocks.read,
}));

import {
  listClawHubClaws,
  readClawHubClawDetail,
  searchClawHubClaws,
  withResolvedClawHubSource,
} from "./clawhub-source.js";

const packageName = "@openclaw/research-briefing";
const version = "1.0.0";
const digest = "a".repeat(64);
const tempDirs = createTrackedTempDirs();

function officialPackage(name = packageName) {
  return {
    name,
    displayName: "Research Briefing",
    family: "claw",
    channel: "official",
    isOfficial: true,
    ownerHandle: "openclaw",
    summary: "Researches a topic and produces a briefing.",
    createdAt: 1,
    updatedAt: 2,
    latestVersion: version,
    stats: { downloads: 12 },
  };
}

const summary = {
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
  workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
  packages: { skillCount: 2, pluginCount: 0 },
  mcpServerCount: 1,
  cronJobCount: 0,
};

async function prepareResolverFixture() {
  const temp = await tempDirs.make("openclaw-clawhub-claw-");
  const extractedRoot = path.join(temp, "extracted");
  const archivePath = path.join(temp, "claw.tgz");
  const stateDir = path.join(temp, "state");
  await fs.mkdir(extractedRoot);
  await fs.writeFile(path.join(extractedRoot, "package.json"), "{}\n");
  await fs.writeFile(archivePath, Buffer.alloc(321));
  mocks.download.mockResolvedValue({
    archivePath,
    artifact: "clawpack",
    sha256Hex: digest,
    npmIntegrity: "sha512-proof",
    cleanup: vi.fn(),
  });
  mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted(extractedRoot));
  mocks.read.mockImplementation(async (root: string) => ({
    ok: true,
    manifest: {},
    source: {
      kind: "package",
      name: packageName,
      version,
      packageRoot: root,
      manifestPath: path.join(root, "CLAW.md"),
      integrityKind: "development-snapshot",
      integrity: "sha256:development",
      byteLength: 1,
    },
    diagnostics: [],
  }));
  return { stateDir, extractedRoot };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detail.mockResolvedValue({
    package: { ...officialPackage(), ownerHandle: undefined, clawManifestSummary: summary },
    owner: { handle: "openclaw" },
  });
  mocks.version.mockResolvedValue({
    package: { name: packageName, displayName: "Research Briefing", family: "claw" },
    version: { version, createdAt: 2, changelog: "", clawManifestSummary: summary },
  });
  mocks.artifact.mockResolvedValue({
    package: { name: packageName, family: "claw" },
    version,
    artifact: {
      kind: "npm-pack",
      sha256: digest,
      npmIntegrity: "sha512-proof",
    },
  });
  mocks.trust.mockResolvedValue({
    ok: true,
    trustInstallRecordFields: {
      clawhubTrustDisposition: "clean",
      clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
    },
  });
});

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("official ClawHub Claw catalog", () => {
  it("loads all 30 official starters across paginated list responses", async () => {
    const first = Array.from({ length: 25 }, (_, index) =>
      officialPackage(`@openclaw/starter-${index}`),
    );
    const second = Array.from({ length: 5 }, (_, index) =>
      officialPackage(`@openclaw/starter-${index + 25}`),
    );
    mocks.list
      .mockResolvedValueOnce({
        items: [...first, officialPackage("@other/impostor")],
        nextCursor: "page 2",
      })
      .mockResolvedValueOnce({ items: second, nextCursor: null });

    const result = await listClawHubClaws();

    expect(result).toHaveLength(30);
    expect(result[0]).toMatchObject({ packageName: "@openclaw/starter-0", official: true });
    expect(result.at(-1)?.packageName).toBe("@openclaw/starter-29");
    expect(mocks.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ family: "claw", isOfficial: true, limit: 100 }),
    );
    expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page 2" }));
  });

  it("uses list for a blank query and filters typed search to the official publisher", async () => {
    mocks.list.mockResolvedValue({ items: [officialPackage()], nextCursor: null });
    await expect(searchClawHubClaws({ query: "  " })).resolves.toHaveLength(1);
    expect(mocks.search).not.toHaveBeenCalled();

    mocks.search.mockResolvedValue([
      { score: 1, package: officialPackage() },
      { score: 1, package: officialPackage("@other/impostor") },
      { score: 1, package: { ...officialPackage(), ownerHandle: "someone-else" } },
      { score: 1, package: { ...officialPackage(), name: 42 } },
    ]);
    const result = await searchClawHubClaws({ query: "research" });
    expect(result.map((item) => item.packageName)).toEqual([packageName]);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "research", family: "claw", isOfficial: true, limit: 100 }),
    );
  });

  it("finds an official match when community matches fill the search cap", async () => {
    mocks.search.mockImplementation(async ({ isOfficial, limit }) =>
      isOfficial
        ? [{ score: 1, package: officialPackage() }]
        : Array.from({ length: limit }, (_, index) => ({
            score: 1,
            package: { ...officialPackage(`@community/result-${index}`), isOfficial: false },
          })),
    );

    await expect(searchClawHubClaws({ query: "research", limit: 1 })).resolves.toMatchObject([
      { packageName },
    ]);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "research", family: "claw", isOfficial: true, limit: 1 }),
    );
  });

  it("projects the exact validated release summary without downloading an archive", async () => {
    await expect(readClawHubClawDetail({ packageName })).resolves.toMatchObject({
      packageName,
      version,
      agentName: "Research Briefing",
      workspaceFiles: 2,
      skills: 2,
      plugins: 0,
      mcpServers: 1,
      scheduledJobs: 0,
    });
    expect(mocks.version).toHaveBeenCalledWith(
      expect.objectContaining({ name: packageName, version }),
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("does not substitute the latest package summary for a missing exact-release summary", async () => {
    mocks.version.mockResolvedValue({
      package: { name: packageName, displayName: "Research Briefing", family: "claw" },
      version: { version, createdAt: 2, changelog: "", clawManifestSummary: null },
    });

    await expect(readClawHubClawDetail({ packageName })).rejects.toMatchObject({
      code: "clawhub_manifest_summary_missing",
    });
  });

  it("accepts an exact release with build metadata without borrowing the latest scan status", async () => {
    const selectedVersion = "0.9.0+build.1";
    mocks.detail.mockResolvedValue({
      package: { ...officialPackage(), ownerHandle: undefined, scanStatus: "clean" },
      owner: { handle: "openclaw" },
    });
    mocks.version.mockResolvedValue({
      package: { name: packageName, family: "claw" },
      version: {
        version: selectedVersion,
        createdAt: 1,
        changelog: "",
        clawManifestSummary: summary,
      },
    });

    const detail = await readClawHubClawDetail({ packageName, version: selectedVersion });
    expect(detail.version).toBe(selectedVersion);
    expect(detail).not.toHaveProperty("scanStatus");
  });

  it("refuses a non-official coordinate or forged publisher before resolving detail", async () => {
    await expect(readClawHubClawDetail({ packageName: "@other/impostor" })).rejects.toThrow(
      /official OpenClaw/,
    );
    expect(mocks.detail).not.toHaveBeenCalled();

    mocks.detail.mockResolvedValue({
      package: { ...officialPackage(), ownerHandle: "someone-else" },
      owner: { handle: "someone-else" },
    });
    await expect(readClawHubClawDetail({ packageName })).rejects.toThrow(/identity/);
  });

  it("rejects repeating pagination cursors rather than silently hiding starters", async () => {
    mocks.list.mockResolvedValue({ items: [officialPackage()], nextCursor: "loop" });
    await expect(listClawHubClaws()).rejects.toThrow(/cursor/);
  });
});

describe("verified ClawHub Claw source", () => {
  it("keeps preview ephemeral and persists only after an approved apply asks for it", async () => {
    const { stateDir } = await prepareResolverFixture();
    const preview = await withResolvedClawHubSource({
      coordinate: { packageName, version },
      mode: "preview",
      stateDir,
      run: async (source, _trust, persistSource) => {
        await expect(persistSource()).rejects.toThrow(/preview/);
        return source.source;
      },
    });
    expect(preview.value.integrity).toBe(`sha256:${digest}`);
    expect(preview.value.byteLength).toBe(321);
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });

    const apply = await withResolvedClawHubSource({
      coordinate: { packageName, version },
      mode: "apply",
      stateDir,
      run: async (_source, _trust, persistSource) => (await persistSource()).source,
    });
    expect(apply.value.integrity).toBe(preview.value.integrity);
    expect(apply.value.byteLength).toBe(preview.value.byteLength);
    expect(apply.value.packageRoot).toBe(path.join(stateDir, "claws", "sources", digest));
    await expect(
      fs.readFile(path.join(apply.value.packageRoot, "package.json"), "utf8"),
    ).resolves.toBe("{}\n");
  });

  it("reuses an identical source when two applies promote the same digest concurrently", async () => {
    const { stateDir } = await prepareResolverFixture();
    const install = () =>
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "apply",
        stateDir,
        run: async (_source, _trust, persistSource) => (await persistSource()).source.packageRoot,
      });

    const [first, second] = await Promise.all([install(), install()]);
    expect(first.value).toBe(path.join(stateDir, "claws", "sources", digest));
    expect(second.value).toBe(first.value);
  });

  it("refuses to reuse a corrupted source at an existing digest path", async () => {
    const { stateDir } = await prepareResolverFixture();
    const install = () =>
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "apply",
        stateDir,
        run: async (_source, _trust, persistSource) => (await persistSource()).source.packageRoot,
      });
    const first = await install();
    await fs.writeFile(path.join(first.value, "package.json"), "corrupted\n");

    await expect(install()).rejects.toMatchObject({ code: "clawhub_cached_source_mismatch" });
    await expect(fs.readFile(path.join(first.value, "package.json"), "utf8")).resolves.toBe(
      "corrupted\n",
    );
  });

  it("binds artifact identity, resolver digest, and downloaded bytes before extraction", async () => {
    await prepareResolverFixture();
    mocks.artifact.mockResolvedValueOnce({
      package: { name: "@openclaw/other-claw", family: "claw" },
      version,
      artifact: {
        kind: "npm-pack",
        sha256: digest,
        npmIntegrity: "sha512-proof",
      },
    });
    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "preview",
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "clawhub_identity_mismatch" });
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.download.mockResolvedValueOnce({
      archivePath: "/tmp/wrong.tgz",
      artifact: "clawpack",
      sha256Hex: "b".repeat(64),
      npmIntegrity: "sha512-proof",
      cleanup: vi.fn(),
    });
    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "preview",
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "clawhub_artifact_integrity_mismatch" });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("requires a fresh risk acknowledgement on apply and never persists denied content", async () => {
    const { stateDir } = await prepareResolverFixture();
    mocks.trust.mockResolvedValue({
      ok: true,
      warning: "Security review required.",
      trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
    });

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "preview",
        stateDir,
        run: async () => undefined,
      }),
    ).resolves.toMatchObject({ riskAcknowledgementRequired: true });
    mocks.download.mockClear();

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "apply",
        stateDir,
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "clawhub_risk_acknowledgement_required" });
    expect(mocks.download).not.toHaveBeenCalled();
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "apply",
        stateDir,
        acknowledgeClawHubRisk: true,
        run: async (_source, _trust, persistSource) => (await persistSource()).source.name,
      }),
    ).resolves.toMatchObject({ value: packageName, riskAcknowledgementRequired: true });
  });

  it("rejects a valid archive when its embedded package identity differs", async () => {
    const { stateDir } = await prepareResolverFixture();
    mocks.read.mockResolvedValue({
      ok: true,
      manifest: {},
      source: { kind: "package", name: "@openclaw/other-claw", version },
      diagnostics: [],
    });

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName, version },
        mode: "apply",
        stateDir,
        run: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "clawhub_identity_mismatch" });
    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
