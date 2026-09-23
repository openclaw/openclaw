// ClawHub lifecycle tests cover registry metadata lookup and error handling.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type {
  ClawHubSkillSecurityVerdictItem,
  ClawHubSkillVerificationResponse,
} from "../../infra/clawhub-skills.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const fetchClawHubSkillDetailMock = vi.fn();
const fetchClawHubSkillInstallResolutionMock = vi.fn();
const fetchClawHubSkillVerificationMock = vi.fn();
const fetchClawHubSkillSecurityVerdictsMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const downloadClawHubSkillArchiveUrlMock = vi.fn();
const downloadClawHubGitHubSkillArchiveMock = vi.fn();
const reportClawHubSkillInstallTelemetryMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const isDefaultClawHubBaseUrlMock = vi.fn((baseUrl?: string) => !baseUrl);
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const evaluateSkillInstallPolicyMock = vi.fn();
const pathExistsMock = vi.fn();
const digestClawHubSkillTreeMock = vi.fn(async () => `sha256:${"a".repeat(64)}`);
const markClawPackageIndependentlyOwnedMock = vi.fn();
const tempDirs = createTrackedTempDirs();

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

vi.mock("../../infra/install-package-dir.js", () => ({
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

vi.mock("../../state/claw-package-adoption.js", () => ({
  markClawPackageIndependentlyOwned: markClawPackageIndependentlyOwnedMock,
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

function bindHostWorkspace(gateway: string, host: string) {
  return registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: vi.fn(),
    applySkillRoot: (params) => applyExtractedSkillRoot({ ...params, workspaceDir: host }),
    clawHubSkills: {
      planClawHubSkillUninstall: async (params) => {
        const result = await planClawHubSkillUninstall({ ...params, workspaceDir: host });
        return result.ok ? { ...result, plan: { ...result.plan, workspaceDir: gateway } } : result;
      },
      applyClawHubSkillUninstall: (plan, options) =>
        applyClawHubSkillUninstall({ ...plan, workspaceDir: host }, options),
      resolveClawHubSkillVerificationTarget: (params) =>
        resolveClawHubSkillVerificationTarget({ ...params, workspaceDir: host }),
      readClawHubSkillsLockfile: () => readClawHubSkillsLockfile(host),
      resolveRequestedUpdateSlug: (params) =>
        resolveRequestedUpdateSlug({ ...params, workspaceDir: host }),
      resolveTrackedUpdateTarget: (params) =>
        resolveTrackedUpdateTarget({ ...params, workspaceDir: host }),
      guardTrackedSkillLocalState: (params) =>
        guardTrackedSkillLocalState({ ...params, workspaceDir: host }),
      preflightSkillOwnerState: (params) =>
        preflightSkillOwnerState({ ...params, workspaceDir: host }),
      assertClawHubSkillInstallState: (params) =>
        assertClawHubSkillInstallState({ ...params, workspaceDir: host }),
      readInstalledClawHubSkillFiles,
      recordClawHubSkillInstall: (params) =>
        recordClawHubSkillInstall({ ...params, workspaceDir: host }),
    },
  });
}

const {
  installSkillFromClawHub,
  preflightSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} = await import("./clawhub.js");

function expectInstallPackageSourceDir(sourceDir: string) {
  const call = installPackageDirMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected installPackageDir call");
  }
  expect(call[0]?.sourceDir).toBe(sourceDir);
}

function installPolicyInput() {
  const call = evaluateSkillInstallPolicyMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected evaluateSkillInstallPolicy call");
  }
  return call[0] as
    | {
        origin?: { registry?: string; slug?: string; ownerHandle?: string };
        requestedSpecifier?: string;
        source?: { kind?: string; authority?: string; mutable?: boolean; network?: boolean };
      }
    | undefined;
}

function expectInstalledSkill(
  result: Awaited<ReturnType<typeof installSkillFromClawHub>>,
  expected: { slug?: string; version?: string; targetDir?: string } = {},
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected skill install success, got ${result.error}`);
  }
  if (expected.slug) {
    expect(result.slug).toBe(expected.slug);
  }
  if (expected.version) {
    expect(result.version).toBe(expected.version);
  }
  if (expected.targetDir) {
    expect(result.targetDir).toBe(expected.targetDir);
  }
}

function expectInvalidSlug(result: Awaited<ReturnType<typeof installSkillFromClawHub>>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected invalid slug failure");
  }
  expect(result.error).toContain("Invalid skill slug");
}

function installTestSkill(
  workspaceDir: string,
  slug: string,
  params: Omit<Parameters<typeof installSkillFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return installSkillFromClawHub({ workspaceDir, slug, ...params });
}

function updateTestSkill(
  workspaceDir: string,
  slug?: string,
  params: Omit<Parameters<typeof updateSkillsFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return updateSkillsFromClawHub({ workspaceDir, ...(slug ? { slug } : {}), ...params });
}

function mockDefaultPackageInstall(testWorkspaceDir: string) {
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

function mockArchiveInstallResolution(slug: string, version: string, downloadUrl: string) {
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug,
    installKind: "archive",
    archive: { version, downloadUrl },
  });
}

function mockGitHubInstallResolution(params: {
  slug: string;
  repo: string;
  path: string;
  commit: string;
  contentHash: string;
  sourceUrl: string;
}) {
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug: params.slug,
    installKind: "github",
    github: {
      repo: params.repo,
      path: params.path,
      commit: params.commit,
      contentHash: params.contentHash,
      sourceUrl: params.sourceUrl,
    },
  });
}

function mockSkillSecurityVerdict(item: ClawHubSkillSecurityVerdictItem) {
  fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
    schema: "clawhub.skill.security-verdicts.v1",
    items: [
      {
        ...item,
        overview: item.overview ?? "No security analysis has been recorded yet.",
        securityAuditUrl:
          item.securityAuditUrl ??
          `${item.skillUrl ?? `https://clawhub.ai/${item.publisherHandle ?? "openclaw"}/skills/${item.requestedSlug}`}/security-audit?version=${item.requestedVersion}`,
      },
    ],
  });
}

function mockSkillVerification(response: ClawHubSkillVerificationResponse) {
  fetchClawHubSkillVerificationMock.mockResolvedValueOnce(response);
}

function mockInstalledSkillFile(content: string) {
  installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
    await fs.mkdir(params.targetDir, { recursive: true });
    await fs.writeFile(path.join(params.targetDir, "SKILL.md"), content, "utf8");
    return { ok: true, targetDir: params.targetDir };
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeClawHubOriginFixture(params: {
  workspaceDir: string;
  slug: string;
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
}) {
  const skillDir = path.join(params.workspaceDir, "skills", params.slug);
  const registry = params.registry ?? "https://private.example.com/clawhub";
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  const skillFile =
    params.skillFile ??
    (params.skillMd !== undefined
      ? {
          path: "SKILL.md",
          sha256: createHash("sha256").update(params.skillMd).digest("hex"),
        }
      : undefined);
  const fileTreeSha256 =
    params.fileTreeSha256 ??
    (params.skillMd !== undefined ? `sha256:${"a".repeat(64)}` : undefined);
  const digests = {
    ...(skillFile ? { skillFile } : {}),
    ...(fileTreeSha256 ? { fileTreeSha256 } : {}),
  };
  await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
  if (params.skillMd !== undefined) {
    await fs.writeFile(path.join(skillDir, "SKILL.md"), params.skillMd, "utf8");
  }
  await fs.writeFile(
    path.join(skillDir, ".clawhub", "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry,
        slug: params.originSlug ?? params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
        installedVersion,
        installedAt,
        ...digests,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (params.writeLock !== false) {
    await fs.mkdir(path.join(params.workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(params.workspaceDir, ".clawhub", "lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            [params.slug]: {
              version: installedVersion,
              installedAt,
              registry,
              ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
              ...(params.requestedReference
                ? { requestedReference: params.requestedReference }
                : {}),
              ...(params.trustState ? { trustState: params.trustState } : {}),
              ...digests,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return skillDir;
}

function writeTrackedSkill(
  workspaceDir: string,
  slug: string,
  params: Omit<Parameters<typeof writeClawHubOriginFixture>[0], "workspaceDir" | "slug"> = {},
) {
  return writeClawHubOriginFixture({ workspaceDir, slug, ...params });
}

export {
  readClawHubSkillsLockfileStatusSync,
  resolveClawHubSkillStatusLinkSync,
  fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolutionMock,
  fetchClawHubSkillVerificationMock,
  fetchClawHubSkillSecurityVerdictsMock,
  downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrlMock,
  downloadClawHubGitHubSkillArchiveMock,
  reportClawHubSkillInstallTelemetryMock,
  resolveClawHubBaseUrlMock,
  isDefaultClawHubBaseUrlMock,
  searchClawHubSkillsMock,
  archiveCleanupMock,
  withExtractedArchiveRootMock,
  installPackageDirMock,
  evaluateSkillInstallPolicyMock,
  pathExistsMock,
  digestClawHubSkillTreeMock,
  markClawPackageIndependentlyOwnedMock,
  tempDirs,
  bindHostWorkspace,
  expectInstallPackageSourceDir,
  installPolicyInput,
  expectInstalledSkill,
  expectInvalidSlug,
  installTestSkill,
  updateTestSkill,
  mockArchiveInstallResolution,
  mockDefaultPackageInstall,
  mockGitHubInstallResolution,
  mockSkillSecurityVerdict,
  mockSkillVerification,
  mockInstalledSkillFile,
  readJson,
  writeTrackedSkill,
  ClawHubRequestError,
  readClawHubSkillsLockfile,
  untrackClawHubSkill,
  preflightSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
};
