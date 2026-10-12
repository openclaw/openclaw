import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import { prepareWorkspaceSkillStatus } from "../discovery/status.js";
import { recordSkillFileHost, resolveSkillFileHost } from "../skill-file-host.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { OpenClawSkillMetadata, SkillEntry } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadWorkspaceSkills,
  prepareWorkspaceSkillEntries,
  prepareWorkspaceSkills,
  readWorkspaceSkillSources,
  resolveWorkspaceSkillPromptEntries,
} from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const library = vi.hoisted(() => ({ entries: [] as SkillEntry[] }));
vi.mock("../library/selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../library/selection.js")>()),
  loadSkillLibrarySelection: () => library.entries,
  prepareSkillLibrarySelection: async () => library.entries,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  library.entries = [];
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = tempDirs.make("remote-skills-");
  const gateway = path.join(root, "gateway");
  const remote = path.join(root, "remote");
  const execution = path.join(root, "execution");
  const libraryDir = path.join(root, "library");
  const hostPlatform = process.platform === "linux" ? "darwin" : "linux";
  const write = async (workspace: string, name: string, metadata?: OpenClawSkillMetadata) =>
    writeSkill({
      dir: path.join(workspace, "skills", name),
      name,
      description: `${path.basename(workspace)} ${name}`,
      metadata: JSON.stringify({ openclaw: metadata ?? {} }),
      frontmatterExtra: "command-dispatch: tool\ncommand-tool: exec",
    });
  await write(gateway, "stale");
  await write(remote, "available", { os: [hostPlatform], requires: { bins: ["remote-tool"] } });
  await write(remote, "gateway-os", { os: [process.platform] });
  await write(remote, "gateway-bin", { requires: { bins: ["gateway-tool"] } });
  await write(execution, "available");
  await write(execution, "project");
  await write(libraryDir, "pinned", { requires: { bins: ["library-tool"] } });
  library.entries = loadWorkspaceSkills(libraryDir, { workspaceOnly: true });
  const binDir = path.join(gateway, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gateway-tool"), "#!/bin/sh\n", { mode: 0o755 });
  vi.stubEnv("PATH", binDir);
  const sources: WorkspaceSkillSources = {
    entries: loadWorkspaceSkills(remote, { workspaceOnly: true }),
    executionEntries: loadWorkspaceSkills(execution, { workspaceOnly: true }),
    runtime: { platform: hostPlatform, bins: ["remote-tool", "library-tool"] },
  };
  const bridge = {
    readFile: vi.fn(async () => Buffer.from("unused")),
    writeFile: vi.fn(async () => {}),
    stat: vi.fn(async () => null),
  };
  const options = {
    config: { plugins: { enabled: false } },
    executionWorkspaceDir: execution,
    bundledSkillsDir: path.join(root, "bundled"),
    managedSkillsDir: path.join(root, "managed"),
    librarySelections: [
      { skillId: "pin", revision: "a".repeat(64), name: "pinned", ownerProfileId: null },
    ],
  };
  return { gateway, remote, sources, bridge, options };
}

it("keeps explicitly hidden remote collision losers out of snapshot hydration", async () => {
  const { gateway, sources, bridge, options } = await fixture();
  const hidden = sources.entries.find((entry) => entry.skill.name === "available")!;
  hidden.exposure = {
    includeInRuntimeRegistry: true,
    includeInAvailableSkillsPrompt: false,
    userInvocable: true,
  };
  hidden.sourceOrder = -1;
  await writeSkill({
    dir: path.join(options.managedSkillsDir, "available"),
    name: "available",
    description: "Gateway winner",
  });
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge,
    loadSkills: async () => sources,
  });
  try {
    const prepared = await resolveWorkspaceSkillPromptEntries(gateway, options);
    expect(
      prepared.eligible.find((entry) => entry.skill.name === "available")?.skill.filePath,
    ).toBe(path.join(options.managedSkillsDir, "available", "SKILL.md"));
    const selected = await buildSkillSnapshot(gateway, {
      ...options,
      matchesSnapshotSkill: (skill) => skill.filePath === hidden.skill.filePath,
    });
    expect(selected.skills).toHaveLength(1);
    expect(selected.discoverySkills).toEqual([]);
    expect(selected.resolvedSkills).toEqual([]);
  } finally {
    release();
  }
});

