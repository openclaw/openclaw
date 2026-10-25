import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasErrnoCode } from "../../infra/errno.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { registerRemoteClawHubTests } from "./clawhub.remote.test-support.js";
import { resetClawHubSkillTestMocks } from "./clawhub.test-setup.js";
import * as hub from "./clawhub.test-support.js";

const privateRegistry = "https://private.example.com/clawhub";
const skillsShRef = "skills-sh:openclaw/skills/agentreceipt";
const weatherSkillsShRef = "skills-sh:openclaw/skills/weather";
const officialSlug = "tao-setup-nvidia-gpu-host";

const mocks = {
  detail: hub.fetchClawHubSkillDetailMock,
  resolve: hub.fetchClawHubSkillInstallResolutionMock,
  verify: hub.fetchClawHubSkillVerificationMock,
  verdict: hub.fetchClawHubSkillSecurityVerdictsMock,
  archive: hub.downloadClawHubSkillArchiveMock,
  archiveUrl: hub.downloadClawHubSkillArchiveUrlMock,
  github: hub.downloadClawHubGitHubSkillArchiveMock,
  telemetry: hub.reportClawHubSkillInstallTelemetryMock,
  baseUrl: hub.resolveClawHubBaseUrlMock,
  cleanup: hub.archiveCleanupMock,
  extract: hub.withExtractedArchiveRootMock,
  install: hub.installPackageDirMock,
  policy: hub.evaluateSkillInstallPolicyMock,
  exists: hub.pathExistsMock,
};

function expectContains(text: string, ...parts: Array<string | RegExp>) {
  for (const part of parts) {
    expect(text).toMatch(part);
  }
}

function expectUnused(...targets: unknown[]) {
  for (const target of targets) {
    expect(target).not.toHaveBeenCalled();
  }
}
const expectNoArchiveDownloads = () => expectUnused(mocks.archive, mocks.archiveUrl);
const archiveResult = (integrity = "sha256-test", digest = "a") => ({
  archivePath: "/tmp/agentreceipt.zip",
  integrity,
  sha256Hex: digest.repeat(64),
  artifact: "archive",
  cleanup: mocks.cleanup,
});

const readLock = (workspaceDir: string) =>
  hub.readJson<{ skills: Record<string, Record<string, unknown>> }>(
    path.join(workspaceDir, ".clawhub/lock.json"),
  );
const readOrigin = (workspaceDir: string, slug: string) =>
  hub.readJson<Record<string, unknown>>(
    path.join(workspaceDir, "skills", slug, ".clawhub/origin.json"),
  );

