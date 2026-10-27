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
  listClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
  searchClawHubClaws,
  withResolvedClawHubSource,
} from "./clawhub-source.js";
import type { ClawManifest } from "./types.js";

const packageName = "@openclaw/research-briefing";
const personalPackageName = "@alice/research-briefing";
const version = "1.0.0";
const archiveBytes = Buffer.alloc(321);
const digest = createHash("sha256").update(archiveBytes).digest("hex");
const tempDirs = createTrackedTempDirs();
let fixtureRoot: string;
let fixtureStateDir: string;
const packageJson = (name = packageName, selectedVersion = version, claw = "claw.json") =>
  JSON.stringify({ name, version: selectedVersion, openclaw: { claw } });
const writePackage = (name = packageName, selectedVersion = version) =>
  fs.writeFile(path.join(fixtureRoot, "package.json"), packageJson(name, selectedVersion));
const artifact = (selectedVersion = version, name = packageName) => ({
  package: { name, family: "claw" },
  version: selectedVersion,
  artifact: { kind: "npm-pack", sha256: digest, npmIntegrity: "sha512-proof" },
});
const release = (
  selectedVersion = version,
  clawManifestSummary: unknown = summary,
  name = packageName,
) => ({
  package: { name, displayName: "Research Briefing", family: "claw" },
  version: { version: selectedVersion, createdAt: 2, changelog: "", clawManifestSummary },
});
const skillRequest = { slug: "citation-check", ownerHandle: "openclaw", version: "1.1.0" };
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectCode = (attempt: Promise<unknown>, code: string) =>
  expect(attempt).rejects.toMatchObject({ code });
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

const communityPackage = () => ({
  ...officialPackage(personalPackageName),
  channel: "community",
  isOfficial: false,
  ownerHandle: "alice",
  ownerOfficial: false,
});

async function selectPackage(pkg: ReturnType<typeof officialPackage>) {
  mocks.detail.mockResolvedValue({
    package: pkg,
    owner: { handle: pkg.ownerHandle, official: pkg.ownerOfficial },
  });
  mocks.version.mockResolvedValue(release(version, summary, pkg.name));
  mocks.artifact.mockResolvedValue(artifact(version, pkg.name));
  await writePackage(pkg.name);
}

const summary = {
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
  workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
  packages: { skillCount: 2, pluginCount: 0 },
  mcpServerCount: 1,
  cronJobCount: 0,
};

const emptyManifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
};
const listPage = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
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
  await fs.writeFile(
    path.join(fixtureRoot, "claw.json"),
    JSON.stringify({ ...emptyManifest, packages }),
  );
  return { stateDir: fixtureStateDir };
}

beforeEach(async () => {
  vi.resetAllMocks();
  const temp = await tempDirs.make("openclaw-clawhub-catalog-");
  const extractedRoot = (fixtureRoot = path.join(temp, "extracted"));
  fixtureStateDir = path.join(temp, "state");
  const archivePath = path.join(temp, "catalog.clawpack");
  await fs.mkdir(extractedRoot);
  await writePackage();
  await fs.writeFile(path.join(extractedRoot, "SOUL.md"), "# Research brief\n");
  await fs.writeFile(path.join(extractedRoot, "USER.md"), "# Reader preferences\n");
  await fs.writeFile(path.join(extractedRoot, "BOOTSTRAP.md"), "# First-run setup\n");
  await fs.writeFile(archivePath, archiveBytes);
  const contentsManifest = {
    ...emptyManifest,
    workspace: {
      bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
      files: [{ source: "USER.md", path: "USER.md" }],
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
  it.each(["featured", "category", "search", "blank", "limited"] as const)(
    "filters publishers and preserves %s ordering through the public API",
    async (mode) => {
      const registry = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
        "../infra/clawhub-packages.js",
      );
      mocks.list.mockImplementation(registry.listClawHubPackages);
      mocks.search.mockImplementation(registry.searchClawHubPackages);
      const official = {
        ...officialPackage(),
        ownerOfficial: false,
        stats: { installs: 20 },
      };
      const community = { ...communityPackage(), stats: { installs: 1 } };
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        const nextPage = mode === "category" && !url.searchParams.has("cursor");
        const valid =
          mode === "category" ? [nextPage ? community : official] : [community, official];
        const items =
          url.searchParams.get("isOfficial") === "true"
            ? [official]
            : [
                ...valid,
                officialPackage("@other/impostor"),
                { ...officialPackage(), ownerHandle: "someone-else" },
                { ...officialPackage(), name: 42 },
                { ...communityPackage(), channel: "private" },
              ];
        return Response.json(
          url.pathname.endsWith("/search")
            ? { results: items.map((pkg, index) => ({ score: 10 - index, package: pkg })) }
            : { items, nextCursor: nextPage || mode === "limited" ? "next" : null },
        );
      });
      const entries =
        mode !== "featured" && mode !== "category"
          ? await searchClawHubClaws({
              query: mode === "search" ? "research" : " ",
              ...(mode === "limited" ? { limit: 1 } : {}),
              ...(mode === "search" ? { category: "research" } : {}),
            })
          : await listClawHubClaws(
              mode === "featured" ? { featured: true } : { category: "research" },
            );
      const expected = [
        [personalPackageName, "community", false, "alice", 1],
        [packageName, "official", false, "openclaw", 20],
      ];
      expect(
        entries.map((entry) => [
          entry.packageName,
          entry.channel,
          entry.official,
          entry.ownerHandle,
          entry.installs,
        ]),
      ).toEqual(
        mode === "limited"
          ? expected.slice(0, 1)
          : mode === "search" || mode === "category"
            ? expected.toReversed()
            : expected,
      );
      if (mode === "limited") {
        expect(mocks.list).toHaveBeenCalledOnce();
      }
    },
  );

  it("projects a personal publisher release from its verified archive", async () => {
    await selectPackage(communityPackage());
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
      workspaceFiles: 3,
      skills: 1,
      plugins: 1,
      mcpServers: 1,
      scheduledJobs: 1,
      contents: { skills: [{ excerpt: "Citation check" }] },
    });
  });

  it("keeps the detail available when a skill card cannot be fetched", async () => {
    mocks.skillCard.mockRejectedValueOnce(new Error("Skill card unavailable"));

    await expect(readClawHubClawDetail({ packageName })).resolves.toMatchObject({
      contents: { skills: [{ name: "@openclaw/citation-check", version: "1.1.0" }] },
    });
  });

  it("previews verified workspace files and declared skills", async () => {
    await expectPreview("instruction", "USER.md", "# Reader preferences\n");
    await expectPreview("instruction", "BOOTSTRAP.md", "# First-run setup\n");
    await expectPreview("skill", "@openclaw/citation-check", "# Citation check\n");
    expect(mocks.skillCard).toHaveBeenCalledWith(expect.objectContaining(skillRequest));
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
    await fs.rm(path.join(fixtureRoot, "BOOTSTRAP.md"));
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      packageJson(packageName, version, "CLAW.md"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: travel }\n---\n# Travel planner\n",
    );
    await expect(readClawHubClawDetail({ packageName })).resolves.toMatchObject({
      workspaceFiles: 1,
      contents: {
        instructions: [{ name: "SOUL.md", source: "CLAW.md#body", excerpt: "Travel planner" }],
      },
    });
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
      await writePackage(packageName, selectedVersion);

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
    mocks.list.mockResolvedValue(listPage([officialPackage()], "loop"));
    await expect(listClawHubClaws()).rejects.toThrow(/cursor/);
  });
});

