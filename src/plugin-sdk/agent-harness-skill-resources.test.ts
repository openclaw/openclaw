/** Keeps prepared skill resources separate from the public tool-factory contract. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
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
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

describe("prepared skill resource boundary", () => {
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
      const workspaceDir = path.join(rootDir, "workspace");
      const snapshotDir = path.join(rootDir, "snapshot-skill");
      const preparedDir = path.join(rootDir, "prepared-skill");
      for (const directory of [workspaceDir, snapshotDir, preparedDir]) {
        await fs.mkdir(directory, { recursive: true });
      }
      const snapshotPath = path.join(snapshotDir, "SKILL.md");
      const preparedPath = path.join(preparedDir, "SKILL.md");
      await fs.writeFile(snapshotPath, "# Public snapshot instructions\n");
      await fs.writeFile(preparedPath, "# Internal prepared instructions\n");
      const snapshotSkill = createCanonicalFixtureSkill({
        name: "snapshot",
        description: "Public snapshot skill",
        filePath: snapshotPath,
        baseDir: snapshotDir,
        source: "test",
      });
      const preparedSkill = createCanonicalFixtureSkill({
        name: "prepared",
        description: "Internal prepared skill",
        filePath: preparedPath,
        baseDir: preparedDir,
        source: "test",
      });
      const config: OpenClawConfig = { tools: { fs: { workspaceOnly: true } } };
      // A variable models JavaScript callers carrying unsupported extra fields.
      // Neither an empty nor a populated internal list may alter the public factory.
      const options = {
        workspaceDir,
        config,
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "snapshot" }],
          resolvedSkills: [snapshotSkill],
        },
        skillReadResources: selection === "empty" ? [] : [preparedSkill],
      };
      const { readTool } = expectReadWriteEditTools(createOpenClawCodingTools(options));
      expect(
        getTextContent(await readTool.execute("public-snapshot", { path: snapshotPath })),
      ).toContain("Public snapshot instructions");
      await expect(readTool.execute("public-prepared", { path: preparedPath })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );

      const { skillReadResources, ...publicOptions } = options;
      const internalTools = createOpenClawCodingToolsInternal(publicOptions, skillReadResources);
      const internal = expectReadWriteEditTools(internalTools);
      await expect(
        internal.readTool.execute("internal-snapshot", { path: snapshotPath }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      if (selection === "populated") {
        expect(
          getTextContent(
            await internal.readTool.execute("internal-prepared", {
              path: preparedPath,
            }),
          ),
        ).toContain("Internal prepared instructions");
      } else {
        await expect(
          internal.readTool.execute("internal-empty", { path: preparedPath }),
        ).rejects.toThrow(/Path escapes sandbox root/i);
      }
      await expect(
        internal.writeTool.execute("internal-write", {
          path: preparedPath,
          content: "replaced",
        }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
      await expect(
        internal.editTool.execute("internal-edit", {
          path: preparedPath,
          edits: [{ oldText: "Internal", newText: "replaced" }],
        }),
      ).rejects.toThrow(/Path escapes sandbox root|outside-workspace/i);
    },
  );
});
