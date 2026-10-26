import fs from "node:fs/promises";
import path from "node:path";
import * as directoryWalker from "@openclaw/fs-safe/walk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfigWithLegacyRoster } from "../../config/legacy.roster.js";
import { AsyncTempCaseFactory } from "../../security/test-temp-cases.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./workspace-audit.js";

const isWindows = process.platform === "win32";
vi.mock("@openclaw/fs-safe/walk", async (importOriginal) => {
  const actual = await importOriginal<typeof directoryWalker>();
  return { ...actual, walkDirectory: vi.fn(actual.walkDirectory) };
});
const { walkDirectory: actualWalk } =
  await vi.importActual<typeof directoryWalker>("@openclaw/fs-safe/walk");

describe("security audit workspace skill path escape findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-workspace-");

  async function makeWorkspace(name: string, files = ["safe/SKILL.md"], dirs: string[] = []) {
    const workspaceDir = path.join(await tempCases.makeTmpDir(name), "workspace");
    const skillsRoot = path.join(workspaceDir, "skills");
    for (const directory of dirs) {
      await fs.mkdir(path.join(skillsRoot, directory), { recursive: true });
    }
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(skillsRoot, file)), { recursive: true });
      await fs.writeFile(path.join(skillsRoot, file), "# skill\n");
    }
    return workspaceDir;
  }

  async function linkOutsideSkill(workspaceDir: string) {
    const outsidePath = path.resolve(workspaceDir, "..", "outside.md");
    const skillDir = path.join(workspaceDir, "skills", "leak");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(outsidePath, "# outside\n");
    await fs.symlink(outsidePath, path.join(skillDir, "SKILL.md"));
    return outsidePath;
  }

  function audit(workspaceDir: string) {
    return collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
    });
  }

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

  beforeAll(() => tempCases.setup());
  afterAll(() => tempCases.cleanup());
  afterEach(() => vi.restoreAllMocks());

  it("evaluates workspace skill path escape findings", async () => {
    const findings = await audit(await makeWorkspace("workspace-skill-in-root"));
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.symlink_escape");
    if (!isWindows) {
      const workspaceDir = await makeWorkspace("workspace-skill-symlink-escape", []);
      const outsideSkillPath = await linkOutsideSkill(workspaceDir);
      const finding = requireFinding(await audit(workspaceDir), "skills.workspace.symlink_escape");
      expect(finding.severity).toBe("warn");
      expect(finding.detail).toContain(outsideSkillPath);
    }
  });

  it("audits nested escapes through a symlinked skills root without revisiting cycles", async () => {
    const tmp = await fs.realpath(await tempCases.makeTmpDir("linked-skills-root"));
    const workspaceDir = path.join(tmp, "workspace");
    const skillsRoot = path.join(tmp, "shared-skills");
    const outsideDir = path.join(tmp, "outside");
    await fs.mkdir(workspaceDir);
    await fs.mkdir(skillsRoot);
    await fs.mkdir(outsideDir);
    const outsideSkillPath = path.join(outsideDir, "SKILL.md");
    await fs.writeFile(outsideSkillPath, "# outside\n");
    const linkType = isWindows ? "junction" : "dir";
    await fs.symlink(skillsRoot, path.join(workspaceDir, "skills"), linkType);
    await fs.symlink(outsideDir, path.join(skillsRoot, "leak"), linkType);
    await fs.symlink(skillsRoot, path.join(skillsRoot, "cycle"), linkType);

    const findings = await audit(workspaceDir);
    const finding = requireFinding(findings, "skills.workspace.symlink_escape");
    expect(finding.severity).toBe("warn");
    expect(finding.detail).toContain(outsideSkillPath);
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.scan_truncated");
  });

  it("ignores a dangling skills root", async () => {
    const tmp = await fs.realpath(await tempCases.makeTmpDir("dangling-skills-root"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir);
    await fs.symlink(
      path.join(tmp, "missing"),
      path.join(workspaceDir, "skills"),
      isWindows ? "junction" : "dir",
    );
    expect(await audit(workspaceDir)).toEqual([]);
  });

  it.runIf(!isWindows)(
    "audits every explicit workspace when malformed defaults prevent default resolution",
    async () => {
      const workspaceA = await makeWorkspace("workspace-a", []);
      const workspaceB = await makeWorkspace("workspace-b", []);
      const outsideA = await linkOutsideSkill(workspaceA);
      const outsideB = await linkOutsideSkill(workspaceB);
      const cfg: OpenClawConfigWithLegacyRoster = {
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
    const workspaceDir = await makeWorkspace("workspace-skill-realpath-unresolvable");

    // Rejection and timeout both resolve to null; keep workspace-root resolution working.
    vi.spyOn(fs, "realpath").mockImplementation(async (p: unknown): Promise<string> => {
      if (String(p).endsWith("SKILL.md")) {
        throw new Error("simulated realpath timeout");
      }
      return String(p);
    });
    const findings = await audit(workspaceDir);
    const escapeFinding = requireFinding(findings, "skills.workspace.symlink_escape");
    expect(escapeFinding.severity).toBe("warn");
    expect(escapeFinding.detail).toContain("realpath timed out");
  });

  it.each([
    ["directory visit cap", "directory", 40_000, true],
    ["file cap", "file", 2_001, true],
    ["exact file cap with excluded directories", "file", 2_000, false],
  ] as const)("reports scan completeness for %s", async (_name, kind, count, truncated) => {
    const workspaceDir = await makeWorkspace(
      "workspace-skill-capped",
      ["a/SKILL.md"],
      [".hidden", "node_modules"],
    );
    vi.mocked(directoryWalker.walkDirectory).mockImplementationOnce(async (root, options) => {
      const scan = await actualWalk(root);
      const sample = scan.entries.find(
        (entry) => entry.kind === kind && entry.name !== ".hidden" && entry.name !== "node_modules",
      )!;
      const visit = kind === "directory" ? options?.descend : options?.include;
      for (let index = 0; index < count; index += 1) {
        await visit?.(sample);
      }
      for (const entry of scan.entries.filter(
        (candidate) => candidate.name === ".hidden" || candidate.name === "node_modules",
      )) {
        await options?.descend?.(entry);
      }
      return { ...scan, entries: [] };
    });
    const findings = await audit(workspaceDir);
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
      const workspaceDir = await makeWorkspace("workspace-skill-unreadable", [
        path.join(relative, "SKILL.md"),
      ]);
      const unreadableDir = path.join(workspaceDir, "skills", relative);
      const openDirectory = fs.opendir.bind(fs);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        if (path.resolve(String(args[0])) === unreadableDir) {
          throw Object.assign(new Error("directory unavailable"), { code: "EACCES" });
        }
        return openDirectory(...args);
      });

      const findings = await audit(workspaceDir);
      expect(requireFinding(findings, "skills.workspace.scan_truncated").severity).toBe("warn");
    },
  );
});
