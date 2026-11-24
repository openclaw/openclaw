import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";

export function expectFailure<T extends { ok: true } | { ok: false; error: string }>(
  result: T,
): asserts result is Extract<T, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected failure");
  }
}
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type {
  ClawHubSkillSecurityVerdictItem,
  ClawHubSkillVerificationResponse,
  ClawHubSkillInstallResolutionResponse,
} from "../../infra/clawhub-skills.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

export const fetchClawHubSkillDetailMock = vi.fn();
export const fetchClawHubSkillInstallResolutionMock = vi.fn();
export const fetchClawHubSkillVerificationMock = vi.fn();
export const fetchClawHubSkillSecurityVerdictsMock = vi.fn();
export const downloadClawHubSkillArchiveMock = vi.fn();
export const downloadClawHubSkillArchiveUrlMock = vi.fn();
export const downloadClawHubGitHubSkillArchiveMock = vi.fn();
export const reportClawHubSkillInstallTelemetryMock = vi.fn();
export const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
export const isDefaultClawHubBaseUrlMock = vi.fn((baseUrl?: string) => !baseUrl);
export const searchClawHubSkillsMock = vi.fn();
export const archiveCleanupMock = vi.fn();
export const withExtractedArchiveRootMock = vi.fn();
export const installPackageDirMock = vi.fn();
export const evaluateSkillInstallPolicyMock = vi.fn();
export const pathExistsMock = vi.fn();
export const digestClawHubSkillTreeMock = vi.fn(async () => `sha256:${"a".repeat(64)}`);
export const tempDirs = createTrackedTempDirs();

vi.mock("../../infra/clawhub-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-skills.js")>()),
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolution: fetchClawHubSkillInstallResolutionMock,
  fetchClawHubSkillVerification: fetchClawHubSkillVerificationMock,
  fetchClawHubSkillSecurityVerdicts: fetchClawHubSkillSecurityVerdictsMock,
  reportClawHubSkillInstallTelemetry: reportClawHubSkillInstallTelemetryMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-artifacts.js")>()),
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrl: downloadClawHubSkillArchiveUrlMock,
  downloadClawHubGitHubSkillArchive: downloadClawHubGitHubSkillArchiveMock,
}));

vi.mock("../../infra/clawhub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-client.js")>()),
  isDefaultClawHubBaseUrl: isDefaultClawHubBaseUrlMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
}));

vi.mock("../../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../../infra/install-package-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-package-dir.js")>()),
  installPackageDir: installPackageDirMock,
}));

vi.mock("../../plugins/install-security-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/install-security-scan.js")>();
  return {
    ...actual,
    evaluateSkillInstallPolicy: (...args: unknown[]) => evaluateSkillInstallPolicyMock(...args),
  };
});

vi.mock("../../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/fs-safe.js")>()),
  pathExists: pathExistsMock,
}));

vi.mock("./skill-tree-digest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./skill-tree-digest.js")>()),
  digestClawHubSkillTree: digestClawHubSkillTreeMock,
}));

const { ClawHubRequestError } = await import("../../infra/clawhub-client.js");
const { applyExtractedSkillRoot } = await import("./archive-install.js");
const {
  preflightSkillOwnerState,
  resolveRequestedUpdateSlug,
  resolveTrackedUpdateTarget,
  resolveClawHubSkillStatusLinkSync,
} = await import("./clawhub-status.js");
const {
  assertClawHubSkillInstallState,
  readClawHubSkillsLockfile,
  readClawHubSkillsLockfileStatusSync,
  readInstalledClawHubSkillFiles,
  recordClawHubSkillInstall,
  untrackClawHubSkill,
} = await import("./clawhub-store.js");

const { guardTrackedSkillLocalState, planClawHubSkillUninstall, applyClawHubSkillUninstall } =
  await import("./clawhub-uninstall.js");

