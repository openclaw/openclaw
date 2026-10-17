import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  expandExplicitSkillReferences,
  skillCommandsToExplicitSelections,
} from "../discovery/chat-command-invocation.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import type { Skill } from "../loading/skill-contract.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { recordSkillFileHost } from "../skill-file-host.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { ExplicitSkillSelection } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  materializeSkillResources as materialize,
  prepareSkillResourceDelivery as prepare,
  readSkillResourceFiles,
  resolveExplicitSkillResource,
} from "./resources.js";

const cleanups: (() => void | Promise<void>)[] = [];
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const release of cleanups.splice(0).toReversed()) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    cleanup();
    if (errors.length) {
      throw new AggregateError(errors, "Skill resource cleanup failed");
    }
  }),
);
async function materializeSkillResources(delivery: Parameters<typeof materialize>[0]) {
  const result = await materialize(delivery, () => {});
  cleanups.push(result.cleanup);
  return result;
}
const read = (baseDir: string, file: string) => fs.readFile(path.join(baseDir, file), "utf8");

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
  cleanups.push(release);
  const deliver = (selected: ExplicitSkillSelection[] = [], source = snapshot) =>
    prepare(source, () => {}, selected, gateway);
  return { gateway, host, snapshot, skillResources, release, deliver };
}

it("keeps Gateway and workspace rewrites separate when their source paths collide", async () => {
  const f = await fixture();
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  const gatewaySkill = recordSkillFileHost(
    { ...workspaceSkill, name: "zeta-gateway-guide" },
    "gateway",
  );
  f.snapshot.skills.push({ name: gatewaySkill.name });
  f.snapshot.resolvedSkills?.push(gatewaySkill);

  const delivery = await f.deliver();
  if (!delivery) {
    throw new Error("missing collision delivery fixture");
  }
  const materialized = await materializeSkillResources(delivery);
  const gatewayCopy = materialized.snapshot.resolvedSkills?.find(
    (skill) => skill.name === gatewaySkill.name,
  );
  const workspaceCopy = materialized.snapshot.resolvedSkills?.find(
    (skill) => skill.name === workspaceSkill.name,
  );
  if (!gatewayCopy || !workspaceCopy) {
    throw new Error("missing materialized collision fixture");
  }
  expect(materialized.rewriteReferences(workspaceSkill.filePath)).toBe(gatewayCopy.filePath);
  expect(materialized.rewriteReferences("workspace-skill://workspace/guide/SKILL.md")).toBe(
    workspaceCopy.filePath,
  );
  expect(await read(gatewayCopy.baseDir, "check.sh")).toBe("stale Gateway script");
  expect(await read(workspaceCopy.baseDir, "check.sh")).toBe("current host script");
});

it("delivers Gateway Workshop files without a live workspace binding", async () => {
  const f = await fixture();
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
  snapshot.skills = snapshot.skills.filter((skill) => skill.name !== "guide");
  snapshot.resolvedSkills = snapshot.resolvedSkills?.filter((skill) => skill.name !== "guide");
  snapshot.discoverySkills = snapshot.discoverySkills?.filter((skill) => skill.name !== "guide");
  f.release();
  const delivery = await f.deliver(
    [{ name: "hidden", path: path.join(workshop, "hidden", "SKILL.md") }],
    snapshot,
  );
  expect(delivery?.skills.find((skill) => skill.name === "hidden")?.sourcePath).toBe(
    path.join(workshop, "hidden", "SKILL.md"),
  );
  const materialized = await materializeSkillResources(delivery!);
  for (const name of ["visible", "hidden"]) {
    const skill = materialized.snapshot.resolvedSkills!.find(
      (candidate) => candidate.name === name,
    )!;
    expect(await read(skill.baseDir, "run.sh")).toBe(`echo ${name}`);
    expect((await fs.stat(path.join(skill.baseDir, "run.sh"))).mode & 0o111).not.toBe(0);
  }
  expect(f.skillResources.resolveExplicitSkill).not.toHaveBeenCalled();
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
});

