import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { recordSkillFileHost } from "../../skills/skill-file-host.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { registerAgentWorkspaceAccess } from "../workspace-access.js";
import { createInstalledSkillTools } from "./installed-skill-tools.js";

it("reads bounded companions only under the prepared local skill identity", async () => {
  await withTempDir("skill-companions-", async (directory) => {
    const dir = await fs.realpath(directory);
    const root = path.join(dir, "guide");
    await fs.mkdir(path.join(root, "modules"), { recursive: true });
    const filePath = path.join(root, "SKILL.md");
    const instructions = "Complete instructions";
    const companion = path.join(root, "modules", "guide.md");
    await fs.writeFile(filePath, instructions);
    await fs.writeFile(companion, "Selected companion");
    const outside = path.join(dir, "outside.md");
    await fs.writeFile(outside, "Outside marker");
    await fs.symlink(outside, path.join(root, "symlink.md"));
    await fs.link(outside, path.join(root, "hardlink.md"));
    await fs.writeFile(path.join(root, "large.md"), "x".repeat(256 * 1024 + 1));
    // Native filesystem loading leaves fileHost unset without a workspace adapter.
    const local = createCanonicalFixtureSkill({
      name: "guide",
      description: "Guide",
      filePath,
      baseDir: root,
      source: "bundled",
    });
    const skills = prepareInstalledSkillCatalog({
      workspaceDir: dir,
      snapshot: { prompt: "", skills: [{ name: "guide" }], discoverySkills: [local] },
    });
    const read = expectDefined(createInstalledSkillTools(skills)[1], "skill reader");
    expect((await read.execute("whole", { name: "guide" })).content).toEqual([
      { type: "text", text: instructions },
    ]);
    expect(
      (await read.execute("companion", { name: "guide", relativePath: "modules/guide.md" }))
        .content,
    ).toEqual([{ type: "text", text: "Selected companion" }]);
    skills[0]!.promptListed = true;
    for (const relativePath of [
      "",
      " ",
      ".",
      "..",
      "../outside.md",
      "/SKILL.md",
      "C:/SKILL.md",
      "C:SKILL.md",
      "modules\\guide.md",
      "modules//guide.md",
      "~/SKILL.md",
      "a\0b",
      "symlink.md",
      "hardlink.md",
      "large.md",
      "missing.md",
      "modules",
    ]) {
      await expect(read.execute("denied", { name: "guide", relativePath })).rejects.toThrow();
    }
    await expect(
      read.execute("unknown", { name: "missing", relativePath: "modules/guide.md" }),
    ).rejects.toThrow("Unknown installed skill");
    await fs.rename(root, `${root}-original`);
    await fs.mkdir(path.join(root, "modules"), { recursive: true });
    await fs.writeFile(companion, "Replacement marker");
    await expect(
      read.execute("replaced", { name: "guide", relativePath: "modules/guide.md" }),
    ).rejects.toThrow();
  });
});

it("keeps workspace, node, and sandbox skills instruction-only", async () => {
  await withTempDir("skill-companion-placements-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await fs.writeFile(filePath, "Whole instructions");
    await fs.writeFile(path.join(dir, "companion.md"), "Host marker");
    const local = recordSkillFileHost(
      createCanonicalFixtureSkill({
        name: "guide",
        description: "Guide",
        filePath,
        baseDir: dir,
        source: "bundled",
      }),
      "gateway",
    );
    const cases = [
      { skill: recordSkillFileHost({ ...local, readContent: "Whole instructions" }, "workspace") },
      {
        skill: { ...local, filePath: "node://remote/SKILL.md", readContent: "Whole instructions" },
      },
      {
        skill: local,
        sandbox: createSandboxTestContext({
          overrides: {
            fsBridge: {
              readFile: async () => Buffer.from("Whole instructions"),
              resolvePath: vi.fn(),
              writeFile: vi.fn(),
              mkdirp: vi.fn(),
              remove: vi.fn(),
              rename: vi.fn(),
              stat: vi.fn(),
            },
          },
        }),
      },
    ];
    for (const placement of cases) {
      const skills = prepareInstalledSkillCatalog({
        workspaceDir: dir,
        sandbox: placement.sandbox,
        snapshot: { prompt: "", skills: [{ name: "guide" }], discoverySkills: [placement.skill] },
      });
      const read = expectDefined(createInstalledSkillTools(skills)[1], "skill reader");
      expect((await read.execute("whole", { name: "guide" })).content).toEqual([
        { type: "text", text: "Whole instructions" },
      ]);
      await expect(
        read.execute("companion", { name: "guide", relativePath: "companion.md" }),
      ).rejects.toThrow("instruction-only");
    }
  });
});

