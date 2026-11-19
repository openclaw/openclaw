import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateTemplatesCatalogDetailResult } from "@openclaw/gateway-protocol";
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
vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
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
  readTemplateManifestFile: mocks.read,
}));

import {
  readClawHubTemplateDetail,
  readClawHubTemplatePreview,
  resetTemplateDetailContentsForTest,
  readClawHubTemplatesOverview,
  searchClawHubTemplates,
  withResolvedClawHubSource,
} from "./clawhub-source.js";
import type { TemplateManifest } from "./types.js";

const packageName = "@openclaw/research-briefing";
const personalPackageName = "@alice/research-briefing";
const version = "1.0.0";
const archiveBytes = Buffer.alloc(321);
const digest = createHash("sha256").update(archiveBytes).digest("hex");
const tempDirs = createTrackedTempDirs();
let fixtureRoot: string;
let fixtureStateDir: string;
const packageJson = (name = packageName, selectedVersion = version, template = "CLAW.md") =>
  JSON.stringify({ name, version: selectedVersion, openclaw: { template } });
const writePackage = (name = packageName, selectedVersion = version) =>
  fs.writeFile(path.join(fixtureRoot, "package.json"), packageJson(name, selectedVersion));
const artifact = (selectedVersion = version, name = packageName) => ({
  package: { name, family: "template" },
  version: selectedVersion,
  artifact: { kind: "npm-pack", sha256: digest, npmIntegrity: "sha512-proof" },
});
const release = (
  selectedVersion = version,
  templateManifestSummary: unknown = summary,
  name = packageName,
) => ({
  package: { name, displayName: "Research Briefing", family: "template" },
  version: {
    version: selectedVersion,
    createdAt: 2,
    changelog: "",
    templateManifestSummary,
    artifact: artifact(selectedVersion, name).artifact,
  },
});
const skillRequest = { slug: "citation-check", ownerHandle: "openclaw", version: "1.1.0" };
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectCode = (attempt: Promise<unknown>, code: string) =>
  expect(attempt).rejects.toMatchObject({ code });