describe("remote skill discovery", () => {
  it("keeps installed sources on Gateway and workspace files on the host", async () => {
    const { gateway, remote, sources, bridge, options } = await fixture();
    const config = {
      ...options.config,
      agents: { entries: { main: { agentDir: path.join(gateway, "agent") } } },
    };
    const workshopDir = resolveWorkshopSkillsDir(config, "main");
    for (const [dir, name, description] of [
      [workshopDir, "workshop-wins", "Gateway Workshop instructions"],
      [options.bundledSkillsDir, "workshop-wins", "Shadowed bundled instructions"],
      [workshopDir, "managed-wins", "Shadowed Workshop instructions"],
      [options.managedSkillsDir, "managed-wins", "Gateway managed instructions"],
      [options.managedSkillsDir, "workspace-wins", "Shadowed managed instructions"],
      [path.join(remote, "skills"), "workspace-wins", "Workspace instructions"],
    ] as const) {
      await writeSkill({ dir: path.join(dir, name), name, description });
    }
    const gatewayFailure = path.join(options.managedSkillsDir, "bad-gateway", "SKILL.md");
    const remoteFailure = path.join(remote, "skills", "bad-remote", "SKILL.md");
    for (const [file, name] of [
      [gatewayFailure, "bad-gateway"],
      [remoteFailure, "bad-remote"],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `---\nname: ${name}\n---\n`);
    }
    const discovered = readWorkspaceSkillSources({
      sourcePlan: resolveWorkspaceSkillSourcePlan(remote, { workspaceOnly: true }),
      limits: resolveSkillDiscoveryLimits(),
      additionalBins: [],
    });
    sources.entries = discovered.entries;
    sources.diagnostics = discovered.diagnostics;
    const loadSkills = vi.fn(async (_request: WorkspaceSkillSourceRequest) => sources);
    const release = registerAgentWorkspaceAccess(gateway, { bridge, loadSkills });
    try {
      const params = { ...options, config, agentId: "main" };
      const entries = await prepareWorkspaceSkills(gateway, params);
      const workshopWins = entries.find((entry) => entry.skill.name === "workshop-wins")?.skill;
      const managedWins = entries.find((entry) => entry.skill.name === "managed-wins")?.skill;
      const workspaceWins = entries.find((entry) => entry.skill.name === "workspace-wins")?.skill;
      expect(workshopWins).toMatchObject({
        description: "Gateway Workshop instructions",
        filePath: path.join(workshopDir, "workshop-wins", "SKILL.md"),
      });
      expect(managedWins).toMatchObject({ description: "Gateway managed instructions" });
      expect(workspaceWins).toMatchObject({ description: "Workspace instructions" });
      expect(resolveSkillFileHost(workshopWins!)).toBe("gateway");
      expect(resolveSkillFileHost(managedWins!)).toBe("gateway");
      expect(resolveSkillFileHost(workspaceWins!)).toBe("workspace");
      const plan = loadSkills.mock.calls[0]![0].sourcePlan;
      expect(plan.roots.map((root) => root.tier)).toEqual(["workspace", "workspace"]);
      expect(plan.pluginSkillsDir).toBeUndefined();
      expect(plan.pluginSkillRoots).toEqual([]);
      expect(plan.bundledSkillsDir).toBeUndefined();
      await fs.writeFile(path.join(workshopDir, "workshop-wins", "skill-card.md"), "Workshop card");
      sources.status = readWorkspaceSkillStatusFacts({
        entries: sources.entries,
        workspaceDir: remote,
        managedSkillsDir: path.join(remote, "skills"),
      });
      const status = await prepareWorkspaceSkillStatus(gateway, {
        ...params,
        skillCardKey: "workshop-wins",
      });
      expect(status.files.find((file) => file.name === "workshop-wins")?.skillCard?.content).toBe(
        "Workshop card",
      );
      expect(status.report.diagnostics).toEqual({
        items: [gatewayFailure, remoteFailure].map((file) => ({
          kind: "invalid",
          path: file,
          message: "description is required",
        })),
        omitted: 0,
      });
    } finally {
      release();
    }
  });

  it("keeps canonical execution entries and their binary requirements on the right hosts", async () => {
    const { gateway, sources, bridge, options } = await fixture();
    await writeSkill({
      dir: path.join(options.executionWorkspaceDir, "skills", "project"),
      name: "project",
      description: "Gateway canonical instructions",
      metadata: JSON.stringify({ openclaw: { requires: { bins: ["remote-tool"] } } }),
    });
    const invalidFile = path.join(options.executionWorkspaceDir, "skills", "invalid", "SKILL.md");
    await fs.mkdir(path.dirname(invalidFile), { recursive: true });
    await fs.writeFile(invalidFile, "---\nname: invalid\n---\n");
    const loadSkills = vi.fn(async (_request: WorkspaceSkillSourceRequest) => sources);
    const release = registerAgentWorkspaceAccess(gateway, { bridge, loadSkills });
    try {
      const params = { ...options, executionWorkspaceFileHost: "gateway" as const };
      const entries = (await resolveWorkspaceSkillPromptEntries(gateway, params)).eligible;
      expect(entries.map((entry) => entry.skill.name)).toEqual(["available", "project", "pinned"]);
      const project = entries.find((entry) => entry.skill.name === "project")?.skill;
      const available = entries.find((entry) => entry.skill.name === "available")?.skill;
      expect(project).toMatchObject({ description: "Gateway canonical instructions" });
      expect(resolveSkillFileHost(project!)).toBe("gateway");
      expect(resolveSkillFileHost(available!)).toBe("workspace");
      const prepared = await prepareWorkspaceSkillEntries(gateway, params);
      expect(prepared.diagnostics).toEqual({
        items: [{ kind: "invalid", path: invalidFile, message: "description is required" }],
        omitted: 0,
      });
      expect(loadSkills.mock.calls[0]![0]).toMatchObject({
        executionWorkspaceDir: undefined,
        additionalBins: expect.arrayContaining(["remote-tool", "library-tool"]),
      });
    } finally {
      release();
    }
  });

  it("rejects discovery completed after its workspace binding stops", async () => {
    const { gateway, sources, bridge, options } = await fixture();
    const deferred = createDeferredCore<WorkspaceSkillSources>();
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge,
      loadSkills: () => deferred.promise,
    });
    const pending = resolveWorkspaceSkillPromptEntries(gateway, options);
    const rejected = expect(pending).rejects.toThrow("stopped or not ready");
    release();
    deferred.resolve(sources);
    await rejected;
  });
});

