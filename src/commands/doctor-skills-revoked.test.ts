import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  fetchOpenClawSkillSecurityVerdicts: vi.fn(),
}));

vi.mock("../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));

vi.mock("../skills/security/clawhub-verdicts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/security/clawhub-verdicts.js")>();
  return {
    ...actual,
    fetchOpenClawSkillSecurityVerdicts: mocks.fetchOpenClawSkillSecurityVerdicts,
  };
});

const { maybeRepairRevokedClawHubSkills } = await import("./doctor-skills.js");

function makePrompter(shouldRepair: boolean) {
  return {
    confirmAutoFix: vi.fn(async () => shouldRepair),
  };
}

async function writeTrackedSkill(params: { workspaceDir: string; legacy?: boolean }) {
  const dotDir = params.legacy ? ".clawdhub" : ".clawhub";
  const skillDir = path.join(params.workspaceDir, "skills", "demo");
  await fs.mkdir(path.join(skillDir, dotDir), { recursive: true });
  await fs.mkdir(path.join(params.workspaceDir, dotDir), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\n", "utf8");
  await fs.writeFile(
    path.join(skillDir, dotDir, "origin.json"),
    JSON.stringify({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "demo",
      installedVersion: "1.0.0",
      installedAt: 10,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(params.workspaceDir, dotDir, "lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        demo: {
          version: "1.0.0",
          installedAt: 10,
        },
      },
    }),
    "utf8",
  );
  return skillDir;
}

function configureStatusReport(workspaceDir: string, skillDir: string) {
  mocks.buildWorkspaceSkillStatus.mockImplementation((requestedWorkspaceDir: string) => {
    if (requestedWorkspaceDir !== workspaceDir) {
      return { workspaceDir: requestedWorkspaceDir, managedSkillsDir: "", skills: [] };
    }
    return {
      workspaceDir,
      managedSkillsDir: "",
      agentId: "main",
      skills: [
        {
          baseDir: skillDir,
          skillKey: "demo",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "demo",
            installedVersion: "1.0.0",
            installedAt: 10,
            originPath: path.join(skillDir, ".clawhub", "origin.json"),
            lockPath: path.join(workspaceDir, ".clawhub", "lock.json"),
          },
        },
      ],
    };
  });
}

function revokedVerdict() {
  return {
    registry: "https://clawhub.ai",
    ok: false,
    decision: "fail",
    reasons: ["version.revoked"],
    requestedSlug: "demo",
    requestedVersion: "1.0.0",
    revocation: { revoked: true, revokedAt: 20 },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("doctor revoked ClawHub skills", () => {
  it("moves a confirmed revoked version outside active skills and untracks it", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockResolvedValue([revokedVerdict()]);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: makePrompter(true) as never,
      });

      await expect(fs.stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantineEntries = await fs.readdir(
        path.join(workspaceDir, ".clawhub", "quarantine", "skills"),
      );
      expect(quarantineEntries).toHaveLength(1);
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, unknown> };
      expect(lock.skills).toEqual({});
    });
  });

  it("preserves legacy lock and origin compatibility while quarantining", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-legacy-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir, legacy: true });
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockResolvedValue([revokedVerdict()]);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: makePrompter(true) as never,
      });

      await expect(fs.stat(skillDir)).rejects.toMatchObject({ code: "ENOENT" });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, unknown> };
      expect(lock.skills).toEqual({});
    });
  });

  it("never moves a skill when the revocation lookup fails", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-offline-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockRejectedValue(new Error("offline"));
      const prompter = makePrompter(true);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: prompter as never,
      });

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
      expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    });
  });

  it("never moves a skill for an inconsistent revocation response", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-malformed-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockResolvedValue([
        {
          ...revokedVerdict(),
          ok: true,
          decision: "pass",
          reasons: [],
        },
      ]);
      const prompter = makePrompter(true);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: prompter as never,
      });

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
      expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    });
  });

  it("revalidates lock identity before moving a confirmed revoked skill", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-race-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockImplementation(async () => {
        await fs.writeFile(
          path.join(workspaceDir, ".clawhub", "lock.json"),
          JSON.stringify({
            version: 1,
            skills: { demo: { version: "2.0.0", installedAt: 11 } },
          }),
          "utf8",
        );
        return [revokedVerdict()];
      });

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: makePrompter(true) as never,
      });

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
    });
  });

  it("does not move a revoked skill through a quarantine path that escapes the workspace", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-path-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      const outsideDir = path.join(path.dirname(workspaceDir), "outside-quarantine");
      await fs.mkdir(outsideDir);
      await fs.symlink(
        outsideDir,
        path.join(workspaceDir, ".clawhub", "quarantine"),
        process.platform === "win32" ? "junction" : "dir",
      );
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockResolvedValue([revokedVerdict()]);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: makePrompter(true) as never,
      });

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
      await expect(fs.stat(path.join(outsideDir, "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("does not move a revoked skill through a quarantine path inside active skills", async () => {
    await withTempDir({ prefix: "openclaw-doctor-revoked-active-path-" }, async (workspaceDir) => {
      const skillDir = await writeTrackedSkill({ workspaceDir });
      await fs.symlink(
        path.join(workspaceDir, "skills"),
        path.join(workspaceDir, ".clawhub", "quarantine"),
        process.platform === "win32" ? "junction" : "dir",
      );
      configureStatusReport(workspaceDir, skillDir);
      mocks.fetchOpenClawSkillSecurityVerdicts.mockResolvedValue([revokedVerdict()]);

      await maybeRepairRevokedClawHubSkills({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        prompter: makePrompter(true) as never,
      });

      await expect(fs.stat(skillDir)).resolves.toBeDefined();
      await expect(fs.stat(path.join(workspaceDir, "skills", "skills"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
