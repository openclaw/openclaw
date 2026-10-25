// Workspace bundled allowlist tests cover which bundled skills may sync into workspaces.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = async (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(workspaceDir, opts)).prompt;

describe("buildWorkspaceSkillsPrompt", () => {
  const prepareWorkspace = async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "peekaboo",
      description: "Capture UI",
      body: "# Peekaboo\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });
    return { workspaceDir, bundledDir };
  };

  it("applies bundled allowlist without affecting workspace skills", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    const { workspaceDir, bundledDir } = await prepareWorkspace();
    try {
      setTestEnvValue("HOME", workspaceDir);
      setTestEnvValue("USERPROFILE", workspaceDir);
      deleteTestEnvValue("OPENCLAW_HOME");
      deleteTestEnvValue("OPENCLAW_STATE_DIR");

      const prompt = await buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { allowBundled: ["missing-skill"] } },
      });

      expect(prompt).toContain("Workspace version");
      expect(prompt).not.toContain("peekaboo");
    } finally {
      env.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("treats an explicit empty allowlist as allowing no bundled skills", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    const { workspaceDir, bundledDir } = await prepareWorkspace();
    try {
      setTestEnvValue("HOME", workspaceDir);
      setTestEnvValue("USERPROFILE", workspaceDir);
      deleteTestEnvValue("OPENCLAW_HOME");
      deleteTestEnvValue("OPENCLAW_STATE_DIR");

      const prompt = await buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { allowBundled: [] } },
      });

      expect(prompt).toContain("Workspace version");
      expect(prompt).not.toContain("peekaboo");
    } finally {
      env.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("leaves bundled skills eligible when allowBundled is unset", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    const { workspaceDir, bundledDir } = await prepareWorkspace();
    try {
      setTestEnvValue("HOME", workspaceDir);
      setTestEnvValue("USERPROFILE", workspaceDir);
      deleteTestEnvValue("OPENCLAW_HOME");
      deleteTestEnvValue("OPENCLAW_STATE_DIR");

      const prompt = await buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {},
      });

      expect(prompt).toContain("Workspace version");
      expect(prompt).toContain("peekaboo");
    } finally {
      env.restore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
