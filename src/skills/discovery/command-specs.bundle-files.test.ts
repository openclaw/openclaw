import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildWorkspaceSkillCommandSpecs } from "./command-specs.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

it.each([
  ["directory", "./extra", "extra"],
  ["file", "./extra/review.md", "extra"],
  ["array", ["./extra/review.md"], "extra"],
  ["default overlap", "./commands/review.md", "commands"],
  ["default directory symlink", undefined, "extra"],
] as const)(
  "discovers selected Claude bundle commands from a %s declaration",
  async (mode, declared, folder) => {
    const workspaceDir = tempDirs.make("openclaw-bundle-file-command-");
    const pluginRoot = path.join(workspaceDir, "bundle");
    const selectedFile = path.join(pluginRoot, folder, "review.md");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.dirname(selectedFile), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "fixture", commands: declared }),
    );
    await fs.writeFile(selectedFile, "---\ndescription: Review the change\n---\nReview it.\n");
    if (mode === "default directory symlink") {
      await fs.symlink(path.join(pluginRoot, folder), path.join(pluginRoot, "commands"), "dir");
    }
    if (mode === "file" || mode === "array") {
      await fs.writeFile(path.join(pluginRoot, folder, "unselected.md"), "Unselected.\n");
    }

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      config: {
        plugins: {
          allow: ["fixture"],
          load: { paths: [pluginRoot] },
          entries: { fixture: { enabled: true } },
        },
      },
    });
    expect(commands.filter((command) => command.sourceFilePath?.startsWith(pluginRoot))).toEqual([
      {
        name: "review",
        skillName: "review",
        description: "Review the change",
        modelVisible: false,
        promptTemplate: "Review it.",
        sourceFilePath:
          mode === "default directory symlink"
            ? path.join(pluginRoot, "commands", "review.md")
            : selectedFile,
      },
    ]);
  },
);