export function bindHostWorkspace(gateway: string, host: string) {
  const onHost =
    <P extends { workspaceDir: string }, R>(run: (params: P) => R) =>
    (params: P) =>
      run({ ...params, workspaceDir: host });
  return registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: vi.fn(),
    applySkillRoot: onHost(applyExtractedSkillRoot),
    clawHubSkills: {
      planClawHubSkillUninstall: async (params) => {
        const result = await planClawHubSkillUninstall({ ...params, workspaceDir: host });
        return result.ok ? { ...result, plan: { ...result.plan, workspaceDir: gateway } } : result;
      },
      applyClawHubSkillUninstall: (plan, options) =>
        applyClawHubSkillUninstall({ ...plan, workspaceDir: host }, options),
      resolveClawHubSkillVerificationTarget: onHost(resolveClawHubSkillVerificationTarget),
      readClawHubSkillsLockfile: () => readClawHubSkillsLockfile(host),
      resolveRequestedUpdateSlug: onHost(resolveRequestedUpdateSlug),
      resolveTrackedUpdateTarget: onHost(resolveTrackedUpdateTarget),
      guardTrackedSkillLocalState: onHost(guardTrackedSkillLocalState),
      preflightSkillOwnerState: onHost(preflightSkillOwnerState),
      assertClawHubSkillInstallState: onHost(assertClawHubSkillInstallState),
      readInstalledClawHubSkillFiles,
      recordClawHubSkillInstall: onHost(recordClawHubSkillInstall),
    },
  });
}

const {
  installSkillFromClawHub,
  preflightSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillVerificationTarget,
  updateSkillsFromClawHub,
} = await import("./clawhub.js");

export function expectInstalledSkill(
  result: Awaited<ReturnType<typeof installSkillFromClawHub>>,
  expected: { slug?: string; version?: string; targetDir?: string } = {},
) {
  expect(result).toMatchObject({ ok: true, ...expected });
}

export function installTestSkill(
  workspaceDir: string,
  slug: string,
  params: Omit<Parameters<typeof installSkillFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return installSkillFromClawHub({ workspaceDir, slug, ...params });
}

export function updateTestSkill(
  workspaceDir: string,
  slug?: string,
  params: Omit<Parameters<typeof updateSkillsFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return updateSkillsFromClawHub({ workspaceDir, ...(slug ? { slug } : {}), ...params });
}

export function mockDefaultPackageInstall(testWorkspaceDir: string) {
  installPackageDirMock.mockImplementation(
    async (params: {
      targetDir: string;
      afterBackup?: (backupDir: string) => Promise<{ ok: boolean; error?: string; code?: string }>;
    }) => {
      const backup = await params.afterBackup?.(params.targetDir);
      if (backup && !backup.ok) {
        return backup;
      }
      return { ok: true, targetDir: path.join(testWorkspaceDir, "skills", "agentreceipt") };
    },
  );
}

export function mockArchiveInstallResolution(slug: string, version: string, downloadUrl: string) {
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug,
    installKind: "archive",
    archive: { version, downloadUrl },
  });
}

export function mockGitHubInstallResolution(
  params: { slug: string } & Extract<
    ClawHubSkillInstallResolutionResponse,
    { installKind: "github" }
  >["github"],
) {
  const { slug, ...github } = params;
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug,
    installKind: "github",
    github,
  });
}

export function mockSkillSecurityVerdict(item: ClawHubSkillSecurityVerdictItem) {
  fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
    schema: "clawhub.skill.security-verdicts.v1",
    items: [
      {
        ...item,
        overview: item.overview ?? "No security concerns found in this fixture release.",
        securityAuditUrl:
          item.securityAuditUrl ??
          `${item.skillUrl ?? `https://clawhub.ai/${item.publisherHandle ?? "openclaw"}/skills/${item.requestedSlug}`}/security-audit?version=${item.requestedVersion}`,
      },
    ],
  });
}

export function mockSkillVerification(response: ClawHubSkillVerificationResponse) {
  fetchClawHubSkillVerificationMock.mockResolvedValueOnce(response);
}

