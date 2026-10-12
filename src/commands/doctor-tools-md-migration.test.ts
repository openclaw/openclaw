import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

import { note } from "../../packages/terminal-core/src/note.js";
import {
  collectToolsMdMigrationFindings,
  maybeMigrateToolsMd,
} from "./doctor-tools-md-migration.js";

const noteMock = vi.mocked(note);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LEGACY_TOOLS_MD_TEMPLATE_FIXTURE =
  [
    "# TOOLS.md - Local Notes",
    "",
    "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.",
    "",
    "## Examples",
    "",
    "```markdown",
    "### Cameras",
    "",
    "- living-room → Main area, 180° wide angle",
    "- front-door → Entrance, motion-triggered",
    "",
    "### SSH",
    "",
    "- home-server → 192.168.1.100, user: admin",
    "",
    "### TTS",
    "",
    '- Preferred voice: "Nova" (warm, slightly British)',
    "- Default speaker: Kitchen HomePod",
    "```",
    "",
    "## Why Separate?",
    "",
    "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.",
    "",
    "---",
    "",
    "Add whatever helps you do your job. This is your cheat sheet.",
    "",
    "## Related",
    "",
    "- [Agent workspace](/concepts/agent-workspace)",
  ].join("\n") + "\n";
const LEGACY_AGENTS_GUIDANCE_REWRITES = [
  [
    "generic workspace template",
    "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.",
    "Skills define how tools work. Keep environment-specific local notes in this section.",
  ],
  [
    "default template lowercase parenthetical",
    "- Keep environment-specific notes in `TOOLS.md` (notes for skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "default template title-case parenthetical",
    "- Keep environment-specific notes in `TOOLS.md` (Notes for Skills).",
    "- Keep environment-specific notes in this file's `## Tools` section.",
  ],
  [
    "current lesson reminder",
    "- You learn a lesson -> update `AGENTS.md`, `TOOLS.md`, or the relevant skill.",
    "- You learn a lesson -> update `AGENTS.md` or the relevant skill.",
  ],
  [
    "original lesson reminder",
    "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill",
    "- When you learn a lesson → update AGENTS.md or the relevant skill",
  ],
  [
    "Chinese generic template with English Skills",
    "Skills 提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "Skills 定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "Chinese generic template",
    "技能提供你的工具。当你需要某个工具时，查看它的 `SKILL.md`。在 `TOOLS.md` 中保存本地笔记（摄像头名称、SSH 详情、语音偏好等）。",
    "技能定义工具的使用方式。请将环境特定的本地笔记保存在本节中。",
  ],
  [
    "Chinese default template",
    "- 在 `TOOLS.md` 中保存环境特定的笔记（Skills 注意事项）。",
    "- 将环境特定的笔记保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese default template with Skills",
    "- 将环境相关的备注保存在 `TOOLS.md`（Skills 备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese default template with translated skills",
    "- 将环境相关的备注保存在 `TOOLS.md`（技能备注）中。",
    "- 将环境相关的备注保存在本文件的 `## Tools` 部分。",
  ],
  [
    "Chinese lesson reminder with Skills",
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关 Skills 文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关 Skills 文件",
  ],
  [
    "Chinese lesson reminder with translated skills",
    "- 当你学到教训 → 更新 AGENTS.md、TOOLS.md 或相关技能文件",
    "- 当你学到教训 → 更新 AGENTS.md 或相关技能文件",
  ],
] as const;

afterEach(() => {
  noteMock.mockReset();
});