it("withholds companion bytes after cancellation or owner revocation across awaited I/O", async () => {
  await withTempDir("skill-companion-lifetime-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await fs.writeFile(filePath, "Instructions");
    await fs.writeFile(path.join(dir, "companion.md"), "Private marker");
    const local = recordSkillFileHost(
      createCanonicalFixtureSkill({
        name: "guide",
        description: "Guide",
        filePath,
        baseDir: dir,
        source: "bundled",
      }),
      "gateway",
    );
    for (const phase of ["preparation", "read"] as const) {
      for (const cancel of [false, true]) {
        let current = true;
        const controller = new AbortController();
        const skills = prepareInstalledSkillCatalog({
          workspaceDir: dir,
          snapshot: { prompt: "", skills: [{ name: "guide" }], discoverySkills: [local] },
          assertCurrent: () => {
            if (!current) {
              throw new Error("Owner closed");
            }
          },
        });
        const revoke = () => {
          if (cancel) {
            controller.abort();
          } else {
            current = false;
          }
        };
        if (phase === "read") {
          const captured = await skills[0]!.companionRoot;
          if (!captured || "error" in captured) {
            throw new Error("Local root preparation failed");
          }
          const readText = captured.root.readText.bind(captured.root);
          vi.spyOn(captured.root, "readText").mockImplementation(async (...args) => {
            const text = await readText(...args);
            revoke();
            return text;
          });
        }
        const read = expectDefined(createInstalledSkillTools(skills)[1], "skill reader");
        const pending = read.execute(
          "in-flight",
          { name: "guide", relativePath: "companion.md" },
          controller.signal,
        );
        const rejected = expect(pending).rejects.toThrow();
        if (phase === "preparation") {
          revoke();
        }
        await rejected;
      }
    }
  });
});

it("never treats an unmarked remote library selection as a local companion root", async () => {
  await withTempDir("skill-companion-remote-", async (dir) => {
    const filePath = path.join(dir, "SKILL.md");
    await fs.writeFile(filePath, "Whole instructions");
    await fs.writeFile(path.join(dir, "companion.md"), "Host marker");
    const skill = createCanonicalFixtureSkill({
      name: "guide",
      description: "Guide",
      filePath,
      baseDir: dir,
      source: "bundled",
    });
    const release = registerAgentWorkspaceAccess(dir, {
      loadSkills: vi.fn(),
      bridge: {
        readFile: vi.fn(),
        readFileWithSource: vi.fn(),
        readDirectory: vi.fn(),
        writeFile: vi.fn(),
        createFileExclusive: vi.fn(),
        stat: vi.fn(),
      },
    });
    try {
      const catalog = prepareInstalledSkillCatalog({
        workspaceDir: dir,
        snapshot: {
          prompt: "",
          skills: [{ name: "guide" }],
          discoverySkills: [skill],
          librarySelections: [
            {
              name: "guide",
              skillId: "guide-id",
              revision: "guide-revision",
              ownerProfileId: null,
            },
          ],
        },
      });
      const read = expectDefined(createInstalledSkillTools(catalog)[1], "skill reader");
      await expect(
        read.execute("companion", { name: "guide", relativePath: "companion.md" }),
      ).rejects.toThrow("instruction-only");
    } finally {
      release();
    }
    expect(() =>
      prepareInstalledSkillCatalog({
        workspaceDir: dir,
        snapshot: { prompt: "", skills: [{ name: "guide" }], discoverySkills: [skill] },
      }),
    ).toThrow("Workspace access is stopped");
  });
});