describe("skills-clawhub", () => {
  let workspaceDir: string;
  const install = (
    slug = "agentreceipt",
    params: Parameters<typeof hub.installTestSkill>[2] = {},
  ) => hub.installTestSkill(workspaceDir, slug, params);
  const installedFields = (slug: string, version: string) => ({
    slug,
    version,
    targetDir: path.join(workspaceDir, "skills", slug),
  });
  const updatedFields = (slug: string, version: string) => ({
    ok: true,
    previousVersion: "0.9.0",
    changed: true,
    ...installedFields(slug, version),
  });
  const verify = (
    slug: string,
    selectors: Omit<
      Parameters<typeof hub.resolveClawHubSkillVerificationTarget>[0],
      "workspaceDir" | "slug"
    > = {},
  ) => hub.resolveClawHubSkillVerificationTarget({ workspaceDir, slug, ...selectors });

  afterEach(async () => {
    await hub.tempDirs.cleanup();
  });

  beforeEach(async () => {
    workspaceDir = await hub.tempDirs.make("openclaw-clawhub-workspace-");
    resetClawHubSkillTestMocks(workspaceDir);
  });

  registerRemoteClawHubTests(() => workspaceDir);

  it.each(["directory receipt", "ClawHub receipt", "rollback failure"] as const)(
    "preserves incomplete recovery from %s",
    async (failure) => {
      const error = "Could not restore the displaced skill directory";
      const deferred = {
        deferCommit: true,
        assertOwned: () => undefined,
        expectedClawHubState: {
          slug: "agentreceipt",
          skillFilePath: "SKILL.md",
          skillFileSha256: "old-skill",
          fileTreeSha256: "old-tree",
        },
      };
      if (failure === "directory receipt") {
        mocks.exists.mockImplementation(
          async (input: string) =>
            input.endsWith("SKILL.md") || input.endsWith("/skills/agentreceipt"),
        );
        mocks.install.mockResolvedValueOnce({ ok: true });
      } else {
        await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
          installedVersion: "1.0.0",
          skillMd: "old skill",
        });
        if (failure === "ClawHub receipt") {
          mocks.extract.mockResolvedValueOnce({
            ok: true,
            targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
          });
        } else {
          mocks.install.mockResolvedValueOnce({ ok: false, error, recoveryIncomplete: true });
        }
      }
      const result =
        failure === "directory receipt"
          ? await hub.applyExtractedSkillRoot({
              workspaceDir,
              slug: "agentreceipt",
              extractedRoot: "/tmp/extracted-skill",
              mode: "update",
              ...deferred,
            })
          : await install("agentreceipt", {
              version: "2.0.0",
              force: true,
              clawManaged: true,
              ...(failure === "ClawHub receipt" ? deferred : {}),
            });
      expect(result).toMatchObject({
        ok: false,
        recoveryIncomplete: true,
        ...(failure === "rollback failure" ? { error } : {}),
      });
    },
  );

  function mockSecurity(overrides: Partial<Parameters<typeof hub.mockSkillSecurityVerdict>[0]>) {
    hub.mockSkillSecurityVerdict({
      ok: true,
      decision: "pass",
      reasons: [],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.0.0",
      slug: "agentreceipt",
      version: "1.0.0",
      ...overrides,
    });
  }

  function denySecurity(
    reasons: string[],
    overrides: Partial<Parameters<typeof hub.mockSkillSecurityVerdict>[0]> = {},
  ) {
    mockSecurity({ ok: false, decision: "fail", reasons, ...overrides });
  }

  it.each([404, 500])("sanitizes install errors with status %s", async (status) => {
    const body = "remote-controlled failure";
    mocks.resolve.mockRejectedValueOnce(
      new hub.ClawHubRequestError({ path: "/api/v1/skills/missing-skill/install", status, body }),
    );
    const result = await install("missing-skill");
    expect(result).toEqual({
      ok: false,
      error:
        status === 404
          ? 'Skill "missing-skill" not found on ClawHub. Run `openclaw skills search missing-skill` to find the right skill reference.'
          : 'ClawHub is temporarily unavailable while installing skill "missing-skill". Try again later.',
    });
    hub.expectFailure(result);
    expect(result.error).not.toContain("/api/v1/");
    expect(result.error).not.toContain(body);
  });

  it.each([
    ["skills-sh:", "Invalid skills.sh skill reference"],
    ["skills-sh/owner/repo/slug", "Invalid skills.sh skill reference"],
    ["skills-sh:owner/../slug", "Invalid skills.sh skill reference"],
    ["@@demo-owner/weather", "Invalid ClawHub owner handle"],
    ["\u212Aalendar", "Invalid skill slug"],
    [weatherSkillsShRef, "--version is not supported for skills-sh references.", "1.2.3"],
  ] as const)(
    "rejects invalid install reference %s before network access",
    async (reference, error, version?: string) => {
      expect(await install(reference, { version })).toEqual({
        ok: false,
        error: version ? error : expect.stringContaining(error),
      });
      expectUnused(mocks.resolve, mocks.github, mocks.archive);
    },
  );

  it.each([
    {
      installKind: "archive",
      trust: { state: "not-scanned-by-clawhub" },
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
      },
    },
    {
      installKind: "github",
      trust: { state: "scanned-by-clawhub" },
      github: {
        repo: "openclaw/skills",
        path: "skills/weather",
        commit: "a".repeat(40),
        contentHash: "sha256:approved",
        sourceUrl: "https://github.com/openclaw/skills",
      },
    },
  ])(
    "rejects a skills-sh $installKind resolution without pinned unscanned trust",
    async (resolution) => {
      mocks.resolve.mockResolvedValueOnce({ ok: true, slug: "weather", ...resolution });
      expect(await install(weatherSkillsShRef)).toEqual({
        ok: false,
        error: 'Skill "weather" did not resolve to an unscanned, commit-pinned GitHub source.',
      });
      if (resolution.installKind === "archive") {
        expect(mocks.archive).not.toHaveBeenCalled();
      }
      expect(mocks.github).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["install", false],
    ["version conflict with review", true],
  ] as const)(
    "preflights exact artifact identity without workspace mutation: %s",
    async (_name, exists) => {
      const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
      if (exists) {
        mocks.exists.mockImplementation(
          async (input: string) =>
            input.endsWith("SKILL.md") || input.endsWith(path.join("skills", "agentreceipt")),
        );
        denySecurity(["security.status_not_clean"], {
          overview: "Review the skill before updating it.",
          security: { status: "suspicious", passed: false },
        });
      } else {
        mocks.archive.mockResolvedValueOnce(archiveResult(integrity));
      }
      const result = await hub.preflightSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
        version: "1.0.0",
        ...(exists ? { expectedIntegrity: integrity } : {}),
      });
      if (exists) {
        expect(result).toMatchObject({
          ok: false,
          code: "skill_version_conflict",
          integrity,
          warning: expect.stringContaining("Outcome: Review"),
        });
        expect(mocks.archive).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ ok: true, action: "install", integrity });
        expectUnused(mocks.extract, mocks.install);
        expect(mocks.cleanup).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("requires live warning confirmation for a forced Claw-managed update", async () => {
    denySecurity(["security.status_not_clean"], {
      overview: "Review the skill before updating it.",
      security: { status: "suspicious", passed: false },
    });
    const confirmInstall = vi.fn().mockResolvedValue(false);

    expect(
      await install("agentreceipt", {
        version: "1.0.0",
        force: true,
        clawManaged: true,
        confirmInstall,
      }),
    ).toMatchObject({ ok: false, error: "Install cancelled." });
    expect(confirmInstall).toHaveBeenCalledWith(expect.stringContaining("Outcome: Review"));
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("rejects a downloaded skill whose bytes do not match the consented plan", async () => {
    const observed = `sha256-${Buffer.from("b".repeat(64), "hex").toString("base64")}`;
    const expected = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    mocks.archive.mockResolvedValueOnce(archiveResult(observed, "b"));

    expect(
      await install("agentreceipt", {
        version: "1.0.0",
        expectedIntegrity: `sha256:${"a".repeat(64)}`,
      }),
    ).toEqual({
      ok: false,
      error: `ClawHub archive integrity mismatch: expected ${expected}, got ${observed}.`,
    });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it("bypasses ClawHub trust checks for official skill install resolutions", async () => {
    mocks.resolve.mockResolvedValueOnce({
      ok: true,
      slug: "agentreceipt",
      channel: "official",
      isOfficial: true,
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      },
    });
    mocks.verdict.mockRejectedValueOnce(new Error("should not be called"));

    const result = await install();

    hub.expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
    });
    expect(mocks.verdict).not.toHaveBeenCalled();
    expect(mocks.policy.mock.calls[0]?.[0]).toMatchObject({
      origin: { registry: "https://clawhub.ai" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
  });

  it("prints the ClawHub audit and installs releases with a Review outcome", async () => {
    const { logger, warnings } = hub.captureWarnings();
    denySecurity(["security.status_not_clean"], {
      skillUrl: "https://clawhub.ai/acme/skills/agentreceipt",
      securityAuditUrl: "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
      overview:
        "The skill combines gateway and GitHub mutation authority with mutable remote issue content.\n\nReview the requested capabilities before installing.",
      security: { status: "suspicious", passed: false },
    });

    const result = await install("agentreceipt", { logger });

    hub.expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
    const warning = expectDefined(result.warning, "expected Review skill audit output");
    const auditUrl = "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0";
    expectContains(
      warning,
      "ClawHub Security Audit",
      /│ agentreceipt@1\.0\.0[^\n]*\n│\s*│\n│ Outcome: Review/u,
      "Outcome: Review",
      "Overview:",
      "Review the requested capabilities before installing.",
      auditUrl,
    );
    expect(warning.replace(/[│\s]+/gu, " ")).toContain(
      "The skill combines gateway and GitHub mutation authority with mutable remote issue content.",
    );
    expectContains(warnings(), "Outcome: Review", auditUrl);
    expect(warnings()).not.toContain("suspicious");
    expect(warnings()).not.toContain("unsigned");
    expect(mocks.archiveUrl).toHaveBeenCalled();
  });

  it.each([
    {
      name: "unavailable trust checks",
      arrange: () =>
        mocks.verdict.mockRejectedValueOnce(new Error("security verdicts unavailable")),
      errors: ["ClawHub release trust check failed", "security verdicts unavailable"],
    },
    {
      name: "no trust verdict",
      arrange: () =>
        mocks.verdict.mockResolvedValueOnce({
          schema: "clawhub.skill.security-verdicts.v1",
          items: [],
        }),
      errors: ["returned 0 verdicts"],
    },
    {
      name: "omitted security in a passing verdict",
      arrange: () => mockSecurity({ ok: true, decision: "pass", reasons: [] }),
      errors: ["did not return a usable security verdict"],
    },
  ])("fails closed with $name", async ({ arrange, errors }) => {
    arrange();
    const result = await install("agentreceipt");
    hub.expectFailure(result);
    expect(result.code).toBe("clawhub_security_unavailable");
    expectContains(result.error, ...errors);
    expectNoArchiveDownloads();
  });

  it("blocks ClawHub skill installs when moderation marks the release as malware-blocked", async () => {
    const { logger, warnings } = hub.captureWarnings();
    denySecurity(["moderation.malware_blocked"], { security: { status: "clean", passed: false } });

    const result = await install("agentreceipt", { logger });

    hub.expectFailure(result);
    expect(result.error).toBe("ClawHub blocked this release; install was not started.");
    expect(result.code).toBe("clawhub_download_blocked");
    expect(warnings()).toContain("Blocked");
    expect(mocks.archiveUrl).not.toHaveBeenCalled();
  });

  it("installs owner-qualified ClawHub skills without using owner as a local path", async () => {
    hub.mockSkillVerification(hub.unverifiedWeatherVerification);
    hub.mockInstalledSkillFile("# Weather\n");

    const result = await hub.installTestSkill(workspaceDir, "@demo-owner/weather", {
      baseUrl: "https://clawhub.internal.example",
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.warning).toBeUndefined();

    expect(mocks.install.mock.calls[0]?.[0]?.sourceDir).toBe("/tmp/extracted-skill");
    expect(mocks.policy.mock.calls[0]?.[0]).toMatchObject({
      origin: {
        registry: "https://clawhub.internal.example",
        slug: "weather",
        ownerHandle: "demo-owner",
      },
      requestedSpecifier: "clawhub:@demo-owner/weather@1.0.0",
      source: { kind: "clawhub", authority: "third-party", mutable: false, network: true },
    });
    hub.expectInstalledSkill(result, installedFields("weather", "1.0.0"));
    await expect(fs.access(path.join(workspaceDir, "skills", "@demo-owner"))).rejects.toThrow();

    const lock = await readLock(workspaceDir);
    expect(lock.skills.weather).toMatchObject({
      version: "1.0.0",
      registry: "https://clawhub.internal.example",
      ownerHandle: "demo-owner",
    });
    const origin = await readOrigin(workspaceDir, "weather");
    expect(origin).toMatchObject({
      version: 1,
      registry: "https://clawhub.internal.example",
      slug: "weather",
      ownerHandle: "demo-owner",
      installedVersion: "1.0.0",
    });
    expect(lock.skills.weather?.sourceUrl).toBeUndefined();
    expect(origin.sourceUrl).toBeUndefined();
    expect(mocks.telemetry).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.internal.example",
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
    });
  });

  it("does not let owner-qualified fallback mask missing exact versions", async () => {
    denySecurity(["skill.not_found"], {
      requestedSlug: "weather",
      slug: "weather",
      version: null,
      security: null,
      error: { code: "skill_not_found", message: "Skill not found" },
    });
    hub.mockSkillVerification(hub.missingWeatherVersionVerification);

    const result = await install("@demo-owner/weather");

    hub.expectFailure(result);
    expect(result.code).toBe("clawhub_security_unavailable");
    expect(result.error).toContain('returned version "unknown"');
    expectNoArchiveDownloads();
  });

  it("formats ambiguous ClawHub slug responses with owner-qualified guidance", async () => {
    mocks.resolve.mockResolvedValueOnce({
      ok: false,
      slug: "weather",
      reason: "ambiguous_slug",
      message: "Multiple ClawHub publishers provide weather.",
      status: 409,
    });

    const result = await install("weather");

    hub.expectFailure(result);
    expectContains(
      result.error,
      'Skill "weather" is ambiguous on ClawHub.',
      "openclaw skills install @owner/weather",
      "Multiple ClawHub publishers provide weather.",
    );
  });

  it("preserves a shared lock with JSON null instead of installing over it", async () => {
    const damaged = "null";
    const skillDir = await hub.writeTrackedSkill(workspaceDir, "weather", {
      skillMd: "---\nname: weather\n---\n",
    });
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    await fs.writeFile(lockPath, damaged);
    const originalSkill = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");

    for (const slug of ["agentreceipt", "weather"]) {
      expect(
        await hub.installTestSkill(workspaceDir, slug, { force: slug === "weather" }),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("Malformed workspace ClawHub lockfile"),
      });
    }
    expect(mocks.install).not.toHaveBeenCalled();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(damaged);
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expect(fs.stat(path.join(workspaceDir, "skills", "agentreceipt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects damaged .clawhub tracking in update, untracking, status and verification", async () => {
    const error = "Malformed workspace ClawHub lockfile";
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const damaged = '{"version":1,"skills":{"weather":';
    await fs.mkdir(path.dirname(lockPath));
    await fs.writeFile(lockPath, damaged);

    await expect(hub.readTrackedClawHubSkillSlugs(workspaceDir)).rejects.toThrow(error);
    await expect(hub.untrackClawHubSkill(workspaceDir, "weather")).rejects.toThrow(error);
    await expect(hub.updateTestSkill(workspaceDir)).rejects.toThrow(error);
    expect(hub.readClawHubSkillsLockfileStatusSync(workspaceDir)).toMatchObject({
      kind: "malformed",
      path: lockPath,
    });
    await expect(
      hub.resolveClawHubSkillVerificationTarget({ workspaceDir, slug: "weather" }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(error),
    });
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(damaged);
  });

  it("preserves tracking added while a skill is downloading", async () => {
    await hub.writeTrackedSkill(workspaceDir, "weather");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const existing = await hub.readJson<{ skills: Record<string, unknown> }>(lockPath);
    const added = { version: "3.0.0", installedAt: 456, verification: { decision: "pass" } };
    hub.mockInstalledSkillFile("---\nname: agentreceipt\n---\n");
    mocks.archiveUrl.mockImplementationOnce(async () => {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ ...existing, skills: { ...existing.skills, calendar: added } }),
      );
      return archiveResult();
    });

    hub.expectInstalledSkill(await hub.installTestSkill(workspaceDir, "agentreceipt"));
    const installed = await hub.readJson<{ skills: Record<string, unknown> }>(lockPath);
    expect(installed.skills.weather).toEqual(existing.skills.weather);
    expect(installed.skills.calendar).toEqual(added);
    expect(installed.skills.agentreceipt).toMatchObject({ version: "1.0.0" });
  });

  it("rejects symlinked .clawhub tracking without changing the link or its target", async (context) => {
    const target = path.join(workspaceDir, "original.json");
    const content = JSON.stringify({ version: 1, skills: {} });
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    await fs.writeFile(target, content);
    await fs.mkdir(path.dirname(lockPath));
    try {
      await fs.symlink(target, lockPath);
    } catch (error) {
      if (process.platform === "win32" && hasErrnoCode(error, "EPERM")) {
        // Windows file symlinks require a host-granted capability.
        context.skip();
        return;
      }
      throw error;
    }

    await expect(hub.readTrackedClawHubSkillSlugs(workspaceDir)).rejects.toThrow(
      "Malformed workspace ClawHub lockfile",
    );
    expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(content);
  });

  it("reads the replacement tracking when an existing lock changes before open", async () => {
    await hub.writeTrackedSkill(workspaceDir, "weather");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const replacement = path.join(workspaceDir, "replacement.json");
    await fs.writeFile(
      replacement,
      JSON.stringify({ version: 1, skills: { calendar: { version: "2.0.0", installedAt: 123 } } }),
    );
    const open = fs.open.bind(fs);
    let replaced = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!replaced && args[0] === lockPath) {
        replaced = true;
        await fs.rename(replacement, lockPath);
      }
      return await open(...args);
    });
    try {
      await expect(hub.readTrackedClawHubSkillSlugs(workspaceDir)).resolves.toEqual(["calendar"]);
      expect(replaced).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("persists the source URL from server-resolved verification provenance", async () => {
    const sourceUrl = "https://github.com/openclaw/skills/tree/main/agentreceipt";
    const verifiedSourceUrl =
      "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt";
    mocks.verify.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: {
        source: "server-resolved-github-import",
        kind: "github",
        url: sourceUrl,
        repo: "openclaw/skills",
        ref: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "agentreceipt",
        importedAt: 4,
      },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    const skillContent = "# AgentReceipt\n";
    const artifact = { kind: "archive", sha256: "a".repeat(64), integrity: "sha256-test" };
    const skillFile = {
      path: "SKILL.md",
      sha256: createHash("sha256").update(skillContent).digest("hex"),
    };
    hub.mockInstalledSkillFile(skillContent);

    const result = await install("agentreceipt", {
      version: "1.0.0",
    });

    hub.expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
    });
    const lock = await hub.readJson<{ skills: Record<string, Record<string, unknown>> }>(
      path.join(workspaceDir, ".clawhub", "lock.json"),
    );
    expect(lock.skills.agentreceipt).toMatchObject({
      version: "1.0.0",
      registry: "https://clawhub.ai",
      artifact,
      skillFile,
      sourceUrl: verifiedSourceUrl,
      verification: {
        provenance: {
          source: "server-resolved-github-import",
          kind: "github",
          url: sourceUrl,
          repo: "openclaw/skills",
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          path: "agentreceipt",
          importedAt: 4,
        },
      },
    });
    const origin = await hub.readJson<Record<string, unknown>>(
      path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
    );
    expect(origin).toMatchObject({
      version: 1,
      slug: "agentreceipt",
      installedVersion: "1.0.0",
      artifact,
      skillFile,
      sourceUrl: verifiedSourceUrl,
    });
  });

  it("requires a full commit SHA before promoting verified source provenance", () => {
    const baseProvenance = {
      source: "server-resolved-github-import",
      repo: "openclaw/skills",
      path: "agentreceipt",
    };

    for (const [commit, expected] of [
      [
        "0123456789abcdef0123456789abcdef01234567",
        "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt",
      ],
      ["main", undefined],
      ["0123456", undefined],
    ]) {
      expect(hub.readVerifiedClawHubSkillSourceUrl({ ...baseProvenance, commit })).toBe(expected);
    }
  });

  it("does not treat detail metadata as verified source provenance", async () => {
    const warn = vi.fn();
    const sourceUrl = "https://github.com/openclaw/skills/tree/latest/agentreceipt";
    mocks.detail.mockResolvedValueOnce({
      skill: { slug: "agentreceipt", sourceUrl },
      latestVersion: { version: "1.0.0", sourceUrl },
    });
    mocks.verify.mockRejectedValueOnce(new Error("verification down"));
    hub.mockInstalledSkillFile("# AgentReceipt\n");

    hub.expectInstalledSkill(
      await hub.installTestSkill(workspaceDir, "agentreceipt", {
        version: "1.0.0",
        logger: { warn },
      }),
      installedFields("agentreceipt", "1.0.0"),
    );
    const lock = await readLock(workspaceDir);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Skill verification for agentreceipt failed: verification down",
    );
    expect(lock.skills.agentreceipt?.verification).toBeUndefined();
    expect(lock.skills.agentreceipt?.sourceUrl).toBeUndefined();
    const origin = await readOrigin(workspaceDir, "agentreceipt");
    expect(origin.sourceUrl).toBeUndefined();
  });

  it("installs GitHub-backed ClawHub skills from the pinned resolver source path", async () => {
    const commit = "b".repeat(40);
    const paddedCommit = `  ${commit.toUpperCase()}\n`;
    hub.mockGitHubInstallResolution({
      slug: "aiq-deploy",
      repo: "NVIDIA/skills",
      path: "skills/aiq-deploy",
      commit: paddedCommit,
      contentHash: "hash-aiq-deploy",
      sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
    });
    mocks.extract.mockImplementationOnce(async (params) => {
      expect(params.rootMarkers).toBeUndefined();
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    mocks.install.mockResolvedValueOnce({
      ok: true,
      targetDir: path.join(workspaceDir, "skills", "aiq-deploy"),
    });

    const result = await install("aiq-deploy", { forceInstall: true });

    expect(mocks.resolve).toHaveBeenCalledWith({
      slug: "aiq-deploy",
      baseUrl: undefined,
      forceInstall: true,
    });
    // GitHub-backed skills are approved by the install resolver before it
    // returns this pinned commit; they do not have a ClawHub release version.
    expect(mocks.verdict).not.toHaveBeenCalled();
    expect(mocks.github).toHaveBeenCalledWith({ repo: "NVIDIA/skills", commit });
    expect(mocks.install.mock.calls[0]?.[0]?.sourceDir).toBe(
      "/tmp/extracted-github-repo/skills/aiq-deploy",
    );
    expect(mocks.policy.mock.calls[0]?.[0]).toMatchObject({
      origin: {
        registry: "https://clawhub.ai",
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit,
      },
      source: { kind: "git", authority: "third-party", mutable: false, network: true },
    });
    hub.expectInstalledSkill(result, installedFields("aiq-deploy", commit));
  });

  it("rejects a mutable GitHub ref before downloading a ClawHub skill", async () => {
    hub.mockGitHubInstallResolution({
      slug: "aiq-deploy",
      repo: "NVIDIA/skills",
      path: "skills/aiq-deploy",
      commit: "main",
      contentHash: "hash-aiq-deploy",
      sourceUrl: "https://github.com/NVIDIA/skills/tree/main/skills/aiq-deploy",
    });

    const result = await install("aiq-deploy");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("expected a full 40-character commit SHA");
    expectUnused(mocks.github, mocks.extract, mocks.install);
  });

  it("updates skills.sh installs with the stored reference", async () => {
    const commit = "b".repeat(40);
    await hub.writeTrackedSkill(workspaceDir, "weather", {
      requestedReference: weatherSkillsShRef,
      trustState: "not-scanned-by-clawhub",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
    });
    mocks.resolve.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "github",
      trust: { state: "not-scanned-by-clawhub" },
      github: {
        repo: "openclaw/skills",
        path: "skills/weather",
        commit,
        contentHash: "sha256:approved",
        sourceUrl: `https://github.com/openclaw/skills/tree/${commit}/skills/weather`,
      },
    });
    mocks.extract.mockImplementationOnce(async (params) => {
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    hub.mockInstalledSkillFile("# Weather\n");

    const results = await hub.updateTestSkill(workspaceDir, weatherSkillsShRef);

    expect(mocks.resolve).toHaveBeenCalledWith({
      slug: "weather",
      requestedReference: weatherSkillsShRef,
      baseUrl: privateRegistry,
    });
    expect(mocks.verify).toHaveBeenCalledWith({
      slug: "weather",
      requestedReference: weatherSkillsShRef,
      version: undefined,
      baseUrl: privateRegistry,
    });
    expect(results).toEqual([
      { ...updatedFields("weather", commit), warning: "Not scanned by ClawHub" },
    ]);
    const lock = await readLock(workspaceDir);
    expect(lock.skills.weather).toMatchObject({
      requestedReference: weatherSkillsShRef,
      trustState: "not-scanned-by-clawhub",
    });
  });

  it("updates official publisher ClawHub skills without fetching security verdicts", async () => {
    await hub.writeTrackedSkill(workspaceDir, officialSlug, {
      ownerHandle: "nvidia",
      registry: "https://clawhub.ai",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
    });
    mocks.detail.mockResolvedValueOnce({
      skill: { slug: officialSlug },
      owner: { handle: "nvidia", official: true },
      latestVersion: { version: "1.0.0" },
    });
    hub.mockArchiveInstallResolution(
      officialSlug,
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=tao-setup-nvidia-gpu-host&ownerHandle=nvidia&version=1.0.0",
    );
    hub.mockInstalledSkillFile("# NVIDIA\n");

    const results = await hub.updateTestSkill(workspaceDir, "@nvidia/tao-setup-nvidia-gpu-host");

    expect(mocks.detail).toHaveBeenCalledWith({
      slug: officialSlug,
      ownerHandle: "nvidia",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.verdict).not.toHaveBeenCalled();
    expect(results).toEqual([updatedFields(officialSlug, "1.0.0")]);
    expect(mocks.policy.mock.calls[0]?.[0]).toMatchObject({
      origin: { registry: "https://clawhub.ai", ownerHandle: "nvidia" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
  });

  it("explains that a malicious skill update will not be downloaded (@acme/agentreceipt)", async () => {
    const tempRoot = await hub.tempDirs.make("openclaw-skill-malicious-update-");
    const quotedWorkspace = path.join(tempRoot, "agent's $(printf PWN) state");
    const { logger, warnings } = hub.captureWarnings();
    await hub.writeTrackedSkill(quotedWorkspace, "agentreceipt", {
      ownerHandle: "acme",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
    });
    denySecurity(["scan:malicious"], {
      publisherHandle: "acme",
      security: { status: "malicious", passed: false },
    });

    expect(await hub.updateTestSkill(quotedWorkspace, "@acme/agentreceipt", { logger })).toEqual([
      expect.objectContaining({
        ok: false,
        code: "clawhub_download_blocked",
        error: "ClawHub blocked this release; update was not started.",
      }),
    ]);
    expectContains(warnings(), "ClawHub Security Audit", "Outcome: Blocked", "Overview:");
    expect(warnings()).not.toContain('replying "Update"');
    expectUnused(mocks.archiveUrl, mocks.archive);
  });

  it("refuses to update a ClawHub skill whose SKILL.md is unreadable unless forced", async () => {
    const skillDir = await hub.writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillFile: {
        path: "SKILL.md",
        sha256: createHash("sha256").update("# Weather\n").digest("hex"),
      },
      fileTreeSha256: `sha256:${"a".repeat(64)}`,
    });
    await fs.mkdir(path.join(skillDir, "SKILL.md"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md", "notes.txt"), "local content\n", "utf8");

    expect(await hub.updateTestSkill(workspaceDir, "weather")).toEqual([
      expect.objectContaining({
        ok: false,
        code: "force_required",
        error: expect.stringContaining("EISDIR"),
      }),
    ]);
    expect(mocks.install).not.toHaveBeenCalled();
    expectNoArchiveDownloads();
    expect(await fs.readFile(path.join(skillDir, "SKILL.md", "notes.txt"), "utf8")).toBe(
      "local content\n",
    );
  });

  it("requires a one-time force for tracked skills without recorded digests, then verifies digests", async () => {
    const skillDir = await hub.writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Weather\n", "utf8");
    mocks.exists.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );
    mocks.resolve.mockResolvedValue({
      ok: true,
      slug: "weather",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
      },
    });
    mocks.install.mockImplementation(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    expect(await hub.updateTestSkill(workspaceDir, "weather")).toEqual([
      {
        ok: false,
        code: "force_required",
        error:
          'Skill "weather" was installed before OpenClaw recorded file fingerprints, so local changes cannot be detected. Updating replaces the installed skill directory.',
      },
    ]);

    expect(await hub.updateTestSkill(workspaceDir, "weather", { force: true })).toEqual([
      expect.objectContaining({ ok: true, slug: "weather", version: "1.0.0" }),
    ]);
    const lock = await readLock(workspaceDir);
    expect(lock.skills.weather?.skillFile).toMatchObject({ path: "SKILL.md" });
    expect(lock.skills.weather?.fileTreeSha256).toBe(`sha256:${"a".repeat(64)}`);

    expect(await hub.updateTestSkill(workspaceDir, "weather")).toEqual([
      expect.objectContaining({ ok: true, slug: "weather", version: "1.0.0" }),
    ]);
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });

  it("rejects untracked requested updates instead of installing by slug", async () => {
    expect(await hub.updateTestSkill(workspaceDir, "calendar")).toEqual([
      { ok: false, error: 'Skill "calendar" is not tracked as a ClawHub install.' },
    ]);
    expectUnused(mocks.resolve, mocks.install);
  });

  describe("verification target resolution", () => {
    it("preserves installed skills.sh references for verification", async () => {
      const skillDir = await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
        requestedReference: skillsShRef,
        trustState: "not-scanned-by-clawhub",
        registry: "https://private.example.com/clawhub/",
        installedVersion: "2.0.0",
      });

      await expect(verify(skillsShRef)).resolves.toEqual({
        ok: true,
        slug: "agentreceipt",
        requestedReference: skillsShRef,
        trustState: "not-scanned-by-clawhub",
        baseUrl: privateRegistry,
        version: undefined,
        tag: undefined,
        resolution: {
          source: "installed",
          selector: "installed-version",
          registry: privateRegistry,
          skillDir,
          installedVersion: "2.0.0",
        },
      });
    });

    it.each([
      { installed: false, version: "2.0.0", tag: undefined },
      { installed: true, version: undefined, tag: "latest" },
    ])(
      "rejects selectors for skills.sh verification (installed=$installed)",
      async ({ installed, version, tag }) => {
        if (installed) {
          await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
            requestedReference: skillsShRef,
            trustState: "not-scanned-by-clawhub",
            installedVersion: "a".repeat(40),
          });
        }
        await expect(
          verify(installed ? "agentreceipt" : skillsShRef, { version, tag }),
        ).resolves.toEqual({
          ok: false,
          error: "--version and --tag are not supported for skills-sh references.",
        });
      },
    );

    it("keeps the installed registry when an explicit tag is provided", async () => {
      await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
        installedVersion: "2.0.0",
      });

      await expect(
        verify("agentreceipt", { tag: "beta", baseUrl: "https://clawhub.ai" }),
      ).resolves.toMatchObject({
        ok: true,
        slug: "agentreceipt",
        baseUrl: privateRegistry,
        version: undefined,
        tag: "beta",
        resolution: {
          source: "installed",
          selector: "tag",
          registry: privateRegistry,
          installedVersion: "2.0.0",
        },
      });
    });

    it.each([
      ["untracked origin", { writeLock: false }, "not tracked by the workspace ClawHub lockfile"],
      ["different slug", { originSlug: "trusted-skill" }, 'origin metadata for "trusted-skill"'],
      [
        "different registry",
        { lockFields: { registry: "https://other.example.com/clawhub" } },
        "does not match the workspace ClawHub lockfile",
      ],
      ["missing origin", {}, "missing ClawHub origin metadata"],
      ["malformed origin", { writeLock: false }, "Malformed ClawHub origin metadata"],
      [
        "different skills.sh reference",
        {
          requestedReference: "skills-sh:owner-a/repo-a/agentreceipt",
          trustState: "not-scanned-by-clawhub",
          installedVersion: "a".repeat(40),
        },
        'Skill "agentreceipt" is not tracked from skills-sh:owner-b/repo-b/agentreceipt.',
        "agentreceipt",
        "skills-sh:owner-b/repo-b/agentreceipt",
      ],
      [
        "different owner",
        { ownerHandle: "demo-owner" },
        "is tracked as @demo-owner/weather",
        "weather",
        "@other-owner/weather",
      ],
    ] as const)(
      "rejects %s",
      async (name, fixture, error, slug = "agentreceipt", requestedSlug: string = slug) => {
        const skillDir = await hub.writeTrackedSkill(workspaceDir, slug, fixture);
        if (name === "missing origin") {
          await fs.unlink(path.join(skillDir, ".clawhub/origin.json"));
        }
        if (name === "malformed origin") {
          await fs.writeFile(path.join(skillDir, ".clawhub/origin.json"), "{not json", "utf8");
        }
        const result = await verify(requestedSlug);
        hub.expectFailure(result);
        if (name === "different skills.sh reference") {
          expect(result).toEqual({ ok: false, error });
          expect(mocks.verify).not.toHaveBeenCalled();
        } else {
          expect(result.error).toContain(error);
        }
        if (name === "different owner") {
          expect(result.error).toContain("not @other-owner/weather");
        }
        if (name === "malformed origin") {
          expect(result.error).toContain(path.join(skillDir, ".clawhub/origin.json"));
        }
      },
    );

    it.each([
      { selector: "latest", version: undefined, tag: undefined },
      { selector: "version", version: "2.0.0", tag: undefined },
      { selector: "tag", version: undefined, tag: "beta" },
    ])(
      "uses owner-qualified registry verification with $selector",
      async ({ selector, version, tag }) => {
        mocks.baseUrl.mockReturnValueOnce("https://configured.example.com/clawhub");
        await expect(
          verify("@demo-owner/weather", {
            baseUrl: "https://configured.example.com/clawhub/",
            version,
            tag,
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          baseUrl: "https://configured.example.com/clawhub",
          version,
          tag,
          resolution: {
            source: "registry",
            selector,
            registry: "https://configured.example.com/clawhub",
            skillDir: undefined,
            installedVersion: undefined,
          },
        });
      },
    );

    it("fails clearly for invalid slugs and conflicting selectors", async () => {
      await expect(verify("bad/slug")).resolves.toMatchObject({
        ok: false,
        error: "Invalid skill slug: bad/slug",
      });

      await expect(
        verify("agentreceipt", { version: "1.0.0", tag: "latest" }),
      ).resolves.toMatchObject({ ok: false, error: "Use either --version or --tag." });
    });
  });
});

