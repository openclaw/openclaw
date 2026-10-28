import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfigWithLegacyRoster as Config } from "../config/legacy.roster.js";

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

  function audit(
    options: Parameters<typeof runSecurityAuditCore>[0],
    rootDir = tempDirs.make("openclaw-audit-roster-"),
  ) {
    const stateDir = path.join(rootDir, "state");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    return runSecurityAuditCore({
      stateDir,
      workspaceDir,
      configPath: path.join(stateDir, "openclaw.json"),
      env: {},
      includeFilesystem: true,
      plugins: [],
      ...options,
    });
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

  const main = { agents: { entries: { main: {} } } };
  it.each<[Config, Config | undefined, string?]>([
    [{}, undefined],
    [main, { agents: { entries: {} } }, "found 0"],
    [main, {}],
    [
      { agents: { ownership: "explicit", entries: { alpha: { default: true }, beta: {} } } },
      undefined,
      "Expected no",
    ],
  ])("audits roster %j with source %j", async (config, sourceConfig, detail) => {
    const { findings } = await audit({ config, sourceConfig });
    if (detail) {
      expect(findings).toContainEqual(rosterFinding(detail));
    } else {
      expect(findings).not.toContainEqual(rosterFinding());
    }
  });

  it("scans every explicit fleet workspace without fabricating a legacy default workspace", async () => {
    const rootDir = tempDirs.make("openclaw-audit-explicit-workspaces-");
    const unusedDefaultsWorkspace = makeEscapingWorkspace(rootDir, "unused-defaults");
    const alphaWorkspace = makeEscapingWorkspace(rootDir, "alpha");
    const betaWorkspace = makeEscapingWorkspace(rootDir, "beta");
    const report = await audit(
      {
        config: {
          agents: {
            ownership: "explicit",
            defaults: { workspace: unusedDefaultsWorkspace },
            entries: { alpha: { workspace: alphaWorkspace }, beta: { workspace: betaWorkspace } },
          },
        },
        workspaceDir: undefined,
        env: { HOME: rootDir },
      },
      rootDir,
    );

    const finding = report.findings.find(
      (candidate) => candidate.checkId === "skills.workspace.symlink_escape",
    );
    expect(finding?.detail).toContain(`workspace=${alphaWorkspace}`);
    expect(finding?.detail).toContain(`workspace=${betaWorkspace}`);
    expect(finding?.detail).not.toContain(`workspace=${unusedDefaultsWorkspace}`);
  });
});
