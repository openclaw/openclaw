import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import type { SkillEntry } from "../../skills/types.js";
import { skillsFilesHandlers } from "./skills-files.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const { discovered } = vi.hoisted(() => ({ discovered: vi.fn() }));
// mock-isolation: Admit a fixed catalog while exercising real file reads, without discovery workers.
vi.mock("../../skills/loading/workspace-skill-loader.js", () => ({
  prepareWorkspaceSkillEntries: discovered,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let directory: string;
let skillDir: string;
let skillPath: string;
let config: OpenClawConfig;
let entries: [SkillEntry];
const content =
  "---\nname: release-notes\ndescription: Write clear release notes.\n---\n# Release notes\n";

function read(requestPath = skillPath, agentId = "main") {
  return callGatewayHandler(
    skillsFilesHandlers,
    "skills.files.get",
    { agentId, path: requestPath },
    { context: { getRuntimeConfig: () => config } },
  );
}

beforeEach(async () => {
  directory = tempDirs.make("skill-file-preview-");
  skillDir = path.join(directory, "installed", "release-notes");
  skillPath = path.join(skillDir, "SKILL.md");
  const workspace = path.join(directory, "workspace");
  config = { agents: { entries: { main: { workspace } } } };
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(skillPath, content);
  entries = [
    {
      frontmatter: {},
      skill: createCanonicalFixtureSkill({
        name: "release-notes",
        description: "Write clear release notes.",
        filePath: skillPath,
        baseDir: skillDir,
        source: "openclaw-managed",
      }),
    },
  ];
  discovered.mockResolvedValue({ entries });
});
afterEach(() => vi.clearAllMocks());

describe("skills.files.get", () => {
  it("reads an installed skill outside the workspace and returns live edits", async () => {
    expect(await read()).toMatchObject({
      ok: true,
      response: { path: skillPath, name: "release-notes", content },
    });
    await fs.writeFile(skillPath, `${content}\nUpdated on disk.\n`);
    expect(await read()).toMatchObject({
      ok: true,
      response: { content: `${content}\nUpdated on disk.\n` },
    });
    expect((await read("../installed/release-notes/SKILL.md")).ok).toBe(true);
    expect((await read(pathToFileURL(skillPath).href)).ok).toBe(true);
  });

  it("rejects unknown agents and files outside the discovered skill allowlist", async () => {
    expect((await read(skillPath, "unknown")).ok).toBe(false);
    const privateFile = path.join(directory, "SKILL.md");
    await fs.writeFile(privateFile, "private");
    expect((await read(privateFile)).ok).toBe(false);
    expect((await read(path.join(skillDir, "..", "..", "SKILL.md"))).ok).toBe(false);
    expect((await read("SKILL.md")).ok).toBe(false);
  });

  it("accepts a skill-directory alias without allowing final symlink escapes or hardlinks", async () => {
    const alias = path.join(directory, "alias");
    await fs.symlink(skillDir, alias);
    expect((await read(path.join(alias, "SKILL.md"))).ok).toBe(true);
    const privateFile = path.join(directory, "private.md");
    await fs.writeFile(privateFile, "private");
    for (const link of [fs.symlink, fs.link]) {
      await fs.unlink(skillPath);
      await link(privateFile, skillPath);
      expect((await read()).ok).toBe(false);
    }
  });

  it("preserves bundled hardlink support and rejects files over the discovery byte limit", async () => {
    const source = path.join(directory, "package.md");
    await fs.writeFile(source, content);
    await fs.unlink(skillPath);
    await fs.link(source, skillPath);
    entries[0].skill.source = "openclaw-bundled";
    expect((await read()).ok).toBe(true);
    await fs.writeFile(skillPath, "x".repeat(256_001));
    expect((await read()).ok).toBe(false);
  });

  it("never reads a remote workspace or node skill from the Gateway filesystem", async () => {
    entries[0].skill.fileHost = "workspace";
    expect((await read()).ok).toBe(false);
    entries[0].skill.fileHost = "gateway";
    entries[0].skill.filePath = "node://remote/release-notes/SKILL.md";
    expect((await read()).ok).toBe(false);
  });

  it("does not disclose source after the agent configuration changes during discovery", async () => {
    discovered.mockImplementationOnce(async () => {
      config = { agents: { entries: { main: { workspace: path.join(directory, "other") } } } };
      return { entries };
    });
    expect((await read()).ok).toBe(false);
  });
});
