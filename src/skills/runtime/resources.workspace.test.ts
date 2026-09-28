import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { Skill } from "../loading/skill-contract.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { ExplicitSkillSelection } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  materializeSkillResources,
  prepareSkillResourceDelivery,
  readSkillResourceFiles,
  resolveExplicitSkillResource,
} from "./resources.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = temps.make("remote-skill-resources-");
  const gateway = path.join(root, "gateway");
  const host = path.join(root, "host");
  for (const [base, text] of [
    [gateway, "stale Gateway script"],
    [host, "current host script"],
  ] as const) {
    const dir = path.join(base, "skills", "guide");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: guide\ndescription: Guide\n---\nUse check.sh.\n",
    );
    await fs.writeFile(path.join(dir, "check.sh"), text);
  }
  const snapshot = await buildSkillSnapshot(gateway, {
    entries: loadWorkspaceSkills(gateway, { workspaceOnly: true }),
  });
  const toHost = (file: string) => path.join(host, path.relative(gateway, file));
  const toGateway = (skill: Skill): Skill => ({
    ...skill,
    filePath: path.join(gateway, path.relative(host, skill.filePath)),
    baseDir: path.join(gateway, path.relative(host, skill.baseDir)),
  });
  const skillResources = {
    readInstructions: (filePath: string, options: { signal?: AbortSignal }) =>
      fs.readFile(toHost(filePath), { ...options, encoding: "utf8" }),
    resolveExplicitSkill: vi.fn(async (selection: ExplicitSkillSelection) => {
      const loaded = await resolveExplicitSkillResource({
        ...selection,
        path: toHost(selection.path),
      });
      return loaded ? toGateway(loaded) : null;
    }),
    readSkillFiles: vi.fn(async (skill: Skill, options: { allowMissingRoot: boolean }) =>
      readSkillResourceFiles(
        { ...skill, baseDir: toHost(skill.baseDir), filePath: toHost(skill.filePath) },
        options,
      ),
    ),
  };
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    skillResources,
    loadSkills: async () => ({
      entries: loadWorkspaceSkills(host, { workspaceOnly: true }).map((entry) =>
        Object.assign({}, entry, { skill: toGateway(entry.skill) }),
      ),
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  return { gateway, host, snapshot, skillResources, release };
}

it("delivers host supporting files instead of a stale Gateway copy", async () => {
  const f = await fixture();
  try {
    const delivery = await prepareSkillResourceDelivery(f.snapshot, () => {}, [], f.gateway);
    expect(f.skillResources.readSkillFiles).toHaveBeenCalledOnce();
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      expect(
        await fs.readFile(
          path.join(materialized.snapshot.resolvedSkills![0]!.baseDir, "check.sh"),
          "utf8",
        ),
      ).toBe("current host script");
    } finally {
      await materialized.cleanup();
    }
  } finally {
    f.release();
  }
});

it("delivers visible and explicitly selected Workshop files from Gateway with host Skills", async () => {
  const f = await fixture();
  try {
    const config = {
      plugins: { enabled: false },
      agents: { entries: { main: { agentDir: path.join(f.gateway, "agent") } } },
    };
    const workshop = resolveWorkshopSkillsDir(config, "main");
    for (const name of ["visible", "hidden"]) {
      await writeSkill({
        dir: path.join(workshop, name),
        name,
        description: `Workshop ${name}`,
        frontmatterExtra: name === "hidden" ? "disable-model-invocation: true" : undefined,
      });
      await fs.writeFile(path.join(workshop, name, "run.sh"), `echo ${name}`, { mode: 0o755 });
    }
    const snapshot = await buildSkillSnapshot(f.gateway, { config, agentId: "main" });
    expect(snapshot.resolvedSkills?.some((skill) => skill.name === "hidden")).toBe(false);
    const delivery = await prepareSkillResourceDelivery(
      snapshot,
      () => {},
      [{ name: "hidden", path: path.join(workshop, "hidden", "SKILL.md") }],
      f.gateway,
    );
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      for (const name of ["visible", "hidden"]) {
        const skill = materialized.snapshot.resolvedSkills!.find(
          (candidate) => candidate.name === name,
        )!;
        expect(await fs.readFile(path.join(skill.baseDir, "run.sh"), "utf8")).toBe(`echo ${name}`);
        expect((await fs.stat(path.join(skill.baseDir, "run.sh"))).mode & 0o111).not.toBe(0);
      }
      expect(f.skillResources.resolveExplicitSkill).not.toHaveBeenCalled();
      expect(f.skillResources.readSkillFiles.mock.calls.map(([skill]) => skill.name)).toEqual([
        "guide",
      ]);
    } finally {
      await materialized.cleanup();
    }
  } finally {
    f.release();
  }
});

it("resolves explicit hidden Skills on the host before native catalog validation", async () => {
  const f = await fixture();
  try {
    const hidden = path.join(f.host, "skills", "hidden");
    await fs.mkdir(hidden, { recursive: true });
    await fs.writeFile(
      path.join(hidden, "SKILL.md"),
      "---\nname: hidden\ndescription: Hidden guide\ndisable-model-invocation: true\n---\nHidden instructions.\n",
    );
    f.snapshot.skills.push({ name: "hidden" });
    const selected = {
      name: "command-alias",
      path: path.join(f.gateway, "skills", "hidden", "SKILL.md"),
    };
    const delivery = await prepareSkillResourceDelivery(
      f.snapshot,
      () => {},
      [selected],
      f.gateway,
    );
    expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
    expect(delivery?.skills.map((skill) => skill.name)).toEqual(["guide", "hidden"]);
    expect(delivery?.skills[1]).toMatchObject({ sourcePath: selected.path, modelVisible: true });
  } finally {
    f.release();
  }
});

it("skips a vanished discovered host root but still rejects its explicit selection", async () => {
  const f = await fixture();
  try {
    await fs.rm(path.join(f.host, "skills", "guide"), { recursive: true });
    await expect(
      prepareSkillResourceDelivery(f.snapshot, () => {}, [], f.gateway),
    ).resolves.toEqual({ version: 1, skills: [] });
    await expect(
      prepareSkillResourceDelivery(
        f.snapshot,
        () => {},
        [{ name: "guide", path: path.join(f.gateway, "skills", "guide", "SKILL.md") }],
        f.gateway,
      ),
    ).rejects.toThrow("guide");
  } finally {
    f.release();
  }
});

it("does not fall back to Gateway files after the host binding stops", async () => {
  const f = await fixture();
  f.release();
  await expect(prepareSkillResourceDelivery(f.snapshot, () => {}, [], f.gateway)).rejects.toThrow(
    "stopped or not ready",
  );
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves local resource delivery for document-only adapters (stopped=%s)",
  async (stopped) => {
    const f = await fixture();
    f.release();
    const readFile = vi.fn();
    const release = registerAgentWorkspaceAccess(f.gateway, {
      bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
    });
    if (stopped) {
      release();
    }
    try {
      const delivery = await prepareSkillResourceDelivery(f.snapshot, () => {}, [], f.gateway);
      const materialized = await materializeSkillResources(delivery!, () => {});
      try {
        expect(
          await fs.readFile(
            path.join(materialized.snapshot.resolvedSkills![0]!.baseDir, "check.sh"),
            "utf8",
          ),
        ).toBe("stale Gateway script");
        expect(readFile).not.toHaveBeenCalled();
      } finally {
        await materialized.cleanup();
      }
    } finally {
      release();
    }
  },
);
