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
  "# TOOLS.md - Local Notes\n\nSkills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.\n\n## Examples\n\n```markdown\n### Cameras\n\n- living-room → Main area, 180° wide angle\n- front-door → Entrance, motion-triggered\n\n" +
  "### SSH\n\n- home-server → 192.168.1.100, user: admin\n\n### TTS\n\n" +
  '- Preferred voice: "Nova" (warm, slightly British)\n- Default speaker: Kitchen HomePod\n```\n\n## Why Separate?\n\n' +
  "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.\n\n---\n\nAdd whatever helps you do your job. This is your cheat sheet.\n\n## Related\n\n- [Agent workspace](/concepts/agent-workspace)\n";

afterEach(() => {
  noteMock.mockReset();
  vi.restoreAllMocks();
});

const DEFAULT_AGENTS = "# Agent\n\n## Tools\n\nExisting notes.\n";
const DEFAULT_TOOLS = "### Cameras\n\n- kitchen → wide angle\n";

async function createFixture(
  agents: string | null = DEFAULT_AGENTS,
  tools: string | Buffer = DEFAULT_TOOLS,
) {
  const root = await fs.realpath(tempDirs.make("openclaw-tools-md-migration-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const cfg = {
    agents: { entries: { main: { workspace } } },
  } as OpenClawConfig;
  const fixture = {
    root,
    stateDir,
    workspace,
    cfg,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    agentsPath: path.join(workspace, "AGENTS.md"),
    toolsPath: path.join(workspace, "TOOLS.md"),
  };
  if (agents !== null) {
    await fs.writeFile(fixture.agentsPath, agents);
  }
  await fs.writeFile(fixture.toolsPath, tools);
  return {
    ...fixture,
    migrate: (shouldRepair = true) => maybeMigrateToolsMd({ cfg, env: fixture.env, shouldRepair }),
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

function expectSuccess(result: Awaited<ReturnType<typeof maybeMigrateToolsMd>>) {
  expect(result).toEqual({ warnings: [], changes: [expect.any(String)] });
}

async function expectMigrated(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  expected: string,
  tools: string,
) {
  await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(expected);
  await expect(readOnlyArchive(fixture.stateDir)).resolves.toEqual(Buffer.from(tools));
  await expectMissing(fixture.toolsPath);
}

async function expectUnchanged(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  agents: string,
  tools: string | Buffer,
) {
  expect(await fs.readFile(fixture.agentsPath, "utf8")).toBe(agents);
  expect(await fs.readFile(fixture.toolsPath)).toEqual(Buffer.from(tools));
}

describe("TOOLS.md migration", () => {
  it("previews the migration without mutating or archiving workspace files", async () => {
    const fixture = await createFixture();
    await expect(collectToolsMdMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/tools-md-migration",
        requirement: "legacy-tools-md",
      }),
    ]);
    await expect(fixture.migrate(false)).resolves.toEqual({ changes: [], warnings: [] });
    await expectUnchanged(fixture, DEFAULT_AGENTS, DEFAULT_TOOLS);
    await expectMissing(fixture.stateDir);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("will be archived and merged into AGENTS.md when customized"),
      "TOOLS.md migration preview",
    );
  });
  it("refuses to migrate a TOOLS.md whose bytes are not valid UTF-8", async () => {
    const toolsBytes = Buffer.from([0xff, 0xfe]);
    const fixture = await createFixture(DEFAULT_AGENTS, toolsBytes);
    expect(await fixture.migrate()).toEqual({
      changes: [],
      warnings: [expect.stringContaining("is not valid UTF-8")],
    });
    await expectUnchanged(fixture, DEFAULT_AGENTS, toolsBytes);
    await expectMissing(path.join(fixture.stateDir, "backups", "tools-md-migration"));
  });
  it("preserves customized content and ownership under restrictive umask and is idempotent", async () => {
    const agents = "# Agent\n\n## Tools\n\nExisting notes.\n\n## Safety\n\nBe careful.\n";
    const tools = "### Cameras\n\n- kitchen → wide angle\n\nKeep trailing spaces.  \n";
    const fixture = await createFixture(agents, tools);
    const expected =
      "# Agent\n\n## Tools\n\nExisting notes.\n\n" +
      "### Local notes (migrated from TOOLS.md)\n\n" +
      tools +
      "\n## Safety\n\nBe careful.\n";
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
    expectSuccess(result);
    await expectMigrated(fixture, expected, tools);
    if (process.platform !== "win32") {
      expect((await fs.stat(fixture.workspace)).mode & 0o777).toBe(0o751);
      const { mode, uid, gid } = await fs.stat(fixture.agentsPath);
      expect({ mode: mode & 0o777, uid, gid }).toEqual({
        mode: 0o640,
        uid: originalAgentsStat.uid,
        gid: originalAgentsStat.gid,
      });
    }
    await expect(fixture.migrate()).resolves.toEqual({ changes: [], warnings: [] });
    const rerunAgents = await fs.readFile(fixture.agentsPath, "utf8");
    expect(rerunAgents).toBe(expected);
    expect(rerunAgents.match(/migrated from TOOLS\.md/gu)).toHaveLength(1);
  });
  it.skipIf(process.platform === "win32").each([
    { when: "before migration", mode: 0o600, warning: "additional POSIX readers" },
    { when: "during source revalidation", mode: 0o640, warning: "TOOLS.md changed" },
    { when: "ownership cannot be preserved", mode: 0o644, warning: "synthetic chown refusal" },
  ])("retains notes when $when without granting destination readers", async ({ mode, warning }) => {
    const tools = "Private local notes.\n";
    const fixture = await createFixture(DEFAULT_AGENTS, tools);
    await fs.chmod(fixture.agentsPath, 0o640);
    await fs.chmod(fixture.toolsPath, mode);
    const original = await fs.stat(fixture.agentsPath);
    let replacementOpened = false;
    let sourceTightened = false;
    let grantedGroupRead = false;
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(`${fixture.agentsPath}.doctor-writing-`)) {
        replacementOpened = true;
        if (mode === 0o644) {
          vi.spyOn(handle, "chown").mockImplementation(async () => {
            expect((await handle.stat()).mode & 0o7777).toBe(0);
            throw new Error("synthetic chown refusal");
          });
        }
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
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          const result = await read(...readArgs);
          await fs.chmod(fixture.toolsPath, 0o600);
          sourceTightened = true;
          return result;
        });
      }
      return handle;
    });
    const result = await fixture.migrate();
    expect(result).toEqual({ changes: [], warnings: [expect.stringContaining(warning)] });
    expect(sourceTightened).toBe(mode === 0o640);
    expect(grantedGroupRead).toBe(false);
    await expectUnchanged(fixture, DEFAULT_AGENTS, tools);
    expect(await fs.stat(fixture.agentsPath)).toMatchObject({
      uid: original.uid,
      gid: original.gid,
      mode: original.mode,
    });
    expect((await fs.readdir(fixture.workspace)).toSorted()).toEqual(["AGENTS.md", "TOOLS.md"]);
  });
  it("creates a private destination for private notes when AGENTS.md is absent", async () => {
    const tools = "Private local notes.\n";
    const fixture = await createFixture(null, tools);
    if (process.platform !== "win32") {
      await fs.chmod(fixture.toolsPath, 0o600);
    }
    const result = await fixture.migrate();
    expectSuccess(result);
    await expectMigrated(
      fixture,
      `## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
      tools,
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(fixture.agentsPath)).mode & 0o777).toBe(0o600);
    }
  });
  it("checks every agent budget while migrating a shared workspace once", async () => {
    const agents = `# Agent\n\n## Tools\n\n${"a".repeat(15_000)}\n`;
    const tools = `${"b".repeat(15_000)}\n`;
    const fixture = await createFixture(agents, tools);
    const merged = `${agents}\n### Local notes (migrated from TOOLS.md)\n\n${tools}`;
    fixture.cfg.agents!.entries = {
      main: { workspace: fixture.workspace, bootstrapMaxChars: 40_000 },
      limited: { workspace: fixture.workspace, bootstrapMaxChars: 20_000 },
    };
    const findings = await collectToolsMdMigrationFindings(fixture.cfg);
    expect(
      findings.filter((finding) => finding.requirement === "tools-md-merged-bootstrap-limit"),
    ).toEqual([
      expect.objectContaining({
        target: "limited",
        message: `Agent "limited" TOOLS.md migration will produce a ${merged.length}-character AGENTS.md, exceeding its configured bootstrapMaxChars limit of 20000. Raise \`agents.entries.*.bootstrapMaxChars\` for this agent, or \`agents.defaults.bootstrapMaxChars\` as fallback, to preserve all migrated instructions.`,
      }),
    ]);
    const result = await fixture.migrate();
    expect(result).toMatchObject({ changes: [expect.any(String)], warnings: [] });
    await expectMigrated(fixture, merged, tools);
  });
  it("rewrites the lesson reminder without leaving a TOOLS.md directive", async () => {
    const legacy = "- When you learn a lesson → update AGENTS.md, TOOLS.md, or the relevant skill";
    const current = "- When you learn a lesson → update AGENTS.md or the relevant skill";
    const fixture = await createFixture(
      `# Agent\n\n## Tools\n\n${legacy}\n`,
      LEGACY_TOOLS_MD_TEMPLATE_FIXTURE,
    );
    const result = await fixture.migrate();
    expect(result.warnings).toEqual([]);
    const migratedAgents = await fs.readFile(fixture.agentsPath, "utf8");
    expect(migratedAgents).toContain(current);
    expect(migratedAgents).not.toContain(legacy);
    expect(migratedAgents).not.toContain("TOOLS.md");
    await expectMissing(fixture.toolsPath);
  });
  it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
    "refuses AGENTS.md %s aliases",
    async (kind) => {
      const linkedFixture = await createFixture(null, "Local tool notes.\n");
      const linkedTarget = path.join(linkedFixture.root, "outside-agents.md");
      await fs.writeFile(linkedTarget, "Private external instructions.\n");
      if (kind === "symlink") {
        await fs.symlink(linkedTarget, linkedFixture.agentsPath);
      } else {
        await fs.link(linkedTarget, linkedFixture.agentsPath);
      }
      const linkedResult = await linkedFixture.migrate();
      expect(linkedResult).toEqual({
        changes: [],
        warnings: [expect.stringContaining("AGENTS.md must be an unlinked regular file")],
      });
      await expect(fs.readFile(linkedFixture.toolsPath, "utf8")).resolves.toBe(
        "Local tool notes.\n",
      );
      await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe(
        "Private external instructions.\n",
      );
    },
  );
  it.each(["interrupted write", "already merged"])(
    "converges after %s without duplicating content",
    async (phase) => {
      const fixture = await createFixture();
      const merged = `${DEFAULT_AGENTS}\n### Local notes (migrated from TOOLS.md)\n\n${DEFAULT_TOOLS}`;
      if (phase === "interrupted write") {
        await fs.writeFile(
          `${fixture.agentsPath}.doctor-writing-999999-interrupted`,
          "partial merged content",
        );
      } else {
        await fs.writeFile(fixture.agentsPath, merged);
      }
      const result = await fixture.migrate();
      expect(result.warnings).toEqual([]);
      await expectMigrated(fixture, merged, DEFAULT_TOOLS);
      if (phase === "interrupted write") {
        expect(result.changes).toHaveLength(1);
        await expect(fs.readdir(fixture.workspace)).resolves.toEqual(["AGENTS.md"]);
      } else {
        expect(
          (await fs.readFile(fixture.agentsPath, "utf8")).match(/migrated from TOOLS\.md/gu),
        ).toHaveLength(1);
      }
    },
  );
  it("appends a Tools section when AGENTS.md has no Tools heading", async () => {
    const agents = "# Agent\n\nKeep safe.";
    const tools = "Local camera: kitchen → wide angle\n";
    const fixture = await createFixture(agents, tools);
    await fixture.migrate();
    await expect(fs.readFile(fixture.agentsPath, "utf8")).resolves.toBe(
      `${agents}\n\n## Tools\n\n### Local notes (migrated from TOOLS.md)\n\n${tools}`,
    );
    await expectMissing(fixture.toolsPath);
  });
  it("keeps TOOLS.md untouched when the original cannot be archived", async () => {
    const tools = "Local camera: kitchen → wide angle\n";
    const fixture = await createFixture(DEFAULT_AGENTS, tools);
    await fs.writeFile(fixture.stateDir, "not a directory");
    const result = await fixture.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    await expectUnchanged(fixture, DEFAULT_AGENTS, tools);
  });
});
