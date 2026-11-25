import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";

const tempDirs = createTrackedTempDirs();
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const snapshot = (
  skillDir: string,
  options: Partial<Parameters<typeof snapshotCommittedSkillArtifactBestEffort>[0]> = {},
) =>
  snapshotCommittedSkillArtifactBestEffort({
    skillDir,
    skillKey: "installed-key",
    source: "source-install",
    ...options,
  });

async function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  await tempDirs.cleanup();
});

describe("committed skill artifact snapshots", () => {
  it("preserves the ordered file-only digest and skill-file candidate priority", async () => {
    const skillDir = await tempDirs.make("openclaw-skill-change-");
    const content = Buffer.from(
      "---\nname: Declared Name\ndescription: Test skill\nversion: 1.2.3\n---\n\n# 🦞\n",
    );
    const legacyContent = Buffer.from("---\nname: Other candidate\n---\n");
    const nestedMetadata = Buffer.from([0, 255, 1]);
    const literalTildeContent = Buffer.from("literal support\n");
    const binary = Buffer.alloc(64 * 1024 + 7, 0xab);
    await fs.mkdir(path.join(skillDir, "empty-directory"));
    await writeFiles(skillDir, {
      ".clawhub/ignored.txt": "ignored",
      ".clawdhub/ignored.txt": "ignored",
      ".openclaw/ignored.txt": "ignored",
      "z.bin": binary,
      "SKILL.MD": legacyContent,
      "assets/empty.txt": "",
      "assets/.clawhub/retained.bin": nestedMetadata,
      "skills.md": content,
      "~/support.txt": literalTildeContent,
    });
    const expectedFiles = [
      { path: "SKILL.MD", sha256: digest(legacyContent), sizeBytes: legacyContent.byteLength },
      { path: "assets/.clawhub/retained.bin", sha256: digest(nestedMetadata), sizeBytes: 3 },
      { path: "assets/empty.txt", sha256: digest(""), sizeBytes: 0 },
      { path: "skills.md", sha256: digest(content), sizeBytes: content.byteLength },
      { path: "z.bin", sha256: digest(binary), sizeBytes: binary.byteLength },
      {
        path: "~/support.txt",
        sha256: digest(literalTildeContent),
        sizeBytes: literalTildeContent.byteLength,
      },
    ];

    await expect(
      snapshot(skillDir, {
        source: "clawhub",
        sourceVersion: "release-7",
      }),
    ).resolves.toEqual({
      name: "Declared Name",
      skillKey: "installed-key",
      description: "Test skill",
      skillFile: path.join(skillDir, "skills.md"),
      skillDir,
      source: "clawhub",
      revision: {
        declaredVersion: "1.2.3",
        contentSha256: `sha256:${digest(content)}`,
        treeSha256: `sha256:${digest(JSON.stringify(expectedFiles))}`,
        sourceVersion: "release-7",
      },
    });
  });

  it.each(["asset.bin"])("rejects a hardlink added before reading %s", async (name) => {
    const parent = await tempDirs.make("openclaw-skill-change-race-");
    const skillDir = path.join(parent, "skill");
    const targetPath = path.join(skillDir, name);
    const outsidePath = path.join(parent, "outside.bin");
    await writeFiles(skillDir, { "SKILL.md": "# Skill\n", "asset.bin": "original" });
    const warn = vi.fn();
    const read = vi.fn().mockRejectedValue(new Error("unexpected file read"));
    let linked = false;
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence: async (filePath, handle) => {
        if (filePath === targetPath) {
          __setFsSafeTestHooksForTest(undefined);
          vi.spyOn(handle, "read").mockImplementation(read);
          await fs.link(targetPath, outsidePath);
          linked = true;
        }
      },
    });

    await expect(snapshot(skillDir, { logger: { warn } })).resolves.toBeUndefined();
    expect(linked).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`hard-linked file "${name}"`));
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink entries without following them",
    async () => {
      const skillDir = await tempDirs.make("openclaw-skill-change-link-");
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill\n");
      await fs.symlink("missing", path.join(skillDir, "alias"));
      const warn = vi.fn();

      await expect(snapshot(skillDir, { logger: { warn } })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsupported entry "alias"'));
    },
  );

  it("keeps metadata and the content hash on the same captured file version", async () => {
    const parent = await tempDirs.make("openclaw-skill-change-version-");
    const skillDir = path.join(parent, "skill");
    const skillFile = path.join(skillDir, "SKILL.md");
    const replacement = path.join(parent, "replacement.md");
    const initialContent = "---\nname: Before\nversion: 1.0.0\n---\n";
    const replacementContent = "---\nname: After\nversion: 2.0.0\n---\n";
    await writeFiles(skillDir, { "SKILL.md": initialContent, "z.txt": "asset" });
    await fs.writeFile(replacement, replacementContent);
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence: async (filePath) => {
        if (filePath === path.join(skillDir, "z.txt")) {
          __setFsSafeTestHooksForTest(undefined);
          await fs.rename(replacement, skillFile);
        }
      },
    });

    await expect(snapshot(skillDir)).resolves.toMatchObject({
      name: "Before",
      revision: {
        declaredVersion: "1.0.0",
        contentSha256: `sha256:${digest(initialContent)}`,
      },
    });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(replacementContent);
  });
});

describe("committed skill change dispatch", () => {
  it("emits a committed mutation when artifact snapshots are unavailable", async () => {
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    await dispatchCommittedSkillChangeBestEffort({
      action: "created",
      source: "source-install",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        source: "source-install",
      }),
      { workspaceDir: "/tmp/openclaw-workspace" },
    );
  });
});
