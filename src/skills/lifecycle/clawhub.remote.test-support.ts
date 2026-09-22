import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  fetchClawHubSkillInstallResolutionMock,
  downloadClawHubSkillArchiveUrlMock,
  archiveCleanupMock,
  withExtractedArchiveRootMock,
  installPackageDirMock,
  evaluateSkillInstallPolicyMock,
  pathExistsMock,
  digestClawHubSkillTreeMock,
  tempDirs,
  bindHostWorkspace,
  expectInstalledSkill,
  installTestSkill,
  updateTestSkill,
  mockArchiveInstallResolution,
  writeTrackedSkill,
  readClawHubSkillsLockfile,
  preflightSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  updateSkillsFromClawHub,
} from "./clawhub.test-support.js";

/** Uses the existing ClawHub suite fixture to exercise a distinct workspace host. */
export function registerRemoteClawHubTests(getWorkspaceDir: () => string) {
  it("preserves local ClawHub inventory and updates for document-only adapters", async () => {
    const workspaceDir = getWorkspaceDir();
    await writeTrackedSkill(workspaceDir, "weather", { installedVersion: "1.0.0" });
    const expectedUpdate = await updateSkillsFromClawHub({ workspaceDir, slug: "weather" });
    const release = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    });
    try {
      expect(await readTrackedClawHubSkillSlugs(workspaceDir)).toEqual(["weather"]);
      expect(
        await resolveClawHubSkillVerificationTarget({ workspaceDir, slug: "weather" }),
      ).toMatchObject({ ok: true, version: "1.0.0" });
      expect(await updateSkillsFromClawHub({ workspaceDir, slug: "weather" })).toEqual(
        expectedUpdate,
      );
    } finally {
      release();
    }
  });

  it("installs and reuses a host skill without reading or writing Gateway tracking", async () => {
    const host = await tempDirs.make("openclaw-clawhub-host-");
    const source = await tempDirs.make("openclaw-clawhub-source-");
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    await fs.mkdir(path.join(getWorkspaceDir(), ".clawhub"));
    await fs.writeFile(path.join(getWorkspaceDir(), ".clawhub/lock.json"), "stale Gateway copy");
    await fs.writeFile(path.join(source, "SKILL.md"), "# Host skill\n");
    pathExistsMock.mockImplementation(async (file: string) =>
      fs.access(file).then(
        () => true,
        () => false,
      ),
    );
    withExtractedArchiveRootMock.mockImplementation(async (params) => params.onExtracted(source));
    installPackageDirMock.mockImplementation(async ({ sourceDir, targetDir }) => {
      await fs.cp(sourceDir, targetDir, { recursive: true });
      return { ok: true };
    });
    downloadClawHubSkillArchiveUrlMock.mockResolvedValueOnce({
      archivePath: "/tmp/agentreceipt.zip",
      integrity,
      sha256Hex: "a".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });
    const release = bindHostWorkspace(getWorkspaceDir(), host);
    try {
      const result = await installTestSkill(getWorkspaceDir(), "agentreceipt");
      expectInstalledSkill(result, { targetDir: path.join(host, "skills/agentreceipt") });
      expect(await fs.readFile(path.join(host, "skills/agentreceipt/SKILL.md"), "utf8")).toBe(
        "# Host skill\n",
      );
      const lock = JSON.parse(await fs.readFile(path.join(host, ".clawhub/lock.json"), "utf8"));
      expect(lock.skills.agentreceipt).toMatchObject({
        version: "1.0.0",
        skillFile: { path: "SKILL.md" },
      });
      expect(await fs.readFile(path.join(getWorkspaceDir(), ".clawhub/lock.json"), "utf8")).toBe(
        "stale Gateway copy",
      );
      await expect(fs.stat(path.join(getWorkspaceDir(), "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(evaluateSkillInstallPolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({ sourceDir: source }),
      );
      await expect(
        preflightSkillFromClawHub({
          workspaceDir: getWorkspaceDir(),
          slug: "agentreceipt",
          version: "1.0.0",
          expectedIntegrity: integrity,
        }),
      ).resolves.toEqual({ ok: true, action: "reuse", integrity });
    } finally {
      release();
    }
  });

  it("rejects damaged host tracking before downloading, even with an empty Gateway workspace", async () => {
    const host = await tempDirs.make("openclaw-clawhub-host-damaged-");
    await fs.mkdir(path.join(host, ".clawhub"));
    await fs.writeFile(path.join(host, ".clawhub/lock.json"), "broken");
    const release = bindHostWorkspace(getWorkspaceDir(), host);
    try {
      const result = await installTestSkill(getWorkspaceDir(), "agentreceipt");
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Malformed workspace ClawHub lockfile"),
      });
      expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
      expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it.each(["clean", "edited", "force", "during-download"] as const)(
    "updates host tracking and preserves the native %s behavior without Gateway files",
    async (scenario) => {
      const host = await tempDirs.make("openclaw-update-host-");
      const skillDir = await writeTrackedSkill(host, "weather", {
        installedVersion: "0.9.0",
        skillMd: "# Weather\n",
      });
      // The backup checker calls the real digest in its own module; use real
      // fingerprints so this test exercises a successful check as well as refusals.
      const { digestClawHubSkillTree } =
        await vi.importActual<typeof import("./skill-tree-digest.js")>("./skill-tree-digest.js");
      const fileTreeSha256 = await digestClawHubSkillTree(skillDir);
      for (const metadata of [
        path.join(skillDir, ".clawhub/origin.json"),
        path.join(host, ".clawhub/lock.json"),
      ]) {
        const value = JSON.parse(await fs.readFile(metadata, "utf8"));
        if (value.skills) {
          value.skills.weather.fileTreeSha256 = fileTreeSha256;
        } else {
          value.fileTreeSha256 = fileTreeSha256;
        }
        await fs.writeFile(metadata, JSON.stringify(value));
      }
      if (scenario === "clean" || scenario === "during-download") {
        digestClawHubSkillTreeMock.mockResolvedValueOnce(fileTreeSha256);
      }
      await fs.mkdir(path.join(getWorkspaceDir(), ".clawhub"));
      await fs.writeFile(path.join(getWorkspaceDir(), ".clawhub/lock.json"), "stale Gateway copy");
      pathExistsMock.mockImplementation(
        async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
      );
      mockArchiveInstallResolution(
        "weather",
        "1.0.0",
        "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
      );
      if (scenario === "edited" || scenario === "force") {
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Local edits\n");
      }
      if (scenario === "during-download") {
        downloadClawHubSkillArchiveUrlMock.mockImplementationOnce(async () => {
          await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Local edits\n");
          return {
            archivePath: "/tmp/weather.zip",
            integrity: "sha256-test",
            sha256Hex: "a".repeat(64),
            artifact: "archive",
            cleanup: archiveCleanupMock,
          };
        });
      }
      const release = bindHostWorkspace(getWorkspaceDir(), host);
      try {
        expect(await readTrackedClawHubSkillSlugs(getWorkspaceDir())).toEqual(["weather"]);
        const results = await updateTestSkill(getWorkspaceDir(), undefined, {
          force: scenario === "force",
        });
        if (scenario === "edited" || scenario === "during-download") {
          expect(results).toEqual([expect.objectContaining({ ok: false, code: "force_required" })]);
          expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(
            "# Local edits\n",
          );
          expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledTimes(
            scenario === "edited" ? 0 : 1,
          );
        } else {
          expect(results).toEqual([
            expect.objectContaining({
              ok: true,
              slug: "weather",
              previousVersion: "0.9.0",
              version: "1.0.0",
            }),
          ]);
          expect(installPackageDirMock).toHaveBeenCalledWith(
            expect.objectContaining({ targetDir: skillDir }),
          );
          const lock = await readClawHubSkillsLockfile(host);
          expect(lock.skills.weather).toMatchObject({ version: "1.0.0" });
        }
        expect(await fs.readFile(path.join(getWorkspaceDir(), ".clawhub/lock.json"), "utf8")).toBe(
          "stale Gateway copy",
        );
      } finally {
        release();
      }
    },
  );

  it("uses host origin when checking an owner-qualified update", async () => {
    const host = await tempDirs.make("openclaw-update-host-owner-");
    await writeTrackedSkill(host, "weather", {
      ownerHandle: "other-owner",
      installedVersion: "0.9.0",
    });
    const release = bindHostWorkspace(getWorkspaceDir(), host);
    try {
      await expect(
        updateSkillsFromClawHub({ workspaceDir: getWorkspaceDir(), slug: "@demo-owner/weather" }),
      ).rejects.toThrow(
        'Skill "weather" is tracked as @other-owner/weather, not @demo-owner/weather.',
      );
      expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("verifies the host-installed version despite an empty Gateway workspace", async () => {
    const host = await tempDirs.make("openclaw-verify-host-");
    const skillDir = await writeTrackedSkill(host, "weather", {
      ownerHandle: "demo-owner",
      installedVersion: "0.9.0",
      registry: "https://installed.example.test/registry",
    });
    const release = bindHostWorkspace(getWorkspaceDir(), host);
    try {
      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: getWorkspaceDir(),
          slug: "@demo-owner/weather",
        }),
      ).resolves.toMatchObject({
        ok: true,
        ownerHandle: "demo-owner",
        version: "0.9.0",
        baseUrl: "https://installed.example.test/registry",
        resolution: { source: "installed", selector: "installed-version", skillDir },
      });
      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: getWorkspaceDir(),
          slug: "@demo-owner/weather",
          version: "2.0.0",
        }),
      ).resolves.toMatchObject({
        ok: true,
        version: "2.0.0",
        baseUrl: "https://installed.example.test/registry",
        resolution: { source: "installed", selector: "version", installedVersion: "0.9.0" },
      });
      await fs.writeFile(path.join(host, ".clawhub/lock.json"), "damaged tracking");
      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: getWorkspaceDir(),
          slug: "@demo-owner/weather",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("Malformed workspace ClawHub lockfile"),
      });
    } finally {
      release();
    }
  });
}
