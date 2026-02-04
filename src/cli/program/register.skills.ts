import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";

const SKILL_TEMPLATE = [
  "---",
  "name: {{name}}",
  "description: {{description}}",
  "---",
  "",
  "# {{name}}",
  "",
  "{{description}}",
  "",
  "## Usage",
  "",
  "Describe how to use this skill.",
  "",
  "## Tools",
  "",
  "### {{name}}_tool",
  "",
  "Description of the tool.",
  "",
  "```javascript",
  "// Tool implementation",
  "```",
  "",
].join("\n");

export function registerSkillsCommands(program: Command) {
  // avoid duplicate registration when called multiple times in same process
  if (program.commands.some((c) => c.name() === "skills")) {
    return;
  }

  const skills = program.command("skills").description("Manage agent skills");

  skills
    .command("new")
    .description("Create a new skill from a template")
    .argument("<name>", "Name of the new skill (kebab-case)")
    .action(async (name: string) => {
      const skillName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const cwd = process.cwd();
      const skillsDir = path.join(cwd, "skills");
      const skillDir = path.join(skillsDir, skillName);
      const skillFile = path.join(skillDir, "SKILL.md");

      try {
        await fs.mkdir(skillDir, { recursive: true });
        const content = SKILL_TEMPLATE.replace(/{{name}}/g, skillName).replace(
          /{{description}}/g,
          `A new skill named ${skillName}`,
        );
        await fs.writeFile(skillFile, content, "utf-8");
        defaultRuntime.log(`${theme.success("Created")} skill at ${theme.command(skillFile)}`);
      } catch (err) {
        defaultRuntime.error(`Failed to create skill: ${String(err)}`);
      }
    });
}
