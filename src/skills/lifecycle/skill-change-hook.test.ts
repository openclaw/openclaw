import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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

afterEach(async () => {
  resetGlobalHookRunner();
  await tempDirs.cleanup();
});

describe("committed skill artifact snapshots", () => {
  it("preserves the ordered file-only digest and declared metadata", async () => {
    const skillDir = await tempDirs.make("openclaw-skill-change-");
    const content = Buffer.from(
      "---\nname: Declared Name\ndescription: Test skill\nversion: 1.2.3\n---\n\n# 🦞\n",
    );
    const legacyContent = Buffer.from("---\nname: Other candidate\n---\n");
    const nestedMetadata = Buffer.from([0, 255, 1]);
    const literalTildeContent = Buffer.from("literal support\n");
    const binary = Buffer.alloc(64 * 1024 + 7, 0xab);
    await fs.mkdir(path.join(skillDir, "assets", ".clawhub"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "empty-directory"));
    await fs.mkdir(path.join(skillDir, "~"));
    for (const excluded of [".clawhub", ".clawdhub", ".openclaw"]) {
      await fs.mkdir(path.join(skillDir, excluded));
      await fs.writeFile(path.join(skillDir, excluded, "ignored.txt"), "ignored");
    }
    await fs.writeFile(path.join(skillDir, "z.bin"), binary);
    await fs.writeFile(path.join(skillDir, "skills.md"), legacyContent);
    await fs.writeFile(path.join(skillDir, "assets", "empty.txt"), "");
    await fs.writeFile(path.join(skillDir, "assets", ".clawhub", "retained.bin"), nestedMetadata);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), content);
    await fs.writeFile(path.join(skillDir, "~", "support.txt"), literalTildeContent);

    const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
    const expectedFiles = [
      { path: "SKILL.md", sha256: digest(content), sizeBytes: content.byteLength },
      { path: "assets/.clawhub/retained.bin", sha256: digest(nestedMetadata), sizeBytes: 3 },
      { path: "assets/empty.txt", sha256: digest(""), sizeBytes: 0 },
      { path: "skills.md", sha256: digest(legacyContent), sizeBytes: legacyContent.byteLength },
      { path: "z.bin", sha256: digest(binary), sizeBytes: binary.byteLength },
      {
        path: "~/support.txt",
        sha256: digest(literalTildeContent),
        sizeBytes: literalTildeContent.byteLength,
      },
    ];

    await expect(
      snapshotCommittedSkillArtifactBestEffort({
        skillDir,
        skillKey: "installed-key",
        source: "clawhub",
        sourceVersion: "release-7",
      }),
    ).resolves.toEqual({
      name: "Declared Name",
      skillKey: "installed-key",
      description: "Test skill",
      skillFile: path.join(skillDir, "SKILL.md"),
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

  it("rejects a hardlink substituted after entry inspection", async () => {
    const parent = await tempDirs.make("openclaw-skill-change-race-");
    const skillDir = path.join(parent, "skill");
    const assetPath = path.join(skillDir, "asset.bin");
    const outsidePath = path.join(parent, "outside.bin");
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill\n");
    await fs.writeFile(assetPath, "original");
    await fs.writeFile(outsidePath, "outside");
    const warn = vi.fn();
    const lstat = fs.lstat.bind(fs);
    let substituted = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === assetPath) {
        lstatSpy.mockRestore();
        await fs.unlink(assetPath);
        await fs.link(outsidePath, assetPath);
        substituted = true;
      }
      return stat;
    });
    try {
      await expect(
        snapshotCommittedSkillArtifactBestEffort({
          skillDir,
          skillKey: "installed-key",
          source: "source-install",
          logger: { warn },
        }),
      ).resolves.toBeUndefined();
      expect(substituted).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not snapshot committed skill change:"),
      );
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("keeps metadata and the content hash on the same captured file version", async () => {
    const parent = await tempDirs.make("openclaw-skill-change-version-");
    const skillDir = path.join(parent, "skill");
    const skillFile = path.join(skillDir, "SKILL.md");
    const laterAsset = path.join(skillDir, "z.txt");
    const replacement = path.join(parent, "replacement.md");
    const initialContent = "---\nname: Before\nversion: 1.0.0\n---\n";
    const replacementContent = "---\nname: After\nversion: 2.0.0\n---\n";
    await fs.mkdir(skillDir);
    await fs.writeFile(skillFile, initialContent);
    await fs.writeFile(laterAsset, "asset");
    await fs.writeFile(replacement, replacementContent);
    const lstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === laterAsset) {
        lstatSpy.mockRestore();
        await fs.rename(replacement, skillFile);
      }
      return stat;
    });
    try {
      await expect(
        snapshotCommittedSkillArtifactBestEffort({
          skillDir,
          skillKey: "installed-key",
          source: "source-install",
        }),
      ).resolves.toMatchObject({
        name: "Before",
        revision: {
          declaredVersion: "1.0.0",
          contentSha256: `sha256:${createHash("sha256").update(initialContent).digest("hex")}`,
        },
      });
      await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(replacementContent);
    } finally {
      lstatSpy.mockRestore();
    }
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