async function createFixture() {
  const root = await fs.realpath(tempDirs.make("openclaw-tools-md-migration-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const cfg = {
    agents: { entries: { main: { workspace } } },
  } as OpenClawConfig;
  return {
    root,
    stateDir,
    workspace,
    cfg,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    agentsPath: path.join(workspace, "AGENTS.md"),
    toolsPath: path.join(workspace, "TOOLS.md"),
  };
}

async function readOnlyArchive(stateDir: string): Promise<Buffer> {
  const archiveDir = path.join(stateDir, "backups", "tools-md-migration");
  const archives = await fs.readdir(archiveDir);
  expect(archives).toHaveLength(1);
  return fs.readFile(path.join(archiveDir, archives[0]!));
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("TOOLS.md migration", () => {
  it("previews the migration without mutating or archiving workspace files", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/tools-md-migration",
        requirement: "legacy-tools-md",
      }),
    ]);

    await expect(
      maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: false,
        env: fixture.env,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });

    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
    await expectMissing(fixture.stateDir);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("will be archived and merged into AGENTS.md when customized"),
      "TOOLS.md migration preview",
    );
  });

  it("preserves customized content and ownership under restrictive umask and is idempotent", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n\n## Safety\n\nBe careful.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n\nKeep trailing spaces.  \n";
    const expected =
      "# Agent\n\n## Tools\n\nExisting notes.\n\n" +
      "### Local notes (migrated from TOOLS.md)\n\n" +
      tools +
      "\n## Safety\n\nBe careful.\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);
    if (process.platform !== "win32") {
      await fs.chmod(fixture.workspace, 0o751);
      const currentGroup = (await fs.stat(fixture.agentsPath)).gid;
      const otherGroup = process.getgroups?.().find((group) => group !== currentGroup);
      if (otherGroup !== undefined) {
        await fs.chown(fixture.agentsPath, -1, otherGroup);
        await fs.chown(fixture.toolsPath, -1, otherGroup);
      }
      await fs.chmod(fixture.agentsPath, 0o640);
      await fs.chmod(fixture.toolsPath, 0o640);
    }
    const originalAgentsStat = await fs.stat(fixture.agentsPath);

    const child = await runCliProcessChild({
      nodeArgs: [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "--eval",
        `
          import { maybeMigrateToolsMd } from ${JSON.stringify(new URL("./doctor-tools-md-migration.ts", import.meta.url).href)};
          if (process.platform !== "win32") process.umask(0o077);
          const result = await maybeMigrateToolsMd({
            cfg: ${JSON.stringify(fixture.cfg)},
            shouldRepair: true,
          });
          process.stdout.write(JSON.stringify(result));
        `,
      ],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        OPENCLAW_STATE_DIR: fixture.stateDir,
        OPENCLAW_SUPPRESS_NOTES: "1",
        TMPDIR: fixture.root,
        TEMP: fixture.root,
        TMP: fixture.root,
      },
    });
    expect(child.code, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(expected);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);
    if (process.platform !== "win32") {
      expect((await fs.stat(fixture.workspace)).mode & 0o777).toBe(0o751);
      expect((await fs.stat(fixture.agentsPath)).mode & 0o777).toBe(0o640);
      expect(await fs.stat(fixture.agentsPath)).toMatchObject({
        uid: originalAgentsStat.uid,
        gid: originalAgentsStat.gid,
      });
    }

    await expect(
      maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    const rerunAgents = await fs.readFile(fixture.agentsPath, "utf8");
    expect(rerunAgents).toBe(expected);
    expect(rerunAgents.match(/migrated from TOOLS\.md/gu)).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32").each([
    { when: "before migration", mode: 0o600, warning: "additional POSIX readers" },
    { when: "during source revalidation", mode: 0o640, warning: "TOOLS.md changed" },
  ])(
    "retains notes made private $when without granting destination readers",
    async ({ mode, warning }) => {
      const fixture = await createFixture();
      const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
      const tools = "Private local notes.\n";
      await fs.writeFile(fixture.agentsPath, agents);
      await fs.writeFile(fixture.toolsPath, tools);
      await fs.chmod(fixture.agentsPath, 0o640);
      await fs.chmod(fixture.toolsPath, mode);
      const original = await fs.stat(fixture.agentsPath);
      let replacementOpened = false;
      let sourceTightened = false;
      let grantedGroupRead = false;
      const open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(`${fixture.agentsPath}.doctor-writing-`)) {
          replacementOpened = true;
          const chmod = handle.chmod.bind(handle);
          vi.spyOn(handle, "chmod").mockImplementation(async (newMode) => {
            await chmod(newMode);
            grantedGroupRead ||= ((await handle.stat()).mode & 0o040) !== 0;
          });
        } else if (
          String(args[0]) === fixture.toolsPath &&
          replacementOpened &&
          mode === 0o640 &&
          !sourceTightened
        ) {
          const readFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementationOnce(async () => {
            const content = await readFile();
            await fs.chmod(fixture.toolsPath, 0o600);
            sourceTightened = true;
            return content;
          });
        }
        return handle;
      });

      try {
        const result = await maybeMigrateToolsMd({
          cfg: fixture.cfg,
          shouldRepair: true,
          env: fixture.env,
        });

        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([expect.stringContaining(warning)]);
        expect(sourceTightened).toBe(mode === 0o640);
        expect(grantedGroupRead).toBe(false);
        await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
        await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
        expect(await fs.stat(fixture.agentsPath)).toMatchObject({
          uid: original.uid,
          gid: original.gid,
          mode: original.mode,
        });
        expect((await fs.readdir(fixture.workspace)).toSorted()).toEqual(["AGENTS.md", "TOOLS.md"]);
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it("creates a private destination for private notes when AGENTS.md is absent", async () => {
    const fixture = await createFixture();
    const tools = "Private local notes.\n";
    await fs.writeFile(fixture.toolsPath, tools);
    if (process.platform !== "win32") {
      await fs.chmod(fixture.toolsPath, 0o600);
    }

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(
      `## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(fixture.agentsPath)).mode & 0o777).toBe(0o600);
    }
    await expectMissing(fixture.toolsPath);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
  });

  it.skipIf(process.platform === "win32")(
    "retains both files when replacement ownership cannot be preserved",
    async () => {
      const fixture = await createFixture();
      const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
      const tools = "Local tool notes.\n";
      await fs.writeFile(fixture.agentsPath, agents);
      await fs.writeFile(fixture.toolsPath, tools);
      await fs.chmod(fixture.agentsPath, 0o640);
      await fs.chmod(fixture.toolsPath, 0o644);
      const original = await fs.stat(fixture.agentsPath);
      const open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).startsWith(`${fixture.agentsPath}.doctor-writing-`)) {
          vi.spyOn(handle, "chown").mockImplementation(async () => {
            expect((await handle.stat()).mode & 0o7777).toBe(0);
            throw new Error("synthetic chown refusal");
          });
        }
        return handle;
      });
      try {
        const result = await maybeMigrateToolsMd({
          cfg: fixture.cfg,
          shouldRepair: true,
          env: fixture.env,
        });
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([expect.stringContaining("synthetic chown refusal")]);
        await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
        await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
        expect(await fs.stat(fixture.agentsPath)).toMatchObject({
          uid: original.uid,
          gid: original.gid,
          mode: original.mode,
        });
        expect((await fs.readdir(fixture.workspace)).toSorted()).toEqual(["AGENTS.md", "TOOLS.md"]);
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it("checks every agent budget while migrating a shared workspace once", async () => {
    const fixture = await createFixture();
    const agents = `# Agent\n\n## Tools\n\n${"a".repeat(15_000)}\n`;
    const tools = `${"b".repeat(15_000)}\n`;
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    fixture.cfg.agents!.entries = {
      main: { workspace: fixture.workspace, bootstrapMaxChars: 40_000 },
      limited: { workspace: fixture.workspace, bootstrapMaxChars: 20_000 },
    };
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const findings = await collectToolsMdMigrationFindings(fixture.cfg);

    expect(
      findings.filter((finding) => finding.requirement === "tools-md-merged-bootstrap-limit"),
    ).toEqual([
      expect.objectContaining({
        target: "limited",
        message: `Agent "limited" TOOLS.md migration will produce a ${merged.length}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of 20000. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`,
      }),
    ]);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result).toMatchObject({ changes: [expect.any(String)], warnings: [] });
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(merged);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);
  });

  it.each(LEGACY_AGENTS_GUIDANCE_REWRITES)(
    "rewrites the %s without leaving a TOOLS.md directive",
    async (_label, legacy, current) => {
      const fixture = await createFixture();
      await fs.writeFile(fixture.agentsPath, `# Agent\n\n## Tools\n\n${legacy}\n`);
      await fs.writeFile(fixture.toolsPath, LEGACY_TOOLS_MD_TEMPLATE_FIXTURE);

      const result = await maybeMigrateToolsMd({
        cfg: fixture.cfg,
        shouldRepair: true,
        env: fixture.env,
      });

      expect(result.warnings).toEqual([]);
      const migratedAgents = await fs.readFile(fixture.agentsPath, "utf8");
      expect(migratedAgents).toContain(current);
      expect(migratedAgents).not.toContain(legacy);
      expect(migratedAgents).not.toContain("TOOLS.md");
      await expectMissing(fixture.toolsPath);
    },
  );

  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "refuses AGENTS.md %s aliases",
    async (kind) => {
      const linkedFixture = await createFixture();
      const linkedTarget = path.join(linkedFixture.root, "outside-agents.md");
      await fs.writeFile(linkedTarget, "Private external instructions.\n");
      await fs.writeFile(linkedFixture.toolsPath, "Local tool notes.\n");
      if (kind === "symlink") {
        await fs.symlink(linkedTarget, linkedFixture.agentsPath);
      } else {
        await fs.link(linkedTarget, linkedFixture.agentsPath);
      }

      const linkedResult = await maybeMigrateToolsMd({
        cfg: linkedFixture.cfg,
        shouldRepair: true,
        env: linkedFixture.env,
      });

      expect(linkedResult.changes).toEqual([]);
      expect(linkedResult.warnings).toEqual([
        expect.stringContaining("AGENTS.md must be an unlinked regular file"),
      ]);
      await expect(fs.readFile(linkedFixture.toolsPath, "utf8")).resolves.toBe(
        "Local tool notes.\n",
      );
      await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe(
        "Private external instructions.\n",
      );
    },
  );

  it("reruns after an interrupted AGENTS.md temp write and converges", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    const tempPath = `${fixture.agentsPath}.doctor-writing-999999-interrupted`;
    await fs.writeFile(fixture.toolsPath, tools);
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(tempPath, "partial merged content");

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(merged);
    await expect(fs.readdir(fixture.workspace)).resolves.toEqual(["AGENTS.md"]);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
  });

  it("finishes cleanup without duplicating already-merged content", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n";
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    await fs.writeFile(fixture.agentsPath, merged);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(merged);
    expect(
      (await fs.readFile(fixture.agentsPath, "utf8")).match(/migrated from TOOLS\.md/gu),
    ).toHaveLength(1);
    await expectMissing(fixture.toolsPath);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
  });

  it("appends a Tools section when AGENTS.md has no Tools heading", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\nKeep safe.";
    const tools = "Local camera: kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(
      `${agents}\n\n## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
    );
    await expectMissing(fixture.toolsPath);
  });

  it.each([
    ["untouched template", LEGACY_TOOLS_MD_TEMPLATE_FIXTURE],
    ["whitespace-only file", " \n\t"],
  ])("deletes the %s without appending content", async (_label, tools) => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nLocal details stay unchanged.\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
    await expectMissing(fixture.toolsPath);
  });

  it("keeps TOOLS.md untouched when the original cannot be archived", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "Local camera: kitchen → wide angle\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);
    await fs.writeFile(fixture.stateDir, "not a directory");

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath, "utf8")).resolves.toBe(tools);
  });

  it("rejects malformed UTF-8 TOOLS.md before rewriting AGENTS.md", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = Buffer.concat([
      Buffer.from("### Cameras\n\n- kitchen "),
      Buffer.from([0xff]),
      Buffer.from(" wide\n"),
    ]);
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /TOOLS\.md must be valid UTF-8[\s\S]*left untouched[\s\S]*doctor --fix/,
      ),
    ]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(agents);
    await expect(fs.readFile(fixture.toolsPath)).resolves.toEqual(tools);
  });

  it("migrates valid Unicode TOOLS.md including a literal replacement character", async () => {
    const fixture = await createFixture();
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n";
    const tools = "### 摄像头\n\n- kitchen → 合法 � 😀\n";
    await fs.writeFile(fixture.agentsPath, agents);
    await fs.writeFile(fixture.toolsPath, tools);

    const result = await maybeMigrateToolsMd({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toContain(tools);
    await expectMissing(fixture.toolsPath);
  });
});
