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
const scanFailed = (detail: string) =>
  expect.objectContaining({
    checkId: "skills.code_safety.scan_failed",
    detail: expect.stringContaining(detail),
  });

async function writeAuditSkill(root: string, unsafe: boolean, name = "shared-procedure") {
  const dir = path.join(root, name);
  await writeSkillDefinition(dir, name);
  if (unsafe) {
    await fs.writeFile(
      path.join(dir, "run.js"),
      'const { execSync } = require("node:child_process"); execSync(input);\n',
    );
  }
  return await fs.realpath(dir);
}

async function writeSkillDefinition(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test procedure\n---\nFollow the procedure.\n`,
  );
}

it.each(["", "group"])("audits hidden Workshop children in %j", async (group) => {
  await withAuditState(async ({ cfg, ...state }) => {
    if (group) {
      cfg.skills = {
        limits: {
          maxCandidatesPerRoot: 0,
          maxSkillsLoadedPerSource: 0,
          maxSkillFileBytes: 1,
        },
      };
    }
    cfg.agents = {
      entries: {
        alpha: { workspace: state.workspaceDir, skills: [] },
        beta: { workspace: state.workspaceDir },
      },
    };
    await writeAuditSkill(path.join(state.workspaceDir, "skills"), false);
    const workshopDirs = await Promise.all(
      ["alpha", "beta"].map(async (agentId) => {
        const root = resolveWorkshopSkillsDir(cfg, agentId);
        await writeSkillDefinition(root, "root-procedure");
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
    expect(critical).toEqual(expect.arrayContaining(workshopDirs.map((dir) => skillFinding(dir))));
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
      expect(findings).toContainEqual(scanFailed(unreadable));
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
      expect(findings).toContainEqual(scanFailed("outside its configured root"));
    }
  });
});
