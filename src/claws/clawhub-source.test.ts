import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateClawsCatalogDetailResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  detail: vi.fn(),
  version: vi.fn(),
  artifact: vi.fn(),
  security: vi.fn(),
  download: vi.fn(),
  trust: vi.fn(),
  extract: vi.fn(),
  read: vi.fn(),
  skillCard: vi.fn(),
}));

// mock-isolation: Catalog responses are fixed fixtures; no live registry request may escape.
vi.mock("../infra/clawhub-packages.js", () => ({
  listClawHubPackages: mocks.list,
  searchClawHubPackages: mocks.search,
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageVersion: mocks.version,
  fetchClawHubPackageArtifact: mocks.artifact,
  fetchClawHubPackageSecurity: mocks.security,
}));
// mock-isolation: Archive bytes come from the fixture so source identity remains deterministic.
vi.mock("../infra/clawhub-artifacts.js", () => ({
  downloadClawHubPackageArchive: mocks.download,
}));
vi.mock("../infra/clawhub-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-skills.js")>()),
  fetchClawHubSkillCard: mocks.skillCard,
}));
// mock-isolation: Trust verdicts are explicit fixtures, never ambient policy state.
vi.mock("../infra/clawhub-install-trust.js", () => ({
  checkClawHubPackageTrust: mocks.trust,
}));
// mock-isolation: Extraction is controlled by each test without touching package installers.
vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: mocks.extract,
}));
// mock-isolation: Catalog fixtures use the real reader; resolver fixtures control source identity.
vi.mock("./reader.js", () => ({
  readClawManifestFile: mocks.read,
}));

import {
  ClawHubSourceError,
  listClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
  searchClawHubClaws,
  withResolvedClawHubSource,
} from "./clawhub-source.js";
import type { ClawManifest } from "./types.js";

const packageName = "@openclaw/research-briefing";
const version = "1.0.0";
const archiveBytes = Buffer.alloc(321);
const digest = createHash("sha256").update(archiveBytes).digest("hex");
const tempDirs = createTrackedTempDirs();
const artifact = (selectedVersion = version, name = packageName) => ({
  package: { name, family: "claw" },
  version: selectedVersion,
  artifact: { kind: "npm-pack", sha256: digest, npmIntegrity: "sha512-proof" },
});
const release = (selectedVersion = version, clawManifestSummary: unknown = summary) => ({
  package: { name: packageName, displayName: "Research Briefing", family: "claw" },
  version: { version: selectedVersion, createdAt: 2, changelog: "", clawManifestSummary },
});
const skillRequest = { slug: "citation-check", ownerHandle: "openclaw", version: "1.1.0" };
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectCode = (attempt: Promise<unknown>, code: string) =>
  expect(attempt).rejects.toMatchObject({ code });
const expectCall = (mock: unknown, fields: object) =>
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
const matchingSecurity = {
  package: { name: packageName, family: "claw" },
  release: {
    version,
    artifactKind: "npm-pack",
    artifactSha256: digest,
    npmIntegrity: "sha512-proof",
  },
  overview: "No concerning capabilities found.",
  verdict: "benign",
  securityAuditUrl: "https://clawhub.ai/openclaw/claws/research-briefing/security-audit",
  trust: {
    scanStatus: "clean",
    moderationState: "approved",
    blockedFromDownload: false,
    reasons: [],
    pending: false,
    stale: false,
  },
};

const officialPackage = (name = packageName) => ({
  name,
  displayName: "Research Briefing",
  family: "claw",
  channel: "official",
  isOfficial: true,
  ownerHandle: "openclaw",
  ownerOfficial: true,
  updatedAt: 2,
  latestVersion: version,
});

function communityPackage() {
  return {
    ...officialPackage("@alice/research-briefing"),
    channel: "community",
    isOfficial: false,
    ownerHandle: "alice",
    ownerOfficial: false,
  };
}

function selectPackage(pkg: ReturnType<typeof officialPackage>) {
  mocks.detail.mockResolvedValue({
    package: pkg,
    owner: { handle: pkg.ownerHandle, official: pkg.ownerOfficial },
  });
  mocks.version.mockResolvedValue({
    package: { name: pkg.name, family: "claw" },
    version: { version, createdAt: 2, changelog: "", clawManifestSummary: summary },
  });
  mocks.artifact.mockResolvedValue({
    package: { name: pkg.name, family: "claw" },
    version,
    artifact: { kind: "npm-pack", sha256: digest, npmIntegrity: "sha512-proof" },
  });
  const read = mocks.read.getMockImplementation()!;
  mocks.read.mockImplementation(async (root: string) => {
    const result = await read(root);
    return { ...result, source: { ...result.source, name: pkg.name } };
  });
}