describe("ClawHub origin provenance readback", () => {
  const readLink = (workspaceDir: string, skillDir: string) =>
    hub.resolveClawHubSkillStatusLinkSync({ workspaceDir, skillDir, skillKey: "agentreceipt" });
  it("restores matching provenance and rejects one-sided origin edits", async () => {
    await withTempDir("openclaw-origin-prov-", async (workspaceDir) => {
      const artifact = {
        kind: "clawpack" as const,
        sha256: "a".repeat(64),
        integrity: "sha256-test",
      };
      const skillFile = { path: "SKILL.md", sha256: "b".repeat(64) };
      const sourceUrl = "https://github.com/acme/skills/tree/abc/agentreceipt";
      const provenance = { ownerHandle: "acme", sourceUrl, artifact, skillFile };
      const skillDir = await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
        registry: "https://clawhub.ai",
        installedVersion: "1.0.0",
        originFields: provenance,
        lockFields: provenance,
      });
      const origin = await readOrigin(workspaceDir, "agentreceipt");

      const link = readLink(workspaceDir, skillDir);

      expect(link).toMatchObject({ status: "linked", valid: true, ownerHandle: "acme", sourceUrl });
      if (link?.status !== "linked") {
        throw new Error(`expected linked status, got ${link?.status}`);
      }
      expect([link.artifact, link.skillFile]).toEqual([artifact, skillFile]);

      const originPath = path.join(skillDir, ".clawhub", "origin.json");
      for (const override of [
        { sourceUrl: "https://github.com/acme/skills/tree/tampered/agentreceipt" },
        { artifact: { kind: "clawpack", sha256: "c".repeat(64), integrity: "sha256-tampered" } },
        { skillFile: { path: "SKILL.md", sha256: "d".repeat(64) } },
      ]) {
        await fs.writeFile(
          originPath,
          `${JSON.stringify({ ...origin, ...override }, null, 2)}\n`,
          "utf8",
        );
        expect(readLink(workspaceDir, skillDir)).toMatchObject({
          status: "invalid",
          valid: false,
          reason: expect.stringContaining("does not match the workspace ClawHub lockfile"),
        });
      }
    });
  });

  it("drops malformed provenance fields while keeping the link valid", async () => {
    await withTempDir("openclaw-origin-prov-", async (workspaceDir) => {
      const skillDir = await hub.writeTrackedSkill(workspaceDir, "agentreceipt", {
        registry: "https://clawhub.ai",
        installedVersion: "1.0.0",
        originFields: {
          sourceUrl: "   ",
          artifact: { kind: "bogus", sha256: 42, integrity: "" },
          skillFile: { path: "", sha256: "c".repeat(64) },
        },
      });

      const link = readLink(workspaceDir, skillDir);
      expect(link?.status).toBe("linked");
      if (link?.status !== "linked") {
        throw new Error(`expected linked status, got ${link?.status}`);
      }
      expect(link.artifact).toBeUndefined();
      expect(link.skillFile).toBeUndefined();
      expect(link.sourceUrl).toBeUndefined();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
