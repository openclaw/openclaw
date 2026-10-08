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
import { prepareSkillBundle } from "../library/bundle.js";
import type { Skill } from "../loading/skill-contract.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { recordSkillFileHost } from "../skill-file-host.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { ExplicitSkillSelection } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  materializeSkillResources,
  prepareSkillResourceDelivery,
  readSkillResourceFiles,
  resolveExplicitSkillResource,
  stampLocalSkillBundleIdentities,
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
      expect(delivery?.skills[0]?.sourcePath).toBe(
        path.join(f.gateway, "skills", "guide", "SKILL.md"),
      );
      expect(
        await fs.readFile(
          path.join(materialized.snapshot.resolvedSkills![0]!.baseDir, "check.sh"),
          "utf8",
        ),
      ).toBe("current host script");
      expect(
        materialized.rewriteReferences(path.join(f.gateway, "skills", "guide", "check.sh")),
      ).toBe(path.join(materialized.snapshot.resolvedSkills![0]!.baseDir, "check.sh"));
    } finally {
      await materialized.cleanup();
    }
  } finally {
    f.release();
  }
});

it("keeps Gateway and workspace rewrites separate when their source paths collide", async () => {
  const f = await fixture();
  try {
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

    const delivery = await prepareSkillResourceDelivery(f.snapshot, () => {}, [], f.gateway);
    if (!delivery) {
      throw new Error("missing collision delivery fixture");
    }
    const materialized = await materializeSkillResources(delivery, () => {});
    try {
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
      expect(await fs.readFile(path.join(gatewayCopy.baseDir, "check.sh"), "utf8")).toBe(
        "stale Gateway script",
      );
      expect(await fs.readFile(path.join(workspaceCopy.baseDir, "check.sh"), "utf8")).toBe(
        "current host script",
      );
    } finally {
      await materialized.cleanup();
    }
  } finally {
    f.release();
  }
});

it("delivers Gateway Workshop files without a live workspace binding", async () => {
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
    snapshot.skills = snapshot.skills.filter((skill) => skill.name !== "guide");
    snapshot.resolvedSkills = snapshot.resolvedSkills?.filter((skill) => skill.name !== "guide");
    snapshot.discoverySkills = snapshot.discoverySkills?.filter((skill) => skill.name !== "guide");
    f.release();
    const delivery = await prepareSkillResourceDelivery(
      snapshot,
      () => {},
      [{ name: "hidden", path: path.join(workshop, "hidden", "SKILL.md") }],
      f.gateway,
    );
    expect(delivery?.skills.find((skill) => skill.name === "hidden")?.sourcePath).toBe(
      path.join(workshop, "hidden", "SKILL.md"),
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
      expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
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
    expect(delivery?.skills[1]).toMatchObject({
      sourcePath: selected.path,
      modelVisible: true,
    });
  } finally {
    f.release();
  }
});

