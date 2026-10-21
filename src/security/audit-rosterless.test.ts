import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";

vi.unmock("../agents/agent-scope-config.js");

const { runSecurityAuditCore } = await import("./audit.js");
function rosterFinding(detail?: string) {
  return expect.objectContaining({
    checkId: "config.agent_roster.invalid_default_count",
    ...(detail ? { detail: expect.stringContaining(detail) } : {}),
  });
}

describe("security audit rosterless configs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function makeAuditPaths(label: string) {
    const rootDir = tempDirs.make(`openclaw-audit-${label}-`);
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    return {
      stateDir,
      workspaceDir,
      configPath: path.join(stateDir, "openclaw.json"),
      env: {},
      includeFilesystem: true,
      includeChannelSecurity: false,
    };
  }

  function makeEscapingWorkspace(rootDir: string, name: string) {
    const workspaceDir = path.join(rootDir, name);
    const externalSkillDir = path.join(rootDir, `external-${name}`);
    const skillsDir = path.join(workspaceDir, "skills");
    fs.mkdirSync(externalSkillDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(externalSkillDir, "SKILL.md"), "# external\n");
    fs.symlinkSync(
      externalSkillDir,
      path.join(skillsDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return workspaceDir;
  }

  it("uses the explicit audit workspace without resolving a missing roster default", async () => {
    await expect(
      runSecurityAuditCore({ ...makeAuditPaths("rosterless"), config: {} }),
    ).resolves.toEqual(expect.objectContaining({ findings: expect.any(Array) }));
  });

  it("distinguishes an authored empty roster from an absent pre-roster source", async () => {
    const baseOptions = {
      ...makeAuditPaths("authored-empty-roster"),
      config: { agents: { entries: { main: {} } } },
    };

    const sourceConfig = { agents: { entries: {} } };
    const authoredEmpty = await runSecurityAuditCore({ ...baseOptions, sourceConfig });
    expect(authoredEmpty.findings).toContainEqual(rosterFinding("found 0"));

    const absent = await runSecurityAuditCore({ ...baseOptions, sourceConfig: {} });
    expect(absent.findings).not.toContainEqual(rosterFinding());
  });

  it("still reports a legacy default marker on an explicit roster", async () => {
    const config: OpenClawConfigWithLegacyRoster = {
      agents: { ownership: "explicit", entries: { alpha: { default: true }, beta: {} } },
    };
    const report = await runSecurityAuditCore({
      ...makeAuditPaths("explicit-roster-with-default"),
      config,
    });

    expect(report.findings).toContainEqual(rosterFinding("Expected no"));
  });

  it("scans every explicit fleet workspace without fabricating a legacy default workspace", async () => {
    const rootDir = tempDirs.make("openclaw-audit-explicit-workspaces-");
    const stateDir = path.join(rootDir, "state");
    const unusedDefaultsWorkspace = makeEscapingWorkspace(rootDir, "unused-defaults");
    const alphaWorkspace = makeEscapingWorkspace(rootDir, "alpha");
    const betaWorkspace = makeEscapingWorkspace(rootDir, "beta");
    fs.mkdirSync(stateDir, { recursive: true });

    const report = await runSecurityAuditCore({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { workspace: unusedDefaultsWorkspace },
          entries: { alpha: { workspace: alphaWorkspace }, beta: { workspace: betaWorkspace } },
        },
      },
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      env: { HOME: rootDir },
      includeFilesystem: true,
      includeChannelSecurity: false,
    });

    const finding = report.findings.find(
      (candidate) => candidate.checkId === "skills.workspace.symlink_escape",
    );
    expect(finding?.detail).toContain(`workspace=${alphaWorkspace}`);
    expect(finding?.detail).toContain(`workspace=${betaWorkspace}`);
    expect(finding?.detail).not.toContain(`workspace=${unusedDefaultsWorkspace}`);
  });
});