const matchingSecurity = {
  package: { name: packageName, family: "template" },
  release: {
    version,
    artifactKind: "npm-pack",
    artifactSha256: digest,
    npmIntegrity: "sha512-proof",
  },
  overview: "No concerning capabilities found.",
  verdict: "benign",
  securityAuditUrl: "https://clawhub.ai/openclaw/templates/research-briefing/security-audit",
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
  family: "template",
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

const emptyManifest: TemplateManifest = {
  schemaVersion: 1,
  agent: { id: "research-briefing", name: "Research Briefing" },
  workspace: { bootstrapFiles: {}, files: [] },
  skills: [],
  plugins: [],
  mcpServers: {},
  automations: [],
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
  readClawHubTemplatePreview({ packageName, version, kind, name });
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

async function prepareResolverFixture(
  packages: Array<{
    kind: "skill" | "plugin";
    source: "clawhub";
    ref: string;
    version: string;
  }> = [],
) {
  await fs.writeFile(
    path.join(fixtureRoot, "CLAW.md"),
    `---\n${JSON.stringify({ ...emptyManifest, skills: packages.filter((pkg) => pkg.kind === "skill").map((entry) => ({ ref: entry.ref, version: entry.version })), plugins: packages.filter((pkg) => pkg.kind === "plugin").map((entry) => ({ ref: entry.ref, version: entry.version })) })}\n---\n`,
  );
  return { stateDir: fixtureStateDir };
}

beforeEach(async () => {
  resetTemplateDetailContentsForTest();
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
    skills: [{ ref: "@openclaw/citation-check", version: "1.1.0" }],
    plugins: [{ ref: "@openclaw/source-plugin", version: "2.0.0" }],
    mcpServers: { sources: { command: "source-tool" } },
    automations: [
      {
        id: "daily-briefing",
        name: "Daily briefing",
        enabled: false,
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        message: "Prepare the briefing",
      },
    ],
  } satisfies TemplateManifest;
  await fs.writeFile(
    path.join(extractedRoot, "CLAW.md"),
    `---\n${JSON.stringify(contentsManifest)}\n---\n`,
  );
  const { readTemplateManifestFile } =
    await vi.importActual<typeof import("./reader.js")>("./reader.js");
  mocks.read.mockImplementation(readTemplateManifestFile);
  mocks.skillCard.mockResolvedValue("# Citation check\n");
  mocks.security.mockRejectedValue(new Error("Audit unavailable"));
  mockArchive(archivePath, extractedRoot);
  mocks.detail.mockResolvedValue({
    package: { ...officialPackage(), ownerHandle: undefined, templateManifestSummary: summary },
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

describe("public ClawHub Template catalog", () => {
  it("projects an overview in one HTTP read, retaining featured order and category ranking", async () => {
    const official = { ...officialPackage(), stats: { installs: 20 } };
    const community = { ...communityPackage(), stats: { installs: 1 } };
    const impostor = officialPackage("@other/impostor");
    const fetch = vi.fn(async (_input: unknown) =>
      Response.json({
        complete: true,
        featured: [community, impostor, official],
        sections: [{ category: "research", items: [community, impostor, official] }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const overview = await readClawHubTemplatesOverview({
      baseUrl: "https://registry.example",
      limit: 8,
      timeoutMs: 1234,
    });
    expect(overview?.featured.map((entry) => entry.packageName)).toEqual([
      personalPackageName,
      packageName,
    ]);
    expect(overview?.sections[0]?.entries.map((entry) => entry.packageName)).toEqual([
      packageName,
      personalPackageName,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://registry.example/api/v1/templates/overview?limit=8",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404, body: {}, fallback: true },
    { status: 200, body: { complete: false }, fallback: true },
    { status: 200, body: { complete: true, featured: [] }, fallback: false },
    ...[401, 403, 429, 500].map((status) => ({ status, body: {}, fallback: false })),
  ])(
    "uses legacy shelves only for 404/incomplete, not $status failures ($fallback)",
    async ({ status, body, fallback }) => {
      const fetch = vi.fn(async () =>
        Response.json(body, { status, headers: { "retry-after": "61" } }),
      );
      vi.stubGlobal("fetch", fetch);
      const result = readClawHubTemplatesOverview({ baseUrl: "https://registry.example" });
      if (fallback) {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toThrow();
      }
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      params: { featured: true },
      search: { featured: "true", limit: "20" },
      names: [personalPackageName, packageName],
    },
    { params: { query: " " }, search: { limit: "20" }, names: [personalPackageName, packageName] },
    {
      params: { cursor: "opaque-page", limit: 1 },
      search: { cursor: "opaque-page", limit: "1" },
      names: [personalPackageName],
    },
    {
      params: { query: " brief " },
      search: { q: "brief", limit: "100" },
      names: [personalPackageName, packageName],
    },
    {
      params: { query: "brief", category: "research" },
      search: { q: "brief", category: "research", limit: "100" },
      names: [packageName, personalPackageName],
    },
    {
      params: { query: packageName, limit: 100 },
      search: { q: packageName, limit: "100" },
      names: [personalPackageName, packageName],
    },
  ])("returns one bounded public page for $params", async ({ params, search, names }) => {
    const registry = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
      "../infra/clawhub-packages.js",
    );
    mocks.list.mockImplementation(registry.listClawHubPackages);
    mocks.search.mockImplementation(registry.searchClawHubPackages);
    const official = { ...officialPackage(), ownerOfficial: false, stats: { installs: 20 } };
    const community = { ...communityPackage(), stats: { installs: 1 } };
    const items = [
      community,
      official,
      officialPackage("@other/impostor"),
      { ...official, ownerHandle: "other" },
      { ...official, name: 42 },
      { ...community, channel: "private" },
    ];
    const typed = "q" in search;
    const body = typed
      ? { results: items.map((pkg, i) => ({ score: 10 - i, package: pkg })) }
      : { items, nextCursor: "cursor" in search ? "next-page" : null };
    const fetch = vi.fn(async (_url: string | URL) => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    const page = await searchClawHubTemplates({ ...params, baseUrl: "https://registry.example" });
    expect(page.entries.map((entry) => entry.packageName)).toEqual(names);
    expect(page.entries.every((entry) => !entry.official)).toBe(true);
    expect(page.nextCursor).toBe(typed ? undefined : "cursor" in search ? "next-page" : null);
    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(typed ? "/api/v1/packages/search" : "/api/v1/packages");
    expect(Object.fromEntries(url.searchParams)).toEqual({ family: "template", ...search });
  });

  it("projects a personal publisher release from its verified archive", async () => {
    await selectPackage(communityPackage());
    mocks.skillCard.mockResolvedValueOnce(
      "---\nname: citation-check\ndescription: Metadata description\n---\n# Citation check\n",
    );
    const detail = await readClawHubTemplateDetail({ packageName: personalPackageName });
    expect(validateTemplatesCatalogDetailResult({ detail })).toBe(true);
    expect(mocks.skillCard).not.toHaveBeenCalled();
    expect(detail.contents.instructions.every((item) => item.excerpt === undefined)).toBe(true);
    expect(detail).toMatchObject({
      packageName: personalPackageName,
      version,
      agentId: "research-briefing",
      agentName: "Research Briefing",
      channel: "community",
      official: false,
      ownerHandle: "alice",
      workspaceFiles: 3,
      skills: 1,
      plugins: 1,
      mcpServers: 1,
      scheduledJobs: 1,
      contents: {
        skills: [{ name: "@openclaw/citation-check", version: "1.1.0" }],
        automations: [{ name: "Daily briefing", enabled: false }],
      },
    });
  });

  it("reuses only verified metadata with matching live download permission", async () => {
    mocks.security.mockResolvedValue(matchingSecurity);
    const first = await readClawHubTemplateDetail({ packageName, version });
    const current = await readClawHubTemplateDetail({ packageName, version });
    expect(current.contents).toEqual(first.contents);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    expect(mocks.security).toHaveBeenCalledTimes(2);
    mocks.security.mockResolvedValue({
      ...matchingSecurity,
      trust: { ...matchingSecurity.trust, blockedFromDownload: true },
    });
    mocks.download.mockRejectedValueOnce(new Error("blocked by registry"));
    await expect(readClawHubTemplateDetail({ packageName, version })).rejects.toThrow(
      "blocked by registry",
    );
  });

  it("revalidates the archive when cached metadata has no explicit download decision", async () => {
    mocks.security.mockResolvedValue(matchingSecurity);
    await readClawHubTemplateDetail({ packageName, version });
    const { parseClawHubPackageSecurityResponse } = await vi.importActual<
      typeof import("../infra/clawhub-packages.js")
    >("../infra/clawhub-packages.js");
    mocks.security.mockImplementation(async () =>
      parseClawHubPackageSecurityResponse({ ...matchingSecurity, trust: {} }),
    );
    mocks.download.mockRejectedValueOnce(new Error("download unavailable"));
    await expect(readClawHubTemplateDetail({ packageName, version })).rejects.toThrow(
      "download unavailable",
    );
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });

  it("uses a previously seen latest version only to predict the parallel audit, never to select the release", async () => {
    mocks.security.mockResolvedValue(matchingSecurity);
    await readClawHubTemplateDetail({ packageName });
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof mocks.detail>>>();
    mocks.detail.mockReturnValueOnce(gate.promise);
    const pending = readClawHubTemplateDetail({ packageName });
    expect(mocks.security).toHaveBeenCalledTimes(2);
    const next = "2.0.0";
    await writePackage(packageName, next);
    mocks.version.mockResolvedValue(release(next));
    gate.resolve({
      package: { ...officialPackage(), latestVersion: next },
      owner: { handle: "openclaw" },
    });
    expect((await pending).version).toBe(next);
    expect(mocks.security).toHaveBeenLastCalledWith(expect.objectContaining({ version: next }));
  });

  it("reports the exact release's audit, publication date and categories for the detail rail", async () => {
    mocks.detail.mockResolvedValue({
      package: { ...officialPackage(), createdAt: 1, categories: ["research", ""] },
      owner: { handle: "openclaw", official: true },
    });
    mocks.security.mockResolvedValue(matchingSecurity);
    const detail = await readClawHubTemplateDetail({ packageName });
    expect(validateTemplatesCatalogDetailResult({ detail })).toBe(true);
    expect(mocks.security).toHaveBeenCalledWith(
      expect.objectContaining({ name: packageName, version }),
    );
    expect(detail).toMatchObject({
      createdAtMs: 1,
      categories: ["research"],
      security: { verdict: "benign", auditUrl: matchingSecurity.securityAuditUrl },
    });
  });

  it.each([
    ["another release", { ...matchingSecurity, release: { version: "0.9.0" } }],
    ["a failed audit read", new Error("audit unavailable")],
  ])("keeps the detail and shows no audit for %s", async (_name, security) => {
    if (security instanceof Error) {
      mocks.security.mockRejectedValue(security);
    } else {
      mocks.security.mockResolvedValue(security);
    }
    const detail = await readClawHubTemplateDetail({ packageName });
    expect(validateTemplatesCatalogDetailResult({ detail })).toBe(true);
    expect(detail.version).toBe(version);
    expect(detail).not.toHaveProperty("security");
  });

  it("discloses and previews bundled skills only from the verified artifact", async () => {
    const skill = path.join(fixtureRoot, "skills", "local-checklist");
    await fs.mkdir(skill, { recursive: true });
    const content =
      "---\nname: local-checklist\ndescription: Follow the local checklist.\n---\n# Local checklist\nRead references/checklist.bin.\n";
    await fs.writeFile(path.join(skill, "SKILL.md"), content);
    await fs.mkdir(path.join(skill, "references"));
    await fs.writeFile(path.join(skill, "references", "checklist.bin"), Buffer.from([0, 255, 128]));
    await fs.mkdir(path.join(fixtureRoot, "undeclared"));
    await fs.writeFile(
      path.join(fixtureRoot, "undeclared", "SKILL.md"),
      "---\nname: undeclared\ndescription: Not a dependency.\n---\n",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "CLAW.md"),
      `---\n${JSON.stringify({ ...emptyManifest, skills: [{ path: "skills/local-checklist" }] })}\n---\n`,
    );
    const detail = await readClawHubTemplateDetail({ packageName });
    expect(validateTemplatesCatalogDetailResult({ detail })).toBe(true);
    expect(detail.skills).toBe(1);
    expect(detail.contents.skills).toEqual([
      {
        name: "local-checklist",
        source: "bundled",
        path: "skills/local-checklist",
      },
    ]);
    await expectPreview("skill", "local-checklist", content);
    expect(mocks.skillCard).not.toHaveBeenCalled();
  });

  it("keeps the detail available when a skill card cannot be fetched", async () => {
    mocks.skillCard.mockRejectedValueOnce(new Error("Skill card unavailable"));

    await expect(readClawHubTemplateDetail({ packageName })).resolves.toMatchObject({
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
    const { readTemplateManifestFile } =
      await vi.importActual<typeof import("./reader.js")>("./reader.js");
    mocks.read.mockImplementation(async (root: string) => {
      const verified = await readTemplateManifestFile(root);
      await fs.writeFile(path.join(root, name), "# Changed content\n");
      return verified;
    });

    await expect(previewContent("instruction", name)).rejects.toMatchObject({
      code: "clawhub_preview_unavailable",
      message: "This workspace file changed during preview.",
    });
  });

  it("lists and previews the SOUL file generated from the Template document", async () => {
    await fs.rm(path.join(fixtureRoot, "BOOTSTRAP.md"));
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      packageJson(packageName, version, "CLAW.md"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: travel }\n---\n# Travel planner\n",
    );
    await expect(readClawHubTemplateDetail({ packageName })).resolves.toMatchObject({
      workspaceFiles: 1,
      contents: {
        instructions: [{ name: "SOUL.md", source: "CLAW.md#body" }],
      },
    });
    await expectPreview("instruction", "SOUL.md", "# Travel planner\n");
  });

  it("lists a binary workspace file without an excerpt and declines its preview", async () => {
    await fs.rm(path.join(fixtureRoot, "BOOTSTRAP.md"));
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      packageJson(packageName, version, "CLAW.md"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "icon.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "CLAW.md"),
      "---\nschemaVersion: 1\nagent: { id: travel }\nworkspace:\n  files:\n    - { source: icon.png, path: assets/icon.png }\n---\n# Travel planner\n",
    );
    const detail = await readClawHubTemplateDetail({ packageName });
    expect(detail.contents.instructions).toContainEqual({
      name: "assets/icon.png",
      source: "icon.png",
    });
    await expectCode(previewContent("instruction", "assets/icon.png"), "clawhub_preview_not_text");
  });

  it("starts exact-release reads together and reuses their artifact metadata", async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof mocks.detail>>>();
    mocks.detail.mockReturnValueOnce(gate.promise);
    const pending = readClawHubTemplateDetail({ packageName, version });
    await vi.waitFor(() => {
      expect(mocks.version).toHaveBeenCalledOnce();
      expect(mocks.download).toHaveBeenCalledOnce();
    });
    expect(mocks.extract).not.toHaveBeenCalled();
    gate.resolve({ package: officialPackage(), owner: { handle: "openclaw", official: true } });
    await pending;
    expect(mocks.artifact).not.toHaveBeenCalled();
    const download = await mocks.download.mock.results[0]!.value;
    expect(download.cleanup).toHaveBeenCalledOnce();
  });

  it("aborts an unfinished archive when parallel metadata fails", async () => {
    const metadata = Promise.withResolvers<Awaited<ReturnType<typeof mocks.detail>>>();
    const aborted = vi.fn();
    mocks.detail.mockReturnValueOnce(metadata.promise);
    mocks.download.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted();
              reject(new Error("download aborted"));
            },
            { once: true },
          );
        }),
    );
    const pending = readClawHubTemplateDetail({ packageName, version });
    const rejected = expect(pending).rejects.toThrow("metadata unavailable");
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    metadata.reject(new Error("metadata unavailable"));
    await rejected;
    expect(aborted).toHaveBeenCalledOnce();
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it.each(["metadata", "artifact"])(
    "cleans the parallel download when %s verification fails",
    async (failure) => {
      if (failure === "metadata") {
        mocks.detail.mockRejectedValueOnce(new Error("metadata unavailable"));
      } else {
        const selected = release();
        mocks.version.mockResolvedValueOnce({
          ...selected,
          version: {
            ...selected.version,
            artifact: { ...selected.version.artifact, sha256: "f".repeat(64) },
          },
        });
      }
      await expect(readClawHubTemplateDetail({ packageName, version })).rejects.toThrow(
        failure === "metadata" ? "metadata unavailable" : /integrity|match/i,
      );
      const download = await mocks.download.mock.results[0]!.value;
      expect(download.cleanup).toHaveBeenCalledOnce();
      expect(mocks.extract).not.toHaveBeenCalled();
    },
  );

  it("does not substitute the latest package summary for a missing exact-release summary", async () => {
    mocks.version.mockResolvedValue(release(version, null));
    await expectCode(
      readClawHubTemplateDetail({ packageName }),
      "clawhub_manifest_summary_missing",
    );
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

      const detail = await readClawHubTemplateDetail({ packageName, version: selectedVersion });
      expect(detail.version).toBe(selectedVersion);
      expect(detail.iconUrl).toBe(icon ? `https://clawhub.ai${icon}` : undefined);
      expect(validateTemplatesCatalogDetailResult({ detail })).toBe(true);
      expect(detail).not.toHaveProperty("scanStatus");
    },
  );

  it("reports a missing unpinned package without starting a second failing read", async () => {
    mocks.detail.mockRejectedValueOnce(new Error("Package not found"));
    await expect(readClawHubTemplateDetail({ packageName })).rejects.toThrow("Package not found");
    expect(mocks.security).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("refuses a non-canonical coordinate or forged publisher before resolving detail", async () => {
    await expect(
      readClawHubTemplateDetail({ packageName: "@alice/research-briefing@latest" }),
    ).rejects.toThrow(/package name/);
    expect(mocks.detail).not.toHaveBeenCalled();

    mocks.detail.mockResolvedValue({
      package: { ...officialPackage(), ownerHandle: "someone-else" },
      owner: { handle: "someone-else" },
    });
    await expect(readClawHubTemplateDetail({ packageName })).rejects.toThrow(/identity/);

    mocks.detail.mockResolvedValue({
      package: { ...communityPackage(), channel: "private" },
      owner: { handle: "alice" },
    });
    await expect(
      readClawHubTemplatePreview({
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
    await expect(searchClawHubTemplates({ cursor: "loop" })).rejects.toThrow(/cursor/);
    await expect(searchClawHubTemplates({ query: "brief", cursor: "loop" })).rejects.toThrow(
      /cursor/,
    );
    expect(mocks.search).not.toHaveBeenCalled();
  });
});

describe("verified ClawHub Template source", () => {
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

  it("overlaps package and exact-artifact reads while keeping trust before download", async () => {
    await prepareResolverFixture();
    const detailRead = Promise.withResolvers<unknown>();
    const artifactRead = Promise.withResolvers<unknown>();
    mocks.detail.mockImplementationOnce(() => detailRead.promise);
    mocks.artifact.mockImplementationOnce(() => artifactRead.promise);
    const attempt = probeSource();
    try {
      expect(mocks.detail).toHaveBeenCalledTimes(1);
      expect(mocks.artifact).toHaveBeenCalledTimes(1);
      expect(mocks.trust).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
    } finally {
      detailRead.resolve({ package: officialPackage(), owner: { handle: "openclaw" } });
      artifactRead.resolve(artifact());
      await attempt;
    }
    expect(mocks.trust).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
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
      packageRoot: path.join(stateDir, "templates", "sources", digest),
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
    expect(first.value).toBe(path.join(stateDir, "templates", "sources", digest));
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
    mocks.artifact.mockResolvedValueOnce(artifact(version, "@openclaw/other-template"));
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

  it("resolves a publisher-qualified reference to a Template stored under an unscoped name", async () => {
    await prepareResolverFixture();
    await selectPackage({ ...communityPackage(), name: "research-briefing" });
    const resolveRef = (ref: string) =>
      withResolvedClawHubSource({
        coordinate: { packageName: ref },
        mode: "preview",
        run: async (source) => source.source.name,
      });

    await expect(resolveRef(personalPackageName)).resolves.toMatchObject({
      value: "research-briefing",
    });
    expect(mocks.detail).toHaveBeenCalledWith(
      expect.objectContaining({ name: personalPackageName }),
    );
    // Exact-release identity, trust and archive bytes bind to the stored name.
    for (const read of [mocks.artifact, mocks.download]) {
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ name: "research-briefing" }));
    }
    expect(mocks.trust).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { kind: "template", packageName: "research-briefing" } }),
    );

    mocks.download.mockClear();
    await expectCode(resolveRef("@mallory/research-briefing"), "clawhub_identity_mismatch");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("previews a publisher-qualified reference to a Template stored under an unscoped name", async () => {
    await selectPackage({ ...communityPackage(), name: "research-briefing" });
    const preview = (ref: string) =>
      readClawHubTemplatePreview({
        packageName: ref,
        version,
        kind: "instruction",
        name: "USER.md",
      });

    await expect(preview(personalPackageName)).resolves.toEqual({
      kind: "instruction",
      name: "USER.md",
      content: "# Reader preferences\n",
    });
    await expectCode(preview("@mallory/research-briefing"), "clawhub_identity_mismatch");
  });

  it("requires personal-release risk acknowledgement and never persists denied content", async () => {
    const { stateDir } = await prepareResolverFixture();
    await selectPackage(communityPackage());
    await useRealTrust({
      ...matchingSecurity,
      package: { name: personalPackageName, family: "template" },
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

  it.each([{ claw: "CLAW.md" }, { template: "template.json" }])(
    "rejects an obsolete artifact before apply handoff or persistence: %j",
    async (openclaw) => {
      const { stateDir } = await prepareResolverFixture();
      await fs.writeFile(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify({ name: packageName, version, openclaw }),
      );
      await fs.writeFile(path.join(fixtureRoot, "template.json"), JSON.stringify(emptyManifest));
      const run = vi.fn(async () => undefined);
      await expectCode(resolveSource({ mode: "apply", stateDir, run }), "clawhub_manifest_invalid");
      expect(run).not.toHaveBeenCalled();
      await expectMissing(stateDir);
    },
  );

  it("rejects a valid archive when its embedded package identity differs", async () => {
    const { stateDir } = await prepareResolverFixture();
    await writePackage("@openclaw/other-template");

    await expectCode(probeSource({ mode: "apply", stateDir }), "clawhub_identity_mismatch");
    await expectMissing(stateDir);
  });
});

describe("Template catalog artwork", () => {
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
    const listed = await searchClawHubTemplates({ baseUrl: "https://registry.example" });
    const searched = await searchClawHubTemplates({
      query: "research",
      baseUrl: "https://registry.example",
    });
    for (const { entries } of [listed, searched]) {
      expect(entries[0]?.iconUrl).toBe(expected);
    }
  });
});
