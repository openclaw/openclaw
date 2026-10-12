import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";

vi.unmock("../agents/agent-scope-config.js");

const { runSecurityAuditCore } = await import("./audit.js");

describe("security audit rosterless configs", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function makeAuditPaths(label: string) {
    const rootDir = tempDirs.make(`openclaw-audit-${label}-`);
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    return { stateDir, workspaceDir };
  }

  function makeEscapingWorkspace(rootDir: string, workspaceDir: string) {
    const externalSkillDir = path.join(rootDir, `external-${path.basename(workspaceDir)}`);
    const skillsDir = path.join(workspaceDir, "skills");
    fs.mkdirSync(externalSkillDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(externalSkillDir, "SKILL.md"), "# external\n");
    fs.symlinkSync(
      externalSkillDir,
      path.join(skillsDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  it("uses the explicit audit workspace without resolving a missing roster default", async () => {
    const { stateDir, workspaceDir } = makeAuditPaths("rosterless");

    await expect(
      runSecurityAuditCore({
        config: {},
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        workspaceDir,
        env: {},
        includeFilesystem: true,
        includeChannelSecurity: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ findings: expect.any(Array) }));
  });

  it("distinguishes an authored empty roster from an absent pre-roster source", async () => {
    const { stateDir, workspaceDir } = makeAuditPaths("authored-empty-roster");
    const config = { agents: { entries: { main: {} } } };
    const baseOptions = {
      config,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      workspaceDir,
      env: {},
      includeFilesystem: true,
      includeChannelSecurity: false,
    };

    const authoredEmpty = await runSecurityAuditCore({
      ...baseOptions,
      sourceConfig: { agents: { entries: {} } },
    });
    expect(authoredEmpty.findings).toContainEqual(
      expect.objectContaining({
        checkId: "config.agent_roster.invalid_default_count",
        detail: expect.stringContaining("found 0"),
      }),
    );

    const absent = await runSecurityAuditCore({ ...baseOptions, sourceConfig: {} });
    expect(absent.findings).not.toContainEqual(
      expect.objectContaining({ checkId: "config.agent_roster.invalid_default_count" }),
    );
  });

  it("still reports a legacy default marker on an explicit roster", async () => {
    const { stateDir, workspaceDir } = makeAuditPaths("explicit-roster-with-default");
    const config: OpenClawConfigWithLegacyRoster = {
      agents: {
        ownership: "explicit",
        entries: { alpha: { default: true }, beta: {} },
      },
    };
    const report = await runSecurityAuditCore({
      config,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      workspaceDir,
      env: {},
      includeFilesystem: true,
      includeChannelSecurity: false,
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        checkId: "config.agent_roster.invalid_default_count",
        detail: expect.stringContaining("Expected no"),
      }),
    );
  });

  it("scans every explicit fleet workspace without fabricating a legacy default workspace", async () => {
    const rootDir = tempDirs.make("openclaw-audit-explicit-workspaces-");
    const stateDir = path.join(rootDir, "state");
    const unusedDefaultsWorkspace = path.join(rootDir, "unused-defaults");
    const alphaWorkspace = path.join(rootDir, "alpha");
    const betaWorkspace = path.join(rootDir, "beta");
    fs.mkdirSync(stateDir, { recursive: true });

    for (const workspaceDir of [unusedDefaultsWorkspace, alphaWorkspace, betaWorkspace]) {
      makeEscapingWorkspace(rootDir, workspaceDir);
    }

    const report = await runSecurityAuditCore({
      config: {
        agents: {
          ownership: "explicit",
          defaults: { workspace: unusedDefaultsWorkspace },
          entries: {
            alpha: { workspace: alphaWorkspace },
            beta: { workspace: betaWorkspace },
          },
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