const summary = {
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
  workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
  packages: { skillCount: 2, pluginCount: 0 },
  mcpServerCount: 1,
  cronJobCount: 0,
};

const emptyWorkspaceManifest = {
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
};
const emptyManifest: ClawManifest = {
  ...emptyWorkspaceManifest,
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
};
function readSource(root: string, selectedVersion = version) {
  return {
    kind: "package" as const,
    name: packageName,
    version: selectedVersion,
    packageRoot: root,
    manifestPath: path.join(root, "CLAW.md"),
    integrityKind: "development-snapshot" as const,
    integrity: "sha256:development",
    byteLength: 1,
  };
}
function mockArchive(archivePath: string, extractedRoot: string) {
  mocks.download.mockResolvedValue({
    archivePath,
    artifact: "clawpack",
    sha256Hex: digest,
    npmIntegrity: "sha512-proof",
    cleanup: vi.fn(),
  });
  mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted(extractedRoot));
}
const resolveSource = <T>(
  options: Omit<Parameters<typeof withResolvedClawHubSource<T>>[0], "coordinate">,
) => withResolvedClawHubSource({ coordinate: { packageName, version }, ...options });
const previewContent = (kind: "skill" | "instruction", name: string) =>
  readClawHubClawPreview({ packageName, version, kind, name });
const expectPreview = (kind: "skill" | "instruction", name: string, content: string) =>
  expect(previewContent(kind, name)).resolves.toEqual({ kind, name, content });

const probeSource = (
  options: Partial<
    Pick<
      Parameters<typeof withResolvedClawHubSource>[0],
      "mode" | "stateDir" | "acknowledgeClawHubRisk"
    >
  > = {},
) => resolveSource({ mode: "preview", run: async () => undefined, ...options });
const installSource = (stateDir: string) =>
  resolveSource({
    mode: "apply",
    stateDir,
    run: async (_source, _trust, persistSource) => (await persistSource()).source.packageRoot,
  });

async function useRealTrust(security = matchingSecurity) {
  const { checkClawHubPackageTrust } = await vi.importActual<
    typeof import("../infra/clawhub-install-trust.js")
  >("../infra/clawhub-install-trust.js");
  mocks.trust.mockImplementation(checkClawHubPackageTrust);
  mocks.security.mockResolvedValue(security);
}

async function prepareResolverFixture(packages: ClawManifest["packages"] = []) {
  const temp = await tempDirs.make("openclaw-clawhub-claw-");
  const extractedRoot = path.join(temp, "extracted");
  const archivePath = path.join(temp, "claw.tgz");
  const stateDir = path.join(temp, "state");
  await fs.mkdir(extractedRoot);
  await fs.writeFile(path.join(extractedRoot, "package.json"), "{}\n");
  await fs.writeFile(archivePath, archiveBytes);
  mockArchive(archivePath, extractedRoot);
  mocks.read.mockImplementation(async (root: string) => ({
    ok: true,
    manifest: { packages },
    source: readSource(root),
    diagnostics: [],
  }));
  return { stateDir, extractedRoot };
}

