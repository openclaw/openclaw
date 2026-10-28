import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, it } from "vitest";
import "../agents/test-helpers/fast-coding-tools.js";
import "../agents/test-helpers/fast-openclaw-tools.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOpenClawCodingTools,
  createOpenClawCodingToolsInternal,
} from "../agents/agent-tools.js";
import {
  expectReadWriteEditTools,
  getTextContent,
} from "../agents/test-helpers/agent-tools-fs-helpers.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
type Tool = ReturnType<typeof createOpenClawCodingTools>[number];
const read = (tool: Tool, path: string) => tool.execute("read", { path });
const denied = (result: Promise<unknown>, pattern = /Path escapes sandbox root/i) =>
  expect(result).rejects.toThrow(pattern);
const readText = async (tool: Tool, path: string, text: string) =>
  expect(getTextContent(await read(tool, path))).toContain(text);
const mutationBoundary = /Path escapes sandbox root|outside-workspace/i;

it("keeps prepared skill resources out of the public SDK contract", () => {
  type Sdk = typeof import("./agent-harness.js");
  type PublicFactory = Sdk["createOpenClawCodingTools"];
  expectTypeOf<NonNullable<Parameters<PublicFactory>[0]>>().not.toHaveProperty(
    "skillReadResources",
  );
  expectTypeOf<Parameters<PublicFactory>["length"]>().toEqualTypeOf<0 | 1>();
  expectTypeOf<Sdk>().not.toHaveProperty("createOpenClawCodingToolsInternal");
});

it.each(["empty", "populated"] as const)(
  "ignores prepared skill resources supplied through public options (%s)",
  async (selection) => {
    const rootDir = temps.make("openclaw-public-skill-resources-");
    const workspaceDir = join(rootDir, "workspace");
    await fs.mkdir(workspaceDir);
    const makeSkill = async (name: string, text: string) => {
      const baseDir = join(rootDir, name);
      const filePath = join(baseDir, "SKILL.md");
      await fs.mkdir(baseDir);
      await fs.writeFile(filePath, `# ${text}\n`);
      const metadata = { name, description: text, source: "test" };
      return createCanonicalFixtureSkill({ ...metadata, filePath, baseDir });
    };
    const snapshotSkill = await makeSkill("snapshot", "Public");
    const preparedSkill = await makeSkill("prepared", "Internal");
    const { filePath: snapshotPath } = snapshotSkill;
    const { filePath: path } = preparedSkill;
    const options = {
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: true } } },
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "snapshot" }],
        resolvedSkills: [snapshotSkill],
      },
      skillReadResources: selection === "empty" ? [] : [preparedSkill],
    };
    const { readTool } = expectReadWriteEditTools(createOpenClawCodingTools(options));
    await readText(readTool, snapshotPath, "Public");
    await denied(read(readTool, path));

    const { skillReadResources, ...publicOptions } = options;
    const internal = expectReadWriteEditTools(
      createOpenClawCodingToolsInternal(publicOptions, skillReadResources),
    );
    await denied(read(internal.readTool, snapshotPath));
    if (selection === "populated") {
      await readText(internal.readTool, path, "Internal");
    } else {
      await denied(read(internal.readTool, path));
    }
    const edits = [{ oldText: "Internal", newText: "replaced" }];
    await denied(internal.writeTool.execute("write", { path, content: "x" }), mutationBoundary);
    await denied(internal.editTool.execute("edit", { path, edits }), mutationBoundary);
  },
);