it.each(["pinned", "stale"])(
  "reads only authorized Gateway Library files for the %s card",
  async (skillCardKey) => {
    const { gateway, remote, sources, bridge, options } = await fixture();
    await fs.writeFile(
      path.join(library.entries[0]!.skill.baseDir, "skill-card.md"),
      "# Library card\n",
    );
    await fs.writeFile(
      path.join(gateway, "skills", "stale", "skill-card.md"),
      "# Gateway private card\n",
    );
    const forged = loadWorkspaceSkills(gateway, { workspaceOnly: true })[0]!;
    forged.skill.source = "openclaw-library";
    recordSkillFileHost(forged.skill, "gateway");
    sources.entries.push(forged);
    sources.status = {
      workspaceDir: remote,
      managedSkillsDir: path.join(remote, "managed"),
      files: [],
    };
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge,
      loadSkills: async () => sources,
    });
    try {
      const prepared = await prepareWorkspaceSkillStatus(gateway, { ...options, skillCardKey });
      expect(prepared.files.find((file) => file.name === "stale")).toBeUndefined();
      expect(prepared.files.find((file) => file.name === "pinned")?.skillCard).toMatchObject({
        present: true,
      });
      if (skillCardKey === "pinned") {
        expect(prepared.files.find((file) => file.name === "pinned")?.skillCard?.content).toBe(
          "# Library card\n",
        );
      }
    } finally {
      release();
    }
  },
);