beforeEach(async () => {
  vi.resetAllMocks();
  const temp = await tempDirs.make("openclaw-clawhub-catalog-");
  const extractedRoot = path.join(temp, "extracted");
  const archivePath = path.join(temp, "catalog.clawpack");
  await fs.mkdir(extractedRoot);
  await fs.writeFile(
    path.join(extractedRoot, "package.json"),
    JSON.stringify({ name: packageName, version, openclaw: { claw: "claw.json" } }),
  );
  await fs.writeFile(path.join(extractedRoot, "SOUL.md"), "# Research brief\n");
  await fs.writeFile(path.join(extractedRoot, "USER.md"), "# Reader preferences\n");
  await fs.writeFile(path.join(extractedRoot, "BOOTSTRAP.md"), "# First-run setup\n");
  await fs.writeFile(path.join(extractedRoot, "brief.md"), "# Brief template\n");
  await fs.writeFile(archivePath, archiveBytes);
  const contentsManifest = {
    schemaVersion: 1,
    agent: { id: "research-briefing", name: "Research Briefing" },
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
      files: [
        { source: "USER.md", path: "USER.md" },
        { source: "brief.md", path: "brief.md" },
      ],
    },
    packages: [
      { kind: "skill", source: "clawhub", ref: "@openclaw/citation-check", version: "1.1.0" },
      { kind: "plugin", source: "clawhub", ref: "@openclaw/source-plugin", version: "2.0.0" },
    ],
    mcpServers: { sources: { command: "source-tool" } },
    cronJobs: [
      {
        id: "daily-briefing",
        name: "Daily briefing",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        message: "Prepare the briefing",
      },
    ],
  } satisfies ClawManifest;
  await fs.writeFile(path.join(extractedRoot, "claw.json"), JSON.stringify(contentsManifest));
  const { readClawManifestFile } =
    await vi.importActual<typeof import("./reader.js")>("./reader.js");
  mocks.read.mockImplementation(readClawManifestFile);
  mocks.skillCard.mockResolvedValue("# Citation check\n");
  mockArchive(archivePath, extractedRoot);
  mocks.detail.mockResolvedValue({
    package: { ...officialPackage(), ownerHandle: undefined, clawManifestSummary: summary },
    owner: { handle: "openclaw", official: true },
  });
  mocks.version.mockResolvedValue(release());
  mocks.artifact.mockResolvedValue(artifact());
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public ClawHub Claw catalog", () => {
  it("preserves curated Featured order across official and community Claws", async () => {
    mocks.list.mockResolvedValue({
      items: [
        { ...communityPackage(), featuredAt: 20 },
        { ...officialPackage(), featuredAt: 10 },
      ],
      nextCursor: null,
    });

    const entries = await listClawHubClaws({ featured: true });

    expect(entries.map((entry) => entry.packageName)).toEqual([
      "@alice/research-briefing",
      packageName,
    ]);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ family: "claw", featured: true }),
    );
  });

  it("ranks every category Claw by installs without an Official boost", async () => {
    mocks.list
      .mockResolvedValueOnce({
        items: [{ ...officialPackage(), stats: { installs: 1 } }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        items: [{ ...communityPackage(), stats: { installs: 20 } }],
        nextCursor: null,
      });

    const entries = await listClawHubClaws({ category: "research" });

    expect(entries.map((entry) => [entry.packageName, entry.installs])).toEqual([
      ["@alice/research-briefing", 20],
      [packageName, 1],
    ]);
    expect(mocks.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ family: "claw", category: "research" }),
    );
  });

  it("keeps install order when searching within a category", async () => {
    mocks.search.mockResolvedValue([
      { score: 10, package: { ...officialPackage(), stats: { installs: 1 } } },
      { score: 1, package: { ...communityPackage(), stats: { installs: 20 } } },
    ]);

    const entries = await searchClawHubClaws({ query: "briefing", category: "research" });

    expect(entries.map((entry) => entry.packageName)).toEqual([
      "@alice/research-briefing",
      packageName,
    ]);
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "briefing", category: "research", family: "claw" }),
    );
  });

  it("uses the current publisher badge without hiding a former official Claw", async () => {
    const revoked = { ...officialPackage(), ownerOfficial: false };
    mocks.list.mockResolvedValue({ items: [revoked], nextCursor: null });
    expect(await listClawHubClaws()).toMatchObject([{ packageName, official: false }]);
    mocks.detail.mockResolvedValue({
      package: revoked,
      owner: { handle: "openclaw", official: false },
    });
    expect(await readClawHubClawDetail({ packageName, version })).toMatchObject({
      packageName,
      official: false,
    });
  });
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
      expect.objectContaining({ family: "claw", limit: 100 }),
    );
    expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "page 2" }));
  });

  it("uses list for a blank query and filters malformed or private search results", async () => {
    mocks.list.mockResolvedValue({ items: [officialPackage()], nextCursor: null });
    await expect(searchClawHubClaws({ query: "  " })).resolves.toHaveLength(1);
    expect(mocks.search).not.toHaveBeenCalled();

    mocks.search.mockResolvedValue([
      { score: 1, package: officialPackage() },
      { score: 1, package: officialPackage("@other/impostor") },
      { score: 1, package: { ...officialPackage(), ownerHandle: "someone-else" } },
      { score: 1, package: { ...officialPackage(), name: 42 } },
      { score: 1, package: { ...communityPackage(), channel: "private" } },
    ]);
    const result = await searchClawHubClaws({ query: "research" });
    expect(result.map((item) => item.packageName)).toEqual([packageName]);
    expectCall(mocks.search, { query: "research", family: "claw", limit: 100 });
  });

  it("honors the starter catalog limit for a blank query", async () => {
    mocks.list.mockResolvedValue({
      items: [officialPackage("@openclaw/first"), officialPackage("@openclaw/second")],
      nextCursor: "page 2",
    });

    const entries = await searchClawHubClaws({ query: " ", limit: 1 });

    expect(entries.map((entry) => entry.packageName)).toEqual(["@openclaw/first"]);
    expect(mocks.list).toHaveBeenCalledOnce();
    expectCall(mocks.list, { family: "claw", limit: 1 });
  });

  it("discovers personal publishers through the public list and search API", async () => {
    const registry = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
      "../infra/clawhub-packages.js",
    );
    mocks.list.mockImplementation(registry.listClawHubPackages);
    mocks.search.mockImplementation(registry.searchClawHubPackages);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      const items =
        url.searchParams.get("isOfficial") === "true"
          ? [officialPackage()]
          : [officialPackage(), communityPackage()];
      return Response.json(
        url.pathname.endsWith("/search")
          ? { results: items.map((pkg) => ({ score: 1, package: pkg })) }
          : { items, nextCursor: null },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    for (const query of ["", "research"]) {
      const entries = await searchClawHubClaws({ query });
      expect(
        entries.map(({ packageName: name, channel, official, ownerHandle }) => ({
          packageName: name,
          channel,
          official,
          ownerHandle,
        })),
      ).toEqual([
        { packageName, channel: "official", official: true, ownerHandle: "openclaw" },
        {
          packageName: "@alice/research-briefing",
          channel: "community",
          official: false,
          ownerHandle: "alice",
        },
      ]);
    }
  });

  it("projects a personal publisher release and previews its verified archive", async () => {
    const { name: personalPackageName } = communityPackage();
    selectPackage(communityPackage());
    mocks.skillCard.mockResolvedValueOnce(
      "---\nname: citation-check\ndescription: Metadata description\n---\n# Citation check\n",
    );
    const detail = await readClawHubClawDetail({ packageName: personalPackageName });
    expect(validateClawsCatalogDetailResult({ detail })).toBe(true);
    expect(detail).toMatchObject({
      packageName: personalPackageName,
      version,
      agentName: "Research Briefing",
      channel: "community",
      official: false,
      ownerHandle: "alice",
      workspaceFiles: 4,
      skills: 1,
      plugins: 1,
      mcpServers: 1,
      scheduledJobs: 1,
      contents: {
        instructions: [
          { name: "SOUL.md", source: "SOUL.md", excerpt: "Research brief" },
          { name: "USER.md", source: "USER.md", excerpt: "Reader preferences" },
          { name: "brief.md", source: "brief.md", excerpt: "Brief template" },
          { name: "BOOTSTRAP.md", source: "BOOTSTRAP.md", excerpt: "First-run setup" },
        ],
        skills: [{ name: "@openclaw/citation-check", version: "1.1.0", excerpt: "Citation check" }],
        integrations: [
          { name: "@openclaw/source-plugin", kind: "plugin", version: "2.0.0" },
          { name: "sources", kind: "mcpServer" },
        ],
        automations: [{ name: "Daily briefing", schedule: "0 9 * * *", timezone: "UTC" }],
      },
    });
    await expect(
      readClawHubClawPreview({
        packageName: personalPackageName,
        version,
        kind: "instruction",
        name: "brief.md",
      }),
    ).resolves.toEqual({ kind: "instruction", name: "brief.md", content: "# Brief template\n" });
    expectCall(mocks.version, { name: personalPackageName, version });
    expectCall(mocks.download, { name: personalPackageName, version, artifact: "clawpack" });
    expectCall(mocks.skillCard, skillRequest);
  });

  it("keeps the detail available when a skill card cannot be fetched", async () => {
    mocks.skillCard.mockRejectedValueOnce(new Error("Skill card unavailable"));

    await expect(readClawHubClawDetail({ packageName })).resolves.toMatchObject({
      contents: { skills: [{ name: "@openclaw/citation-check", version: "1.1.0" }] },
    });
  });

  it("previews verified workspace files and declared skills", async () => {
    for (const [name, content] of [
      ["SOUL.md", "# Research brief\n"],
      ["USER.md", "# Reader preferences\n"],
      ["brief.md", "# Brief template\n"],
      ["BOOTSTRAP.md", "# First-run setup\n"],
    ] as const) {
      await expectPreview("instruction", name, content);
    }
    await expectPreview("skill", "@openclaw/citation-check", "# Citation check\n");
    expectCall(mocks.skillCard, skillRequest);
    mocks.skillCard.mockRejectedValueOnce(new Error("Skill not found"));
    await expect(previewContent("skill", "@openclaw/citation-check")).rejects.toMatchObject({
      code: "clawhub_preview_unavailable",
      message: "This skill's content is unavailable from the configured ClawHub.",
    });
    await expectCode(previewContent("instruction", "missing.md"), "clawhub_preview_unavailable");
  });

  it.each(["USER.md", "BOOTSTRAP.md"])("rejects %s changed after verification", async (name) => {
    const { readClawManifestFile } =
      await vi.importActual<typeof import("./reader.js")>("./reader.js");
    mocks.read.mockImplementation(async (root: string) => {
      const verified = await readClawManifestFile(root);
      await fs.writeFile(path.join(root, name), "# Changed content\n");
      return verified;
    });

    await expect(previewContent("instruction", name)).rejects.toMatchObject({
      code: "clawhub_preview_unavailable",
      message: "This workspace file changed during preview.",
    });
  });

  it("lists and previews the SOUL file generated from the Claw document", async () => {
    const generatedSource = async () => ({
      ok: true,
      manifest: emptyWorkspaceManifest,
      clawMarkdownBody: Buffer.from("# Travel planner\n"),
      snapshot: { workspaceSources: [] },
      source: { kind: "package", name: packageName, version },
    });
    mocks.read.mockImplementationOnce(generatedSource);
    await expect(readClawHubClawDetail({ packageName })).resolves.toMatchObject({
      workspaceFiles: 1,
      contents: {
        instructions: [{ name: "SOUL.md", source: "CLAW.md#body", excerpt: "Travel planner" }],
      },
    });
    mocks.read.mockImplementationOnce(generatedSource);
    await expectPreview("instruction", "SOUL.md", "# Travel planner\n");
  });

  it("does not substitute the latest package summary for a missing exact-release summary", async () => {
    mocks.version.mockResolvedValue(release(version, null));
    await expectCode(readClawHubClawDetail({ packageName }), "clawhub_manifest_summary_missing");
  });

  it.each([undefined, `/api/v1/skill-icons/${"b".repeat(64)}`])(
    "uses exact-release artwork and scan status for older build-metadata versions (%s)",
    async (icon) => {
      const selectedVersion = "0.9.0+build.1";
      mocks.artifact.mockResolvedValue(artifact(selectedVersion));
      mocks.detail.mockResolvedValue({
        package: {
          ...officialPackage(),
          ownerHandle: undefined,
          scanStatus: "clean",
          icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
        },
        owner: { handle: "openclaw", official: true },
      });
      const selected = release(selectedVersion);
      mocks.version.mockResolvedValue({ ...selected, version: { ...selected.version, icon } });
      mocks.read.mockImplementation(async (root: string) => ({
        ok: true,
        manifest: emptyManifest,
        source: { ...readSource(root, selectedVersion), byteLength: archiveBytes.byteLength },
        diagnostics: [],
      }));

      const detail = await readClawHubClawDetail({ packageName, version: selectedVersion });
      expect(detail.version).toBe(selectedVersion);
      expect(detail.iconUrl).toBe(icon ? `https://clawhub.ai${icon}` : undefined);
      expect(validateClawsCatalogDetailResult({ detail })).toBe(true);
      expect(detail).not.toHaveProperty("scanStatus");
    },
  );

  it("refuses a non-canonical coordinate or forged publisher before resolving detail", async () => {
    await expect(
      readClawHubClawDetail({ packageName: "@alice/research-briefing@latest" }),
    ).rejects.toThrow(/package name/);
    expect(mocks.detail).not.toHaveBeenCalled();

    mocks.detail.mockResolvedValue({
      package: { ...officialPackage(), ownerHandle: "someone-else" },
      owner: { handle: "someone-else" },
    });
    await expect(readClawHubClawDetail({ packageName })).rejects.toThrow(/identity/);

    mocks.detail.mockResolvedValue({
      package: { ...communityPackage(), channel: "private" },
      owner: { handle: "alice" },
    });
    await expect(
      readClawHubClawPreview({
        packageName: "@alice/research-briefing",
        version,
        kind: "instruction",
        name: "SOUL.md",
      }),
    ).rejects.toMatchObject({ code: "clawhub_identity_mismatch" });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("rejects repeating pagination cursors rather than silently hiding starters", async () => {
    mocks.list.mockResolvedValue({ items: [officialPackage()], nextCursor: "loop" });
    await expect(listClawHubClaws()).rejects.toThrow(/cursor/);
  });
});

