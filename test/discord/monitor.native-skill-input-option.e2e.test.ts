import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "../../src/agents/skills.e2e-test-helpers.js";
import { buildWorkspaceSkillCommandSpecs } from "../../src/agents/skills.js";
import { createDiscordNativeCommand } from "../../src/discord/monitor.js";
import { createNoopThreadBindingManager } from "../../src/discord/monitor/thread-bindings.js";

describe("discord native skill commands", () => {
  it("adds optional input field for workspace skills", async () => {
    const workspaceDir = path.join(
      process.cwd(),
      ".tmp-e2e-native-skill-input",
      `case-${Date.now()}`,
    );

    try {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "cofounder"),
        name: "cofounder",
        description: "Run cofounder workflow",
      });

      const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      const command = createDiscordNativeCommand({
        command: commands[0],
        cfg: {
          agents: { defaults: { model: "anthropic/claude-opus-4-5" } },
          channels: { discord: { dm: { enabled: true, policy: "open" } } },
        } as ReturnType<typeof import("../../src/config/config.js").loadConfig>,
        discordConfig: { dm: { enabled: true, policy: "open" } },
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
        threadBindings: createNoopThreadBindingManager("default"),
      });

      expect(command.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "input",
            required: false,
          }),
        ]),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
