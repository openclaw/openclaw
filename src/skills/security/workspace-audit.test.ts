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

  async function writeSkill(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# skill\n");
  }

  async function makeWorkspace(files = ["safe/SKILL.md"]) {
    const workspaceDir = path.join(await tempCases.makeTmpDir("workspace"), "workspace");
    await fs.mkdir(workspaceDir);
    for (const file of files) {
      await writeSkill(path.join(workspaceDir, "skills", file));
    }
    return workspaceDir;
  }

  async function linkDirectory(target: string, link: string) {
    await fs.symlink(target, link, isWindows ? "junction" : "dir");
  }

  async function linkOutsideSkill(workspaceDir: string) {
    const outsidePath = path.resolve(workspaceDir, "..", "outside.md");
    const skillDir = path.join(workspaceDir, "skills", "leak");
    await fs.mkdir(skillDir, { recursive: true });
    await writeSkill(outsidePath);
    await fs.symlink(outsidePath, path.join(skillDir, "SKILL.md"));
    return outsidePath;
  }

  function audit(workspaceDir: string) {
    return collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
    });
  }

  function expectWarning(
    findings: Awaited<ReturnType<typeof collectWorkspaceSkillSymlinkEscapeFindings>>,
    kind: "symlink_escape" | "scan_truncated",
    detail?: string,
  ) {
    expect(findings.find((entry) => entry.checkId === `skills.workspace.${kind}`)).toMatchObject({
      severity: "warn",
      detail: detail === undefined ? expect.any(String) : expect.stringContaining(detail),
    });
  }

  beforeAll(() => tempCases.setup());
  afterAll(() => tempCases.cleanup());
  afterEach(() => vi.restoreAllMocks());

  it("evaluates workspace skill path escape findings", async () => {
    const findings = await audit(await makeWorkspace());
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.symlink_escape");
    if (!isWindows) {
      const workspaceDir = await makeWorkspace([]);
      const outsideSkillPath = await linkOutsideSkill(workspaceDir);
      expectWarning(await audit(workspaceDir), "symlink_escape", outsideSkillPath);
    }
  });

  it("audits nested escapes through a symlinked skills root without revisiting cycles", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace([]));
    const skillsRoot = path.resolve(workspaceDir, "../shared-skills");
    const outsideDir = path.resolve(workspaceDir, "../outside");
    await fs.mkdir(skillsRoot);
    const outsideSkillPath = path.join(outsideDir, "SKILL.md");
    await writeSkill(outsideSkillPath);
    await linkDirectory(skillsRoot, path.join(workspaceDir, "skills"));
    await linkDirectory(outsideDir, path.join(skillsRoot, "leak"));
    await linkDirectory(skillsRoot, path.join(skillsRoot, "cycle"));
    const findings = await audit(workspaceDir);
    expectWarning(findings, "symlink_escape", outsideSkillPath);
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.scan_truncated");
  });

  it("ignores a dangling skills root", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace([]));
    await linkDirectory(
      path.resolve(workspaceDir, "../missing"),
      path.join(workspaceDir, "skills"),
    );
    expect(await audit(workspaceDir)).toEqual([]);
  });

  it.runIf(!isWindows)("audits explicit workspaces despite malformed defaults", async () => {
    const workspaceA = await makeWorkspace([]);
    const workspaceB = await makeWorkspace([]);
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
    expectWarning(findings, "symlink_escape", outsideA);
    expectWarning(findings, "symlink_escape", outsideB);
  });

  it("warns on an unresolvable skill realpath", async () => {
    const workspaceDir = await makeWorkspace();

    // Rejection and timeout both resolve to null; keep workspace-root resolution working.
    vi.spyOn(fs, "realpath").mockImplementation(async (p: unknown): Promise<string> => {
      if (String(p).endsWith("SKILL.md")) {
        throw new Error("simulated realpath timeout");
      }
      return String(p);
    });
    expectWarning(await audit(workspaceDir), "symlink_escape", "realpath timed out");
  });

  it.each([
    ["directory visit cap", "directory", 40_000, true],
    ["file cap", "file", 2_001, true],
    ["exact file cap with excluded directories", "file", 2_000, false],
  ] as const)("reports scan completeness for %s", async (_name, kind, count, truncated) => {
    const workspaceDir = await makeWorkspace([
      "a/SKILL.md",
      ".hidden/SKILL.md",
      "node_modules/SKILL.md",
    ]);
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
      expectWarning(findings, "scan_truncated", workspaceDir);
    }
  });

  it.each(["", "blocked"])("reports unreadable directory %j as incomplete", async (relative) => {
    const workspaceDir = await makeWorkspace([path.join(relative, "SKILL.md")]);
    const unreadableDir = path.join(workspaceDir, "skills", relative);
    const openDirectory = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === unreadableDir) {
        throw Object.assign(new Error("directory unavailable"), { code: "EACCES" });
      }
      return openDirectory(...args);
    });

    expectWarning(await audit(workspaceDir), "scan_truncated");
  });
});
