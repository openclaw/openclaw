import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  commitSkillRootChange,
  readSkillDirFile,
  removeSkillRootFile,
  resolveAgentSkillsRoot,
  SkillAuthoringError,
  splitSkillFrontmatter,
  validateSkillFileContent,
  writeSkillRootFile,
} from "./skill-authoring.js";

let state: OpenClawTestState;
let skillsRoot: string;
const skill = (name: string, body = "Run the deploy.") =>
  `---\nname: ${name}\ndescription: Deploy staging builds\n---\n\n${body}\n`;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  skillsRoot = resolveAgentSkillsRoot({ config: {}, agentId: "main", dirName: "proof-skills" });
});

afterEach(async () => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  await state.cleanup();
});

const refusal = (code: SkillAuthoringError["code"], message?: RegExp) =>
  expect.objectContaining({
    name: "SkillAuthoringError",
    code,
    ...(message ? { message: expect.stringMatching(message) } : {}),
  });

it("confines skill names, support paths, and linked skill directories to the skills root", async () => {
  const write = (skillName: string, filePath: string) =>
    writeSkillRootFile({ skillsRoot, skillName, filePath, content: skill(skillName) });
  await expect(write("..", "SKILL.md")).rejects.toEqual(refusal("path_escape"));
  await expect(write("a/b", "SKILL.md")).rejects.toEqual(refusal("path_escape"));
  await expect(write("deploy", "../escape.md")).rejects.toEqual(refusal("invalid_path"));
  await expect(write("deploy", "notes.md")).rejects.toEqual(refusal("invalid_path"));
  expect(() =>
    resolveAgentSkillsRoot({ config: {}, agentId: "main", dirName: "../outside" }),
  ).toThrow(/one folder name/);

  const outside = path.join(path.dirname(skillsRoot), "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.symlink(outside, path.join(skillsRoot, "linked"), "dir");
  await expect(write("linked", "SKILL.md")).rejects.toEqual(
    refusal("path_escape", /inside the skills root/),
  );
  await expect(fs.readdir(outside)).resolves.toEqual([]);
});

it("refuses unsafe content before anything is written", async () => {
  const token = `ghp_${"a".repeat(36)}`;
  await expect(
    writeSkillRootFile({
      skillsRoot,
      skillName: "deploy",
      filePath: "SKILL.md",
      content: skill("deploy", `export TOKEN=${token}`),
    }),
  ).rejects.toEqual(refusal("unsafe_content", /literal-secret.*placeholder/));
  await expect(fs.stat(path.join(skillsRoot, "deploy"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("parses frontmatter strictly for writes and leniently for reads", () => {
  expect(
    validateSkillFileContent({
      skillName: "deploy",
      filePath: "SKILL.md",
      content: skill("deploy"),
    }),
  ).toEqual({ description: "Deploy staging builds" });
  expect(() =>
    validateSkillFileContent({
      skillName: "deploy",
      filePath: "SKILL.md",
      content: skill("other"),
    }),
  ).toThrow(refusal("invalid_frontmatter", /name: deploy/));
  expect(() =>
    validateSkillFileContent({
      skillName: "deploy",
      filePath: "SKILL.md",
      content: skill("deploy"),
      maxSkillBytes: 10,
    }),
  ).toThrow(refusal("too_large"));
  expect(splitSkillFrontmatter("---\nname: [unclosed\n---\nBody")).toEqual({
    frontmatter: {},
    body: "Body",
  });
  expect(splitSkillFrontmatter(skill("deploy")).frontmatter.name).toBe("deploy");
});

it("dispatches skill_changed once per committed change and never for a failed one", async () => {
  const handler = vi.fn();
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
  const commit = (apply: () => Promise<void>) =>
    commitSkillRootChange({
      config: {},
      agentId: "main",
      skillsRoot,
      skillName: "deploy",
      source: "workshop",
      apply,
    });
  const write = (filePath: string, content: string) =>
    writeSkillRootFile({ skillsRoot, skillName: "deploy", filePath, content });

  await commit(async () => {
    await write("SKILL.md", skill("deploy"));
  });
  await commit(async () => {
    await write("references/notes.md", "Notes\n");
  });
  await expect(
    commit(async () => {
      await write("references/bad.md", `TOKEN=ghp_${"b".repeat(36)}`);
    }),
  ).rejects.toEqual(refusal("unsafe_content"));
  await commit(async () => {
    await removeSkillRootFile({ skillsRoot, skillName: "deploy", filePath: "references/notes.md" });
  });

  expect(handler.mock.calls.map(([event]) => event.action)).toEqual([
    "created",
    "updated",
    "updated",
  ]);
  const [created] = handler.mock.calls[0] ?? [];
  expect(created).toMatchObject({
    source: "workshop",
    after: { name: "deploy", skillKey: "deploy", skillDir: path.join(skillsRoot, "deploy") },
  });
  expect(created.before).toBeUndefined();
  await expect(
    readSkillDirFile(path.join(skillsRoot, "deploy"), "references/notes.md"),
  ).resolves.toBe(null);
  await expect(
    removeSkillRootFile({ skillsRoot, skillName: "deploy", filePath: "SKILL.md" }),
  ).rejects.toEqual(refusal("invalid_path"));
});

it("commits nothing once host authority is lost during an awaited write", async () => {
  const handler = vi.fn();
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
  let live = true;
  const assertCurrent = () => {
    if (!live) {
      throw new Error("plugin unavailable");
    }
  };
  await expect(
    commitSkillRootChange({
      config: {},
      agentId: "main",
      skillsRoot,
      skillName: "deploy",
      source: "workshop",
      assertCurrent,
      apply: async () => {
        await Promise.resolve();
        live = false;
        await writeSkillRootFile({
          skillsRoot,
          skillName: "deploy",
          filePath: "SKILL.md",
          content: skill("deploy"),
          assertCurrent,
        });
      },
    }),
  ).rejects.toThrow("plugin unavailable");
  await expect(fs.stat(path.join(skillsRoot, "deploy", "SKILL.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(handler).not.toHaveBeenCalled();
});

it("refuses SDK effects outside a plugin call", async () => {
  const sdk = await import("../../plugin-sdk/skill-authoring-runtime.js");
  await expect(
    sdk.writeSkillFile({
      config: {},
      agentId: "main",
      skillName: "deploy",
      filePath: "SKILL.md",
      content: skill("deploy"),
    }),
  ).rejects.toThrow(/must run inside a plugin call/);
});

it("validates plugin files with the same path contract writes enforce", async () => {
  const sdk = await import("../../plugin-sdk/skill-authoring-runtime.js");
  const validate = (filePath: string) =>
    sdk.validateSkillFile({ skillName: "deploy", filePath, content: "Notes\n" });
  expect(() => validate("../escape.md")).toThrow(refusal("invalid_path"));
  expect(() => validate("notes.md")).toThrow(refusal("invalid_path"));
  expect(validate("references/notes.md")).toEqual({});
});

it("commits nothing when the owning plugin is revoked during filesystem preparation", async () => {
  const sdk = await import("../../plugin-sdk/skill-authoring-runtime.js");
  const { PluginInstance } = await import("../../plugins/plugin-instance.js");
  const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
  const { createPluginRecord } = await import("../../plugins/status.test-helpers.js");
  const hook = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "skill_changed", handler: hook }]),
  );
  const record = createPluginRecord({ id: "authoring-owner", agentSkillsDir: "proof-skills" });
  const instance = new PluginInstance(record.id, {
    record,
    registry: { ...createEmptyPluginRegistry(), plugins: [record] },
  });
  // Redacted trace: phase names only, never paths or content.
  const trace: string[] = [];
  const realMkdir = fs.mkdir.bind(fs);
  let disposal: Promise<unknown> | undefined;
  const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
    const made = await realMkdir(target, options);
    if (String(target).endsWith(path.join("proof-skills", "deploy")) && !disposal) {
      // Authority was captured when the call began; revoke it before the final write.
      trace.push("prepare:skill-dir");
      disposal = instance.dispose();
      await vi.waitFor(() => expect(instance.owner?.revoked).toBe(true));
      trace.push("owner:revoked");
    }
    return made;
  });
  try {
    await expect(
      instance.run(() =>
        sdk.commitSkillChange({
          config: {},
          agentId: "main",
          skillName: "deploy",
          apply: async () => {
            trace.push("authority:captured");
            await sdk.writeSkillFile({
              config: {},
              agentId: "main",
              skillName: "deploy",
              filePath: "SKILL.md",
              content: skill("deploy"),
            });
            trace.push("write:committed");
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "PluginInstanceUnavailableError" });
    trace.push("refused");
  } finally {
    mkdir.mockRestore();
    await (disposal ?? instance.dispose());
  }
  expect(trace).toEqual(["authority:captured", "prepare:skill-dir", "owner:revoked", "refused"]);
  await expect(fs.stat(path.join(skillsRoot, "deploy", "SKILL.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(hook).not.toHaveBeenCalled();
});