it("delivers the selected host's hidden Skill when both hosts use the same path", async () => {
  const f = await fixture();
  try {
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

    const delivery = await prepareSkillResourceDelivery(
      f.snapshot,
      () => {},
      [selected!],
      f.gateway,
    );
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      const hidden = materialized.snapshot.resolvedSkills!.find(
        (skill) => skill.name === "hidden",
      )!;
      expect(await fs.readFile(hidden.filePath, "utf8")).toContain(
        "Node hidden resource instructions.",
      );
      expect(await fs.readFile(path.join(hidden.baseDir, "resource.txt"), "utf8")).toBe(
        "Node hidden resource",
      );
      expect(materialized.rewriteReferences(expandedReference)).toContain(
        `SKILL.md: ${hidden.filePath}`,
      );
      expect(
        materialized.rewriteReferences("workspace-skill://workspace/hidden/resource.txt"),
      ).toBe(path.join(hidden.baseDir, "resource.txt"));
      expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
    } finally {
      await materialized.cleanup();
    }
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

it("stamps each host's bundle identity when Gateway and workspace skills share one path", async () => {
  const f = await fixture();
  try {
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
    f.skillResources.readSkillFiles.mockClear();
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot: f.snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const gatewayEntry = stamped.snapshot?.resolvedSkills?.find(
      (skill) => skill.name === gatewaySkill.name,
    );
    const workspaceEntry = stamped.snapshot?.resolvedSkills?.find(
      (skill) => skill.name === workspaceSkill.name,
    );
    if (!gatewayEntry || !workspaceEntry) {
      throw new Error("missing stamped collision fixture");
    }
    const gatewayIdentity = prepareSkillBundle(
      (await readSkillResourceFiles(gatewaySkill, { allowMissingRoot: false }))!,
    ).revision;
    const hostBaseDir = path.join(f.host, "skills", "guide");
    const workspaceIdentity = prepareSkillBundle(
      (await readSkillResourceFiles(
        { ...workspaceSkill, baseDir: hostBaseDir, filePath: path.join(hostBaseDir, "SKILL.md") },
        { allowMissingRoot: false },
      ))!,
    ).revision;
    // Same absolute path, different hosts and bytes: each entry carries its own
    // host's identity, and the workspace bundle was hashed through the owning
    // remote reader rather than the Gateway-local filesystem.
    expect(gatewayEntry.bundleFingerprint).toBe(gatewayIdentity);
    expect(workspaceEntry.bundleFingerprint).toBe(workspaceIdentity);
    expect(workspaceEntry.bundleFingerprint).not.toBe(gatewayEntry.bundleFingerprint);
    expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
    // Delivery-time acquisition stays host-aware: each entry's acquirer
    // re-describes its own host's served bytes.
    expect(await stamped.deliveredIdentityAcquirers.get(gatewayEntry)?.()).toBe(gatewayIdentity);
    expect(await stamped.deliveredIdentityAcquirers.get(workspaceEntry)?.()).toBe(
      workspaceIdentity,
    );
  } finally {
    f.release();
  }
});

it("reads remote-hosted bundle identities through the owning reader when the path is absent on the Gateway", async () => {
  const f = await fixture();
  try {
    const hostOnlyDir = path.join(f.host, "skills", "hostonly");
    await fs.mkdir(hostOnlyDir, { recursive: true });
    await fs.writeFile(
      path.join(hostOnlyDir, "SKILL.md"),
      "---\nname: hostonly\ndescription: Host only\n---\nRemote instructions.\n",
    );
    await fs.writeFile(path.join(hostOnlyDir, "run.sh"), "echo remote");
    const gatewayPath = path.join(f.gateway, "skills", "hostonly", "SKILL.md");
    const remoteSkill = recordSkillFileHost(
      createCanonicalFixtureSkill({
        name: "hostonly",
        description: "Host only",
        filePath: gatewayPath,
        baseDir: path.dirname(gatewayPath),
        source: "openclaw-workspace",
      }),
      "workspace",
    );
    f.snapshot.skills.push({ name: "hostonly" });
    f.snapshot.resolvedSkills?.push(remoteSkill);
    f.skillResources.readSkillFiles.mockClear();
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot: f.snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const entry = stamped.snapshot?.resolvedSkills?.find((skill) => skill.name === "hostonly");
    expect(entry?.bundleFingerprint).toBe(
      prepareSkillBundle(
        (await readSkillResourceFiles(
          {
            ...remoteSkill,
            baseDir: hostOnlyDir,
            filePath: path.join(hostOnlyDir, "SKILL.md"),
          },
          { allowMissingRoot: false },
        ))!,
      ).revision,
    );
    expect(
      f.skillResources.readSkillFiles.mock.calls.filter(([skill]) => skill.name === "hostonly"),
    ).toHaveLength(1);
  } finally {
    f.release();
  }
});

it("omits remote-hosted identities without failing when the owning reader is unavailable", async () => {
  const gateway = temps.make("fingerprint-reader-unavailable-");
  await fs.mkdir(path.join(gateway, "skills", "guide"), { recursive: true });
  await fs.writeFile(
    path.join(gateway, "skills", "guide", "SKILL.md"),
    "---\nname: guide\ndescription: Guide\n---\nLocal guide.\n",
  );
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills: async () => ({
      entries: [],
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  try {
    const snapshot = await buildSkillSnapshot(gateway, {
      entries: loadWorkspaceSkills(gateway, { workspaceOnly: true }),
    });
    const remote = recordSkillFileHost({ ...snapshot.resolvedSkills![0]! }, "workspace");
    snapshot.resolvedSkills![0] = remote;
    // Resource delivery fails hard here (WorkspaceAccessUnavailableError); the
    // telemetry-only producer degrades to omit instead.
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
      workspaceDir: gateway,
    });
    const entry = stamped.snapshot?.resolvedSkills?.[0];
    expect(entry?.bundleFingerprint).toBeUndefined();
    expect(await stamped.deliveredIdentityAcquirers.get(entry!)?.()).toBeUndefined();
  } finally {
    release();
  }
});
