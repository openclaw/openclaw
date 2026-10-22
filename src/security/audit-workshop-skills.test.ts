import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { collectInstalledSkillsCodeSafetyFindings } from "./audit.deep.runtime.js";

function withAuditState(
  run: (state: OpenClawTestState & { cfg: OpenClawConfig }) => Promise<void>,
) {
  return withOpenClawTestState({ label: "workshop-security-audit" }, (state) => {
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    return run({ ...state, cfg });
  });
}

const skillFinding = (dir: string) =>
  expect.objectContaining({
    checkId: "skills.code_safety",
    severity: "critical",
    detail: expect.stringContaining(dir),
  });

async function writeAuditSkill(root: string, unsafe: boolean, name = "shared-procedure") {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test procedure\n---\nFollow the procedure.\n`,
  );
  if (unsafe) {
    await fs.writeFile(
      path.join(dir, "run.js"),
      'const { execSync } = require("node:child_process"); execSync(input);\n',
    );
  }
  return await fs.realpath(dir);
}

it.each([
  { label: "default discovery", limits: {}, group: "" },
  { label: "default discovery", limits: {}, group: "group" },
  { label: "zero candidates", limits: { maxCandidatesPerRoot: 0 }, group: "group" },
  { label: "zero loaded skills", limits: { maxSkillsLoadedPerSource: 0 }, group: "group" },
  { label: "small prompt file cap", limits: { maxSkillFileBytes: 1 }, group: "group" },
])("audits hidden and shadowed Workshop skills with $label ($group)", async ({ limits, group }) => {
  await withOpenClawTestState({ label: "workshop-security-audit" }, async (state) => {
    const cfg = {
      skills: { limits },
      agents: {
        entries: {
          alpha: { workspace: state.workspaceDir, skills: [] },
          beta: { workspace: state.workspaceDir },
        },
      },
    };
    await writeAuditSkill(path.join(state.workspaceDir, "skills"), false);
    const workshopDirs = await Promise.all(
      ["alpha", "beta"].map(async (agentId) => {
        const root = resolveWorkshopSkillsDir(cfg, agentId);
        await writeAuditSkill(root, false, "aaa-safe");
        return await writeAuditSkill(path.join(root, group), true);
      }),
    );

    const findings = await collectInstalledSkillsCodeSafetyFindings({
      cfg,
      stateDir: state.stateDir,
    });
    const critical = findings.filter(
      (finding) => finding.checkId === "skills.code_safety" && finding.severity === "critical",
    );
    expect(critical).toHaveLength(2);
    for (const dir of workshopDirs) {
      expect(critical.some((finding) => finding.detail.includes(dir))).toBe(true);
    }
  });
});

it("reports an unreadable grouping directory without skipping readable siblings", async () => {
  await withAuditState(async (state) => {
    const group = path.join(resolveWorkshopSkillsDir(state.cfg, "main"), "group");
    const unreadable = path.join(group, "unreadable");
    await fs.mkdir(unreadable, { recursive: true });
    const skillDir = await writeAuditSkill(group, true);
    const opendirSync = fsSync.opendirSync.bind(fsSync);
    const opendirSpy = vi.spyOn(fsSync, "opendirSync").mockImplementation((...args) => {
      if (path.resolve(String(args[0])) === unreadable) {
        throw Object.assign(new Error("Grouping directory is unreadable"), { code: "EACCES" });
      }
      return opendirSync(...args);
    });
    try {
      const findings = await collectInstalledSkillsCodeSafetyFindings(state);
      expect(findings).toContainEqual(skillFinding(skillDir));
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "skills.code_safety.scan_failed",
          detail: expect.stringContaining(unreadable),
        }),
      );
    } finally {
      opendirSpy.mockRestore();
    }
  });
});

it.each(["contained", "escaping"] as const)("audits %s grouping symlinks", async (location) => {
  await withAuditState(async (state) => {
    const workshopDir = resolveWorkshopSkillsDir(state.cfg, "main");
    const target = path.join(location === "contained" ? workshopDir : state.stateDir, ".storage");
    const skillDir = await writeAuditSkill(target, true);
    await fs.mkdir(workshopDir, { recursive: true });
    await fs.symlink(target, path.join(workshopDir, "group"), "dir");
    const findings = await collectInstalledSkillsCodeSafetyFindings(state);
    expect(findings.filter((finding) => finding.checkId === "skills.code_safety")).toEqual(
      location === "contained" ? [skillFinding(skillDir)] : [],
    );
    if (location === "escaping") {
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "skills.code_safety.scan_failed",
          detail: expect.stringContaining("outside its configured root"),
        }),
      );
    }
  });
});

it("audits child skills even when the Workshop container has a stray definition", async () => {
  await withAuditState(async (state) => {
    state.cfg.skills = { limits: { maxCandidatesPerRoot: 0, maxSkillsLoadedPerSource: 0 } };
    const workshopDir = resolveWorkshopSkillsDir(state.cfg, "main");
    await fs.mkdir(workshopDir, { recursive: true });
    await fs.writeFile(
      path.join(workshopDir, "SKILL.md"),
      "---\nname: root-procedure\ndescription: Root procedure\n---\nFollow the procedure.\n",
    );
    const skillDir = await writeAuditSkill(workshopDir, true, "child-procedure");

    const findings = await collectInstalledSkillsCodeSafetyFindings(state);
    expect(findings.filter((finding) => finding.checkId === "skills.code_safety")).toMatchObject([
      {
        severity: "critical",
        title: expect.stringContaining("child-procedure"),
        detail: expect.stringContaining(skillDir),
      },
    ]);
  });
});
