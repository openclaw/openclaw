import fs from "node:fs/promises";
import path from "node:path";
import * as directoryWalker from "@openclaw/fs-safe/walk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    const entries = {
      alpha: { default: true, workspace: await makeWorkspace([]) },
      beta: { default: true, workspace: await makeWorkspace([]) },
    };
    const targets = await Promise.all(
      Object.values(entries).map(({ workspace }) => linkOutsideSkill(workspace)),
    );
    const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { entries } },
    });
    for (const target of targets) {
      expectWarning(findings, "symlink_escape", target);
    }
  });

  it("accepts an in-workspace skill but warns when its realpath becomes unresolvable", async () => {
    const workspaceDir = await makeWorkspace();
    const findings = await audit(workspaceDir);
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.symlink_escape");

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
    const workspaceDir = await makeWorkspace(
      ["a", ".hidden", "node_modules"].map((dir) => `${dir}/SKILL.md`),
    );
    vi.mocked(directoryWalker.walkDirectory).mockImplementationOnce(async (root, options) => {
      const scan = await actualWalk(root);
      const ignored = scan.entries.filter(({ name }) => [".hidden", "node_modules"].includes(name));
      const sample = scan.entries.find((entry) => entry.kind === kind && !ignored.includes(entry))!;
      const visit = kind === "directory" ? options?.descend : options?.include;
      for (let index = 0; index < count; index += 1) {
        await visit?.(sample);
      }
      for (const entry of ignored) {
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