describe("verified ClawHub Claw source", () => {
  it("rejects a different per-call registry before resolving dependencies", async () => {
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://configured.example");
    const { stateDir } = await prepareResolverFixture([
      { kind: "skill", source: "clawhub", ref: "@acme/dependency", version: "1.0.0" },
    ]);
    const run = vi.fn(async () => "unreachable");

    const attempt = resolveSource({
      mode: "apply",
      baseUrl: "https://other.example",
      stateDir,
      run,
    });

    await expectCode(attempt, "clawhub_registry_mismatch");
    expect(run).not.toHaveBeenCalled();
    await expectMissing(stateDir);
  });

  it.each([
    ["process-configured URL", undefined, true],
    ["matching per-call URL", "https://configured.example/clawhub/", true],
    ["another registry without dependencies", "https://other.example", false],
  ] as const)("accepts the %s", async (_name, baseUrl, dependencies) => {
    vi.stubEnv("OPENCLAW_CLAWHUB_URL", "https://configured.example/clawhub");
    await prepareResolverFixture(
      dependencies
        ? [{ kind: "skill", source: "clawhub", ref: "@acme/triage", version: "1.0.0" }]
        : [],
    );
    const run = vi.fn(async () => "resolved");
    await expect(resolveSource({ mode: "apply", baseUrl, run })).resolves.toMatchObject({
      value: "resolved",
    });
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
    ).resolves.toBe(packageJson());
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
    await selectPackage(communityPackage());
    await useRealTrust({
      ...matchingSecurity,
      package: { name: personalPackageName, family: "claw" },
      overview: "No security analysis has been recorded yet.",
      verdict: "review",
    });
    const resolvePersonal = (mode: "preview" | "apply", acknowledgeClawHubRisk = false) =>
      withResolvedClawHubSource({
        coordinate: { packageName: personalPackageName, version },
        mode,
        stateDir,
        acknowledgeClawHubRisk,
        run: async (_source, _trust, persistSource) =>
          acknowledgeClawHubRisk ? (await persistSource()).source.name : undefined,
      });
    await expect(resolvePersonal("preview")).resolves.toMatchObject({
      riskAcknowledgementRequired: true,
    });
    mocks.download.mockClear();
    await expectCode(resolvePersonal("apply"), "clawhub_risk_acknowledgement_required");
    expect(mocks.download).not.toHaveBeenCalled();
    await expectMissing(stateDir);
    await expect(resolvePersonal("apply", true)).resolves.toMatchObject({
      value: personalPackageName,
      riskAcknowledgementRequired: true,
    });
  });

  it("rejects a valid archive when its embedded package identity differs", async () => {
    const { stateDir } = await prepareResolverFixture();
    await writePackage("@openclaw/other-claw");

    await expectCode(probeSource({ mode: "apply", stateDir }), "clawhub_identity_mismatch");
    await expectMissing(stateDir);
  });
});

describe("Claw catalog artwork", () => {
  const iconPath = `/api/v1/skill-icons/${"a".repeat(64)}`;
  const iconUrl = `https://registry.example${iconPath}`;
  it.each([
    [iconPath, iconUrl],
    [iconUrl, iconUrl],
    [`https://tracker.example${iconPath}`, undefined],
    ["https://registry.example/arbitrary.svg", undefined],
    [null, undefined],
  ])("projects only registry-hosted content-addressed artwork: %s", async (icon, expected) => {
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
  });
});