it("resolves explicit hidden Skills on the host before native catalog validation", async () => {
  const f = await fixture();
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
  const delivery = await f.deliver([selected]);
  expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
  expect(delivery?.skills.map((skill) => skill.name)).toEqual(["guide", "hidden"]);
  expect(delivery?.skills[1]).toMatchObject({
    sourcePath: selected.path,
    modelVisible: true,
  });
});

it("delivers the selected host's hidden Skill when both hosts use the same path", async () => {
  const f = await fixture();
  for (const [root, text] of [
    [f.gateway, "Gateway hidden resource"],
    [f.host, "Node hidden resource"],
  ] as const) {
    const hidden = path.join(root, "skills", "hidden");
    await fs.mkdir(hidden, { recursive: true });
    await fs.writeFile(
      path.join(hidden, "SKILL.md"),
      `---\nname: hidden\ndescription: Hidden guide\ndisable-model-invocation: true\n---\n${text} instructions.\n`,
    );
    await fs.writeFile(path.join(hidden, "resource.txt"), text);
  }
  const selectedPath = path.join(f.gateway, "skills", "hidden", "SKILL.md");
  f.snapshot.skills.push({ name: "hidden", gatewayFilePath: selectedPath }, { name: "hidden" });
  const hostEntry = loadWorkspaceSkills(f.host, { workspaceOnly: true }).find(
    (entry) => entry.skill.name === "hidden",
  )!;
  const [command] = buildWorkspaceSkillCommandSpecs(f.gateway, {
    entries: [
      {
        ...hostEntry,
        skill: recordSkillFileHost({ ...hostEntry.skill, filePath: selectedPath }, "workspace"),
      },
    ],
  });
  const [selected] = skillCommandsToExplicitSelections([command!]);
  expect(selected).toEqual({ name: "hidden", path: selectedPath });
  const expandedReference = expandExplicitSkillReferences({
    text: "$hidden",
    skillCommands: [command!],
  }).body;
  expect(expandedReference).toContain("SKILL.md: workspace-skill://workspace/hidden/SKILL.md");

  const delivery = await f.deliver([selected!]);
  const materialized = await materializeSkillResources(delivery!);
  const hidden = materialized.snapshot.resolvedSkills!.find((skill) => skill.name === "hidden")!;
  expect(await fs.readFile(hidden.filePath, "utf8")).toContain(
    "Node hidden resource instructions.",
  );
  expect(await read(hidden.baseDir, "resource.txt")).toBe("Node hidden resource");
  expect(materialized.rewriteReferences(expandedReference)).toContain(
    `SKILL.md: ${hidden.filePath}`,
  );
  expect(materialized.rewriteReferences("workspace-skill://workspace/hidden/resource.txt")).toBe(
    path.join(hidden.baseDir, "resource.txt"),
  );
  expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
});

it("skips a vanished discovered host root but still rejects its explicit selection", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.host, "skills", "guide"), { recursive: true });
  await expect(f.deliver()).resolves.toEqual({ version: 1, skills: [] });
  await expect(
    f.deliver([{ name: "guide", path: path.join(f.gateway, "skills", "guide", "SKILL.md") }]),
  ).rejects.toThrow("guide");
});

it("does not fall back to Gateway files after the host binding stops", async () => {
  const f = await fixture();
  f.release();
  await expect(f.deliver()).rejects.toThrow("stopped or not ready");
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
});

it("preserves local resource delivery for stopped document-only adapters", async () => {
  const f = await fixture();
  f.release();
  const readFile = vi.fn();
  const release = registerAgentWorkspaceAccess(f.gateway, {
    bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
  });
  release();
  try {
    const delivery = await f.deliver();
    const materialized = await materializeSkillResources(delivery!);
    expect(
      await fs.readFile(
        path.join(materialized.snapshot.resolvedSkills![0]!.baseDir, "check.sh"),
        "utf8",
      ),
    ).toBe("stale Gateway script");
    expect(readFile).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