export const unverifiedWeatherVerification: ClawHubSkillVerificationResponse = {
  schema: "clawhub.skill.verify.v1",
  ok: true,
  decision: "pass",
  reasons: [],
  skill: null,
  publisher: null,
  version: null,
  card: null,
  artifact: null,
  security: null,
  signature: null,
  provenance: {
    source: "unavailable",
    url: "https://github.com/openclaw/skills/tree/unverified/weather",
  },
};

export const missingWeatherVersionVerification: ClawHubSkillVerificationResponse = {
  ...unverifiedWeatherVerification,
  ok: false,
  decision: "fail",
  reasons: ["version.not_found"],
  slug: "weather",
  displayName: "Weather",
  pageUrl: "https://clawhub.ai/demo-owner/skills/weather",
  publisherHandle: "demo-owner",
  publisherDisplayName: "Demo Owner",
  createdAt: 123,
  skill: { slug: "weather", displayName: "Weather" },
  publisher: { handle: "demo-owner", displayName: "Demo Owner" },
  card: { available: true },
  provenance: { source: "unavailable" },
};

export function captureWarnings() {
  const messages: string[] = [];
  return {
    logger: { warn: (message: string) => messages.push(message) },
    warnings: () => messages.join("\n"),
  };
}

export function mockInstalledSkillFile(content: string) {
  installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
    await fs.mkdir(params.targetDir, { recursive: true });
    await fs.writeFile(path.join(params.targetDir, "SKILL.md"), content, "utf8");
    return { ok: true, targetDir: params.targetDir };
  });
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function writeTrackedSkill(
  workspaceDir: string,
  slug: string,
  params: {
    originSlug?: string;
    ownerHandle?: string;
    requestedReference?: string;
    trustState?: string;
    registry?: string;
    installedVersion?: string;
    installedAt?: number;
    writeLock?: boolean;
    skillMd?: string;
    skillFile?: { path: string; sha256: string };
    fileTreeSha256?: string;
    originFields?: Record<string, unknown>;
    lockFields?: Record<string, unknown>;
  } = {},
) {
  const skillDir = path.join(workspaceDir, "skills", slug);
  const registry = params.registry ?? "https://private.example.com/clawhub";
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  const skillFile =
    params.skillFile ??
    (params.skillMd !== undefined
      ? { path: "SKILL.md", sha256: createHash("sha256").update(params.skillMd).digest("hex") }
      : undefined);
  const fileTreeSha256 =
    params.fileTreeSha256 ??
    (params.skillMd !== undefined ? `sha256:${"a".repeat(64)}` : undefined);
  const shared = {
    registry,
    installedAt,
    skillFile,
    fileTreeSha256,
    ownerHandle: params.ownerHandle || undefined,
    requestedReference: params.requestedReference || undefined,
    trustState: params.trustState || undefined,
  };
  const writeJson = (file: string, value: unknown) =>
    fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
  if (params.skillMd !== undefined) {
    await fs.writeFile(path.join(skillDir, "SKILL.md"), params.skillMd, "utf8");
  }
  await writeJson(path.join(skillDir, ".clawhub", "origin.json"), {
    version: 1,
    slug: params.originSlug ?? slug,
    installedVersion,
    ...shared,
    ...params.originFields,
  });
  if (params.writeLock !== false) {
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await writeJson(path.join(workspaceDir, ".clawhub", "lock.json"), {
      version: 1,
      skills: { [slug]: { version: installedVersion, ...shared, ...params.lockFields } },
    });
  }
  return skillDir;
}

export {
  applyExtractedSkillRoot,
  readClawHubSkillsLockfileStatusSync,
  resolveClawHubSkillStatusLinkSync,
  ClawHubRequestError,
  readClawHubSkillsLockfile,
  untrackClawHubSkill,
  preflightSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillVerificationTarget,
  updateSkillsFromClawHub,
};