describe("verified ClawHub Claw source", () => {
  it.each(["skill", "plugin"] as const)(
    "rejects a different per-call registry before resolving %s dependencies",
    async (kind) => {
      vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://configured.example");
      const { stateDir } = await prepareResolverFixture([
        { kind, source: "clawhub", ref: "@acme/dependency", version: "1.0.0" },
      ]);
      const run = vi.fn(async () => "unreachable");

      const attempt = resolveSource({
        mode: "apply",
        baseUrl: "https://other.example",
        stateDir,
        run,
      });

      await expect(attempt).rejects.toBeInstanceOf(ClawHubSourceError);
      await expectCode(attempt, "clawhub_registry_mismatch");
      expect(run).not.toHaveBeenCalled();
      await expectMissing(stateDir);
    },
  );

  it.each([
    { name: "process-configured URL", baseUrl: undefined, dependencies: true },
    {
      name: "matching per-call URL",
      baseUrl: "https://configured.example/clawhub/",
      dependencies: true,
    },
    {
      name: "another registry without dependencies",
      baseUrl: "https://other.example",
      dependencies: false,
    },
  ])("accepts the $name", async ({ baseUrl, dependencies }) => {
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://configured.example/clawhub");
    await prepareResolverFixture(
      dependencies
        ? [
            { kind: "skill", source: "clawhub", ref: "@acme/triage", version: "1.0.0" },
            { kind: "plugin", source: "clawhub", ref: "@acme/github", version: "1.0.0" },
          ]
        : [],
    );
    const run = vi.fn(async () => "resolved");
    await expect(resolveSource({ mode: "apply", baseUrl, run })).resolves.toMatchObject({
      value: "resolved",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps preview ephemeral and persists only after an approved apply asks for it", async () => {
    const { stateDir } = await prepareResolverFixture();
    const preview = await resolveSource({
      mode: "preview",
      stateDir,
      run: async (source, _trust, persistSource) => {
        await expect(persistSource()).rejects.toThrow(/preview/);
        return source.source;
      },
    });
    expect(preview.value).toMatchObject({ integrity: `sha256:${digest}`, byteLength: 321 });
    await expectMissing(stateDir);

    const apply = await resolveSource({
      mode: "apply",
      stateDir,
      run: async (_source, _trust, persistSource) => (await persistSource()).source,
    });
    expect(apply.value).toMatchObject({
      integrity: preview.value.integrity,
      byteLength: preview.value.byteLength,
      packageRoot: path.join(stateDir, "claws", "sources", digest),
    });
    await expect(
      fs.readFile(path.join(apply.value.packageRoot, "package.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(fs.readFile(`${apply.value.packageRoot}.tgz`)).resolves.toEqual(archiveBytes);
  });

  it("reuses an identical source when two applies promote the same digest concurrently", async () => {
    const { stateDir } = await prepareResolverFixture();
    const install = () => installSource(stateDir);

    const [first, second] = await Promise.all([install(), install()]);
    expect(first.value).toBe(path.join(stateDir, "claws", "sources", digest));
    expect(second.value).toBe(first.value);
  });

  it("refuses to reuse a corrupted source at an existing digest path", async () => {
    const { stateDir } = await prepareResolverFixture();
    const install = () => installSource(stateDir);
    const first = await install();
    await fs.writeFile(path.join(first.value, "package.json"), "corrupted\n");

    await expectCode(install(), "clawhub_cached_source_mismatch");
    await expect(fs.readFile(path.join(first.value, "package.json"), "utf8")).resolves.toBe(
      "corrupted\n",
    );
  });

  it("binds artifact identity, resolver digest, and downloaded bytes before extraction", async () => {
    await prepareResolverFixture();
    mocks.artifact.mockResolvedValueOnce(artifact(version, "@openclaw/other-claw"));
    await expectCode(probeSource(), "clawhub_identity_mismatch");
    expect(mocks.download).not.toHaveBeenCalled();

    mocks.download.mockResolvedValueOnce({
      archivePath: "/tmp/wrong.tgz",
      artifact: "clawpack",
      sha256Hex: "b".repeat(64),
      npmIntegrity: "sha512-proof",
      cleanup: vi.fn(),
    });
    await expectCode(probeSource(), "clawhub_artifact_integrity_mismatch");
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("accepts a security verdict for the selected Claw artifact before download", async () => {
    await prepareResolverFixture();
    await useRealTrust();

    await expect(probeSource()).resolves.toMatchObject({ riskAcknowledgementRequired: false });
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it("refuses a mismatched security artifact before download even with risk acknowledged", async () => {
    const { stateDir } = await prepareResolverFixture();
    await useRealTrust({
      ...matchingSecurity,
      release: { ...matchingSecurity.release, artifactSha256: "b".repeat(64) },
    });

    await expectCode(
      probeSource({ mode: "apply", acknowledgeClawHubRisk: true, stateDir }),
      "clawhub_security_unavailable",
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    await expectMissing(stateDir);
  });

  it("requires personal-release risk acknowledgement and never persists denied content", async () => {
    const { stateDir } = await prepareResolverFixture();
    const { name: personalPackageName } = communityPackage();
    selectPackage(communityPackage());
    await useRealTrust({
      ...matchingSecurity,
      package: { name: personalPackageName, family: "claw" },
      overview: "No security analysis has been recorded yet.",
      verdict: "review",
    });

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName: personalPackageName, version },
        mode: "preview",
        stateDir,
        run: async () => undefined,
      }),
    ).resolves.toMatchObject({ riskAcknowledgementRequired: true });
    mocks.download.mockClear();

    await expectCode(
      withResolvedClawHubSource({
        coordinate: { packageName: personalPackageName, version },
        mode: "apply",
        stateDir,
        run: async () => undefined,
      }),
      "clawhub_risk_acknowledgement_required",
    );
    expect(mocks.download).not.toHaveBeenCalled();
    await expectMissing(stateDir);

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName: personalPackageName, version },
        mode: "apply",
        stateDir,
        acknowledgeClawHubRisk: true,
        run: async (_source, _trust, persistSource) => (await persistSource()).source.name,
      }),
    ).resolves.toMatchObject({ value: personalPackageName, riskAcknowledgementRequired: true });
  });

  it("rejects a valid archive when its embedded package identity differs", async () => {
    const { stateDir } = await prepareResolverFixture();
    mocks.read.mockResolvedValue({
      ok: true,
      manifest: {},
      source: { kind: "package", name: "@openclaw/other-claw", version },
      diagnostics: [],
    });

    await expectCode(probeSource({ mode: "apply", stateDir }), "clawhub_identity_mismatch");
    await expectMissing(stateDir);
  });
});

describe("Claw catalog artwork", () => {
  it.each([
    {
      icon: `/api/v1/skill-icons/${"a".repeat(64)}`,
      expected: `https://registry.example/api/v1/skill-icons/${"a".repeat(64)}`,
    },
    {
      icon: `https://registry.example/api/v1/skill-icons/${"a".repeat(64)}`,
      expected: `https://registry.example/api/v1/skill-icons/${"a".repeat(64)}`,
    },
    { icon: `https://tracker.example/api/v1/skill-icons/${"a".repeat(64)}`, expected: undefined },
    { icon: "https://registry.example/arbitrary.svg", expected: undefined },
    { icon: null, expected: undefined },
  ])(
    "projects only registry-hosted content-addressed artwork: $icon",
    async ({ icon, expected }) => {
      const pkg = { ...officialPackage(), icon };
      mocks.list.mockResolvedValue({ items: [pkg], nextCursor: null });
      mocks.search.mockResolvedValue([{ package: pkg }]);
      const listed = await listClawHubClaws({ baseUrl: "https://registry.example" });
      const searched = await searchClawHubClaws({
        query: "research",
        baseUrl: "https://registry.example",
      });
      for (const entries of [listed, searched]) {
        expect(entries[0]?.iconUrl).toBe(expected);
      }
    },
  );
});
