import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { preflightTemplatePackage } from "./package-preflight.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";
import { validateTemplateProject } from "./project.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function project(skills: unknown[] = [{ path: "bundles/checked" }]) {
  const root = tempDirs.make("openclaw-template-bundled-");
  await mkdir(join(root, "bundles", "checked"), { recursive: true });
  writeJsonFile(join(root, "package.json"), {
    name: "checked-template",
    version: "1.0.0",
    openclaw: { template: "CLAW.md" },
  });
  await writeFile(
    join(root, "CLAW.md"),
    `---\n${JSON.stringify({ schemaVersion: 1, agent: { id: "checked" }, skills })}\n---\nFollow the checked instructions.\n`,
  );
  await writeFile(
    join(root, "bundles", "checked", "SKILL.md"),
    "---\nname: checked\ndescription: Follow the checklist.\n---\nRead references/checklist.bin.\n",
  );
  return root;
}

describe("bundled Template project sources", () => {
  it.each([undefined, "Companion identity"])(
    "inspects dual-format native plugins using their native identity (companion name: %s)",
    async (companionName) => {
      const root = await project([]);
      const plugin = join(root, "plugins", "dual");
      await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(root, "CLAW.md"),
        `---\n${JSON.stringify({ schemaVersion: 1, agent: { id: "checked" }, plugins: [{ path: "plugins/dual" }] })}\n---\nInspect native plugin metadata.\n`,
      );
      writeJsonFile(join(plugin, "package.json"), {
        name: "native-dual",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      });
      writeJsonFile(join(plugin, "openclaw.plugin.json"), {
        id: "native-dual",
        name: "Native dual plugin",
        configSchema: {},
      });
      await writeFile(
        join(plugin, "index.js"),
        "throw new Error('Metadata inspection must not execute plugin code');\n",
      );
      writeJsonFile(join(plugin, ".codex-plugin", "plugin.json"), { name: companionName });
      const result = await validateTemplateProject(root);
      assert(result.ok, JSON.stringify(result.diagnostics));
      expect(result.template.snapshot?.bundledSources).toMatchObject([
        { kind: "plugin", path: "plugins/dual", name: "Native dual plugin" },
      ]);
    },
  );
  it.each(["checked", "other"])(
    "plans bundled and referenced skills with explicit destination conflicts (%s)",
    async (ref) => {
      const root = await project([{ path: "bundles/checked" }, { ref, version: "1.0.0" }]);
      const validated = await validateTemplateProject(root);
      assert(validated.ok, JSON.stringify(validated.diagnostics));
      const plan = await buildTemplateAddPlan({
        ...validated.template,
        context: {
          workspace: join(root, "new-workspace"),
          config: {},
          packagePreflight: async (dependency, workspace, source) =>
            dependency.source === "bundled"
              ? preflightTemplatePackage(dependency, workspace, { ...source, config: {} })
              : { ok: true, action: "install", integrity: `sha256:${"a".repeat(64)}` },
        },
      });
      if (ref === "checked") {
        expect(plan.blockers).toContainEqual(
          expect.objectContaining({ code: "bundled_skill_collision" }),
        );
      } else {
        expect(plan.blockers).toEqual([]);
        expect(
          plan.actions.filter((action) => action.kind === "package").map((action) => action.target),
        ).toEqual(["bundled:bundles/checked", "clawhub:other@1.0.0"]);
      }
    },
  );
  it("packs deterministic binary contents while excluding repository and installed dependencies", async () => {
    const root = await project();
    const skill = join(root, "bundles", "checked");
    await mkdir(join(skill, "references"));
    const binary = Buffer.from([0, 255, 1, 128, 10]);
    await writeFile(join(skill, "references", "checklist.bin"), binary);
    for (const directory of [".git", "NODE_MODULES"]) {
      await mkdir(join(skill, directory));
      await writeFile(join(skill, directory, "excluded.txt"), "do not pack");
    }
    const first = await buildTemplateProject(root, `${root}-first.tgz`);
    const second = await buildTemplateProject(root, `${root}-second.tgz`);
    expect(first.integrity).toBe(second.integrity);
    expect(first.files).toEqual([
      "CLAW.md",
      "bundles/checked/SKILL.md",
      "bundles/checked/references/checklist.bin",
      "package.json",
    ]);
    await using extracted = await extractBuiltTemplateArtifact(first.artifact);
    expect(
      await readFile(
        join(extracted.packageRoot, "bundles", "checked", "references", "checklist.bin"),
      ),
    ).toEqual(binary);
  });

  it.each([
    [{ path: "../outside" }],
    [{ path: "bundles/checked", ref: "checked", version: "1.0.0" }],
    [{ path: "bundles/checked" }, { path: "bundles/checked/references" }],
  ])("rejects unsafe or ambiguous authored directories (%j)", async (...skills) => {
    const root = await project(skills);
    const result = await validateTemplateProject(root);
    expect(result.ok).toBe(false);
  });

  it.each(["missing", "manifest-missing", "invalid", "oversized", "unsafe", "depth", "aggregate"])(
    "rejects a %s skill source",
    async (kind) => {
      const root = await project(kind === "missing" ? [{ path: "bundles/missing" }] : undefined);
      const skill = join(root, "bundles", "checked");
      if (kind === "manifest-missing") {
        await rm(join(skill, "SKILL.md"));
      }
      if (kind === "aggregate") {
        for (let index = 0; index < 21; index++) {
          await writeFile(
            join(skill, `support-${index}.bin`),
            Buffer.alloc(MAX_MANAGED_FILE_BYTES),
          );
        }
      }
      if (kind === "invalid") {
        await writeFile(join(skill, "SKILL.md"), "Missing the required description.\n");
      }
      if (kind === "oversized") {
        await writeFile(join(skill, "too-large.bin"), Buffer.alloc(MAX_MANAGED_FILE_BYTES + 1));
      }
      if (kind === "unsafe") {
        await writeFile(join(skill, "unsafe:name.txt"), "unsafe portable path");
      }
      if (kind === "depth") {
        await mkdir(join(skill, ...Array.from({ length: 18 }, (_, i) => `nested-${i}`)), {
          recursive: true,
        });
      }
      const result = await validateTemplateProject(root);
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "bundled_dependency_invalid" })],
      });
    },
  );

  it.each(["symlink", "hardlink"])("rejects a supporting %s", async (kind) => {
    const root = await project();
    const source = join(root, "outside.txt");
    await writeFile(source, "not a regular selected file");
    const target = join(root, "bundles", "checked", "linked.txt");
    if (kind === "symlink") {
      await symlink(source, target);
    } else {
      await link(source, target);
    }
    const result = await validateTemplateProject(root);
    assert(!result.ok);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "bundled_dependency_invalid" }),
    );
  });
});
