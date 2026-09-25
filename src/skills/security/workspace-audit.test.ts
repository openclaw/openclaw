// Workspace audit tests cover security audit results for workspace skill folders.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { AsyncTempCaseFactory } from "../../security/test-temp-cases.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./workspace-audit.js";

const isWindows = process.platform === "win32";

describe("security audit workspace skill path escape findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-workspace-");

  function requireFinding(
    findings: Awaited<ReturnType<typeof collectWorkspaceSkillSymlinkEscapeFindings>>,
    checkId: string,
  ) {
    const finding = findings.find((entry) => entry.checkId === checkId);
    if (!finding) {
      throw new Error(`expected security finding ${checkId}`);
    }
    return finding;
  }

  beforeAll(async () => {
    await tempCases.setup();
  });

  afterAll(async () => {
    await tempCases.cleanup();
  });

  it("evaluates workspace skill path escape findings", async () => {
    const runs = [
      !isWindows
        ? (async () => {
            const tmp = await tempCases.makeTmpDir("workspace-skill-symlink-escape");
            const workspaceDir = path.join(tmp, "workspace");
            const outsideDir = path.join(tmp, "outside");
            await fs.mkdir(path.join(workspaceDir, "skills", "leak"), { recursive: true });
            await fs.mkdir(outsideDir, { recursive: true });
            const outsideSkillPath = path.join(outsideDir, "SKILL.md");
            await fs.writeFile(outsideSkillPath, "# outside\n", "utf-8");
            await fs.symlink(
              outsideSkillPath,
              path.join(workspaceDir, "skills", "leak", "SKILL.md"),
            );
            const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
              cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
            });
            const finding = requireFinding(findings, "skills.workspace.symlink_escape");
            expect(finding.severity).toBe("warn");
            expect(finding.detail).toContain(outsideSkillPath);
          })()
        : Promise.resolve(),
      (async () => {
        const tmp = await tempCases.makeTmpDir("workspace-skill-in-root");
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "safe"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, "skills", "safe", "SKILL.md"),
          "# in workspace\n",
          "utf-8",
        );
        const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        });
        expect(findings.map((entry) => entry.checkId)).not.toContain(
          "skills.workspace.symlink_escape",
        );
      })(),
    ];

    await Promise.all(runs);
  });

  it.runIf(!isWindows)(
    "audits every explicit workspace when malformed defaults prevent default resolution",
    async () => {
      const tmp = await tempCases.makeTmpDir("workspace-skill-malformed-roster");
      const workspaceA = path.join(tmp, "workspace-a");
      const workspaceB = path.join(tmp, "workspace-b");
      const outsideA = path.join(tmp, "outside-a.md");
      const outsideB = path.join(tmp, "outside-b.md");
      await fs.writeFile(outsideA, "# outside a\n", "utf-8");
      await fs.writeFile(outsideB, "# outside b\n", "utf-8");
      for (const [workspaceDir, outsidePath] of [
        [workspaceA, outsideA],
        [workspaceB, outsideB],
      ] as const) {
        const skillDir = path.join(workspaceDir, "skills", "leak");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.symlink(outsidePath, path.join(skillDir, "SKILL.md"));
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            alpha: { default: true, workspace: workspaceA },
            beta: { default: true, workspace: workspaceB },
          },
        },
      };

      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({ cfg });
      const detail = findings
        .filter((finding) => finding.checkId === "skills.workspace.symlink_escape")
        .map((finding) => finding.detail)
        .join("\n");
      expect(detail).toContain(outsideA);
      expect(detail).toContain(outsideB);
    },
  );

  it("treats an unresolvable realpath (timeout/error simulation) as a potential symlink escape", async () => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-realpath-unresolvable");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsDir = path.join(workspaceDir, "skills", "suspect-skill");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "SKILL.md"), "# suspect\n", "utf-8");

    // Simulate realpath failing for the skill file path — this mirrors what
    // happens when a slow/hanging NFS or SMB mount causes the 2 s deadline in
    // realpathWithTimeout to fire. The .catch(() => null) inside the helper
    // converts any rejection to null, which is the same signal produced by a
    // genuine timeout. All other paths resolve to their string value so the
    // workspace-root detection works normally.
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: unknown): Promise<string> => {
        if (String(p).endsWith("SKILL.md")) {
          throw new Error("simulated realpath timeout");
        }
        return String(p);
      });

    try {
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
      });
      const escapeFinding = requireFinding(findings, "skills.workspace.symlink_escape");
      expect(escapeFinding.severity).toBe("warn");
      // The finding must call out that realpath was unverifiable, not that it
      // resolved to a path outside the workspace.
      expect(escapeFinding.detail).toContain("realpath timed out");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "directory visit cap",
      directories: ["a", "b", "c"],
      files: [],
      limits: { maxDirVisits: 2 },
      truncated: true,
    },
    {
      name: "file cap",
      directories: ["a", "b"],
      files: ["a/SKILL.md", "b/SKILL.md"],
      limits: { maxFiles: 1 },
      truncated: true,
    },
    {
      name: "exact file cap with excluded directories",
      directories: ["a", ".hidden", "node_modules"],
      files: ["a/SKILL.md", ".hidden/SKILL.md", "node_modules/SKILL.md"],
      limits: { maxFiles: 1 },
      truncated: false,
    },
  ])("reports scan completeness for $name", async ({ directories, files, limits, truncated }) => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-capped");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsRoot = path.join(workspaceDir, "skills");
    await Promise.all(
      directories.map((directory) =>
        fs.mkdir(path.join(skillsRoot, directory), { recursive: true }),
      ),
    );
    await Promise.all(files.map((file) => fs.writeFile(path.join(skillsRoot, file), "# skill\n")));

    const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
      skillScanLimits: limits,
    });
    expect(findings.some((finding) => finding.checkId === "skills.workspace.scan_truncated")).toBe(
      truncated,
    );
    if (truncated) {
      const finding = requireFinding(findings, "skills.workspace.scan_truncated");
      expect(finding.severity).toBe("warn");
      expect(finding.detail).toContain(workspaceDir);
    }
  });

  it.each(["", "blocked"])(
    "reports an unreadable skills directory %j as incomplete",
    async (relative) => {
      const tmp = await tempCases.makeTmpDir("workspace-skill-unreadable");
      const workspaceDir = path.join(tmp, "workspace");
      const unreadableDir = path.join(workspaceDir, "skills", relative);
      await fs.mkdir(unreadableDir, { recursive: true });
      await fs.writeFile(path.join(unreadableDir, "SKILL.md"), "# skill\n");
      const readDirectory = fs.readdir.bind(fs);
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (path.resolve(String(args[0])) === unreadableDir) {
          throw Object.assign(new Error("directory unavailable"), { code: "EACCES" });
        }
        return readDirectory(...args);
      });

      try {
        const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        });
        expect(requireFinding(findings, "skills.workspace.scan_truncated").severity).toBe("warn");
      } finally {
        readdirSpy.mockRestore();
      }
    },
  );
});
