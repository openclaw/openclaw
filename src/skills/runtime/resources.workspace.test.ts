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
  SKILL_BUNDLE_IDENTITY_ACQUISITION_TIMEOUT_MS,
  SKILL_DELIVERED_FINGERPRINT_ACQUISITION_TIMEOUT_MS,
  SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY,
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

it.each([true])(
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
    // Delivery-time acquisition verifies at acquire: each entry's acquirer
    // attributes its own host's identity only when the acquired tree contains
    // the delivered instruction text itself, and omits on any other bytes.
    const guideInstructions = await fs.readFile(
      path.join(f.gateway, "skills", "guide", "SKILL.md"),
      "utf8",
    );
    expect(await stamped.deliveredIdentityAcquirers.get(gatewayEntry)?.(guideInstructions)).toBe(
      gatewayIdentity,
    );
    expect(await stamped.deliveredIdentityAcquirers.get(workspaceEntry)?.(guideInstructions)).toBe(
      workspaceIdentity,
    );
    expect(
      await stamped.deliveredIdentityAcquirers.get(gatewayEntry)?.("changed instructions"),
    ).toBeUndefined();
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
    // The owning reader is unavailable, so no delivered text can be proven to
    // come from the acquired tree: the acquirer omits instead of guessing.
    const guideText = await fs.readFile(path.join(gateway, "skills", "guide", "SKILL.md"), "utf8");
    expect(await stamped.deliveredIdentityAcquirers.get(entry!)?.(guideText)).toBeUndefined();
    expect(await stamped.deliveredIdentityAcquirers.get(entry!)?.(undefined)).toBeUndefined();
  } finally {
    release();
  }
});

it("keeps a workspace entry acquirable when a library selection shares its name", async () => {
  const f = await fixture();
  try {
    const workspaceSkill = f.snapshot.resolvedSkills?.[0];
    if (!workspaceSkill) {
      throw new Error("missing workspace skill fixture");
    }
    recordSkillFileHost(workspaceSkill, "workspace");
    const snapshot = {
      ...f.snapshot,
      librarySelections: [
        {
          skillId: "lib-guide",
          revision: "rev-1",
          name: workspaceSkill.name,
          ownerProfileId: null,
        },
      ],
    };
    f.skillResources.readSkillFiles.mockClear();
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const entry = stamped.snapshot?.resolvedSkills?.find(
      (skill) => skill.name === workspaceSkill.name,
    );
    if (!entry) {
      throw new Error("missing stamped workspace entry");
    }
    // A same-name library selection is no pin: the workspace entry keeps its
    // delivery-time acquisition and stamps through its owning workspace
    // reader, so the served tree's identity can never go stale behind the
    // pin's name.
    const hostBaseDir = path.join(f.host, "skills", "guide");
    const hostIdentity = prepareSkillBundle(
      (await readSkillResourceFiles(
        { ...workspaceSkill, baseDir: hostBaseDir, filePath: path.join(hostBaseDir, "SKILL.md") },
        { allowMissingRoot: false },
      ))!,
    ).revision;
    expect(stamped.deliveredIdentityAcquirers.get(entry)).toBeDefined();
    expect(entry.bundleFingerprint).toBe(hostIdentity);
    expect(f.skillResources.readSkillFiles).toHaveBeenCalled();
    // The armed acquirer attributes the workspace tree's own bytes and omits
    // any other delivered text.
    const guideText = await fs.readFile(path.join(hostBaseDir, "SKILL.md"), "utf8");
    expect(await stamped.deliveredIdentityAcquirers.get(entry)?.(guideText)).toBe(hostIdentity);
    expect(
      await stamped.deliveredIdentityAcquirers.get(entry)?.("changed instructions"),
    ).toBeUndefined();
  } finally {
    f.release();
  }
});

it("omits an identity whose resource-reader walk cannot be established promptly", async () => {
  const f = await fixture();
  try {
    const workspaceSkill = f.snapshot.resolvedSkills?.[0];
    if (!workspaceSkill) {
      throw new Error("missing workspace skill fixture");
    }
    recordSkillFileHost(workspaceSkill, "workspace");
    // The owning reader's tree walk never settles: preparation and delivery
    // acquisitions observe the resource-reader deadline and omit instead of
    // holding up the turn.
    f.skillResources.readSkillFiles.mockImplementationOnce(() => new Promise<never>(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = stampLocalSkillBundleIdentities({
        snapshot: f.snapshot,
        libraryEntries: [],
        workspaceDir: f.gateway,
      });
      await vi.advanceTimersByTimeAsync(SKILL_BUNDLE_IDENTITY_ACQUISITION_TIMEOUT_MS + 1);
      const stamped = await pending;
      const entry = stamped.snapshot?.resolvedSkills?.find(
        (skill) => skill.name === workspaceSkill.name,
      );
      if (!entry) {
        throw new Error("missing stamped workspace entry");
      }
      // The stale identity is omitted, never guessed: the entry ships
      // unstamped and still arms delivery-time acquisition for its live tree.
      expect(entry.bundleFingerprint).toBeUndefined();
      expect(stamped.deliveredIdentityAcquirers.get(entry)).toBeDefined();
      // The armed acquirer observes the opportunistic delivery-time bound:
      // a second hung walk omits the delivered identity instead of stalling
      // the settlement by the full preparation budget.
      f.skillResources.readSkillFiles.mockImplementationOnce(() => new Promise<never>(() => {}));
      const guideText = await fs.readFile(path.join(f.host, "skills", "guide", "SKILL.md"), "utf8");
      const acquired = stamped.deliveredIdentityAcquirers.get(entry)!(guideText);
      await vi.advanceTimersByTimeAsync(SKILL_DELIVERED_FINGERPRINT_ACQUISITION_TIMEOUT_MS + 1);
      expect(await acquired).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  } finally {
    f.release();
  }
});

it("keeps a stalled reader's discovery stall on traced turn startup under one second", async () => {
  const f = await fixture();
  try {
    const workspaceSkill = f.snapshot.resolvedSkills?.[0];
    if (!workspaceSkill) {
      throw new Error("missing workspace skill fixture");
    }
    recordSkillFileHost(workspaceSkill, "workspace");
    f.skillResources.readSkillFiles.mockImplementationOnce(() => new Promise<never>(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = stampLocalSkillBundleIdentities({
        snapshot: f.snapshot,
        libraryEntries: [],
        workspaceDir: f.gateway,
      });
      // Optional telemetry must not gate the first model call for seconds: a
      // preparation budget above this one-second ceiling leaves the await
      // below stuck while the owning reader never settles. The pinned
      // millisecond ceiling is the regression contract; the symbolic
      // deadline test above stays value-independent.
      await vi.advanceTimersByTimeAsync(1_001);
      const stamped = await pending;
      const entry = stamped.snapshot?.resolvedSkills?.find(
        (skill) => skill.name === workspaceSkill.name,
      );
      if (!entry) {
        throw new Error("missing stamped workspace entry");
      }
      expect(entry.bundleFingerprint).toBeUndefined();
      expect(stamped.deliveredIdentityAcquirers.get(entry)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  } finally {
    f.release();
  }
});

it("walks discovered bundles concurrently under one shared preparation budget", async () => {
  const f = await fixture();
  try {
    // Two more workspace-hosted bundles beside the fixture's guide.
    const extraSkills: Skill[] = [];
    for (const name of ["alpha", "beta"]) {
      const hostDir = path.join(f.host, "skills", name);
      await fs.mkdir(hostDir, { recursive: true });
      await fs.writeFile(
        path.join(hostDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.\n`,
      );
      const gatewayDir = path.join(f.gateway, "skills", name);
      extraSkills.push(
        recordSkillFileHost(
          createCanonicalFixtureSkill({
            name,
            description: name,
            filePath: path.join(gatewayDir, "SKILL.md"),
            baseDir: gatewayDir,
            source: "openclaw-workspace",
          }),
          "workspace",
        ),
      );
    }
    const snapshot = {
      ...f.snapshot,
      skills: [...f.snapshot.skills, ...extraSkills.map((skill) => ({ name: skill.name }))],
      resolvedSkills: [...(f.snapshot.resolvedSkills ?? []), ...extraSkills],
    };
    const orig = f.skillResources.readSkillFiles.getMockImplementation()!;
    const gates: Array<() => void> = [];
    f.skillResources.readSkillFiles.mockImplementation(
      async (skill: Skill, options: { allowMissingRoot: boolean }) => {
        let release!: () => void;
        gates.push(() => release());
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return orig(skill, options);
      },
    );
    const pending = stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    // All discovery walks start together: a slow owning reader delays the
    // preparation once, never once per discovered bundle.
    for (let i = 0; i < 100 && gates.length < 3; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(gates.length).toBe(3);
    for (const release of gates) {
      release();
    }
    const stamped = await pending;
    for (const skill of snapshot.resolvedSkills ?? []) {
      const entry = stamped.snapshot?.resolvedSkills?.find(
        (candidate) => candidate.name === skill.name,
      );
      expect(entry?.bundleFingerprint).toBeTypeOf("string");
    }
  } finally {
    f.release();
  }
});

it("coalesces concurrent same-cohort acquisitions into a single walk", async () => {
  const f = await fixture();
  try {
    const workspaceSkill = f.snapshot.resolvedSkills?.[0];
    if (!workspaceSkill) {
      throw new Error("missing workspace skill fixture");
    }
    recordSkillFileHost(workspaceSkill, "workspace");
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot: f.snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const entry = stamped.snapshot?.resolvedSkills?.find(
      (candidate) => candidate.name === workspaceSkill.name,
    );
    if (!entry) {
      throw new Error("missing stamped workspace entry");
    }
    const acquirer = stamped.deliveredIdentityAcquirers.get(entry);
    expect(acquirer).toBeDefined();
    const orig = f.skillResources.readSkillFiles.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.skillResources.readSkillFiles.mockClear();
    f.skillResources.readSkillFiles.mockImplementationOnce(
      async (...args: Parameters<typeof orig>) => {
        await gate;
        return orig(...args);
      },
    );
    const guideText = await fs.readFile(path.join(f.host, "skills", "guide", "SKILL.md"), "utf8");
    const first = acquirer!(guideText, 2);
    const second = acquirer!(guideText, 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // One in-flight walk serves both same-cohort deliveries.
    expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeTypeOf("string");
    expect(a).toBe(b);
    expect(a).toBe(entry.bundleFingerprint);
  } finally {
    f.release();
  }
});

it("counts underlying delivery-time walks against the per-preparation bound", async () => {
  const f = await fixture();
  try {
    const workspaceSkill = f.snapshot.resolvedSkills?.[0];
    if (!workspaceSkill) {
      throw new Error("missing workspace skill fixture");
    }
    recordSkillFileHost(workspaceSkill, "workspace");
    // Nine more workspace-hosted bundles with armed delivery acquisitions.
    const extraSkills: Skill[] = [];
    for (let i = 0; i < 9; i += 1) {
      const name = `bulk${i}`;
      const hostDir = path.join(f.host, "skills", name);
      await fs.mkdir(hostDir, { recursive: true });
      await fs.writeFile(
        path.join(hostDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.\n`,
      );
      const gatewayDir = path.join(f.gateway, "skills", name);
      extraSkills.push(
        recordSkillFileHost(
          createCanonicalFixtureSkill({
            name,
            description: name,
            filePath: path.join(gatewayDir, "SKILL.md"),
            baseDir: gatewayDir,
            source: "openclaw-workspace",
          }),
          "workspace",
        ),
      );
    }
    const snapshot = {
      ...f.snapshot,
      skills: [...f.snapshot.skills, ...extraSkills.map((skill) => ({ name: skill.name }))],
      resolvedSkills: [...(f.snapshot.resolvedSkills ?? []), ...extraSkills],
    };
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const entries = (stamped.snapshot?.resolvedSkills ?? []).filter((skill) =>
      skill.name.startsWith("bulk"),
    );
    expect(entries).toHaveLength(9);
    const acquirers = entries.map((entry) => stamped.deliveredIdentityAcquirers.get(entry));
    expect(acquirers.every((acquirer) => acquirer !== undefined)).toBe(true);
    const orig = f.skillResources.readSkillFiles.getMockImplementation()!;
    // Release gates whose settlement the test can await: `release` only lets a
    // walk's underlying read proceed; `settled` resolves when that read has
    // actually settled — the only event that frees a walk-bound slot.
    const gates: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    f.skillResources.readSkillFiles.mockImplementation(
      (skill: Skill, options: { allowMissingRoot: boolean }) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const settled = gate.then(() => orig(skill, options));
        // A walk whose race already hit its deadline has no awaiter: keep a
        // rejecting underlying read from surfacing as an unhandled rejection
        // when cleanup releases it.
        void settled.catch(() => undefined);
        gates.push({ release, settled });
        return settled;
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The bound's worth of concurrent delivery acquisitions starts one
      // underlying walk each; the delivery race omits them all at the short
      // deadline while the underlying reads stay outstanding and counted.
      const pending = acquirers
        .slice(0, SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY)
        .map((acquirer, index) => acquirer!(`Use bulk${index}.`, undefined));
      await vi.advanceTimersByTimeAsync(SKILL_DELIVERED_FINGERPRINT_ACQUISITION_TIMEOUT_MS + 1);
      for (const acquired of pending) {
        expect(await acquired).toBeUndefined();
      }
      expect(gates).toHaveLength(SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY);
      // A delivery acquisition beyond the bound omits without starting
      // another underlying walk: no telemetry read piles onto the full bound.
      const refused = acquirers[SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY]!("Use bulk8.", undefined);
      expect(await refused).toBeUndefined();
      expect(gates).toHaveLength(SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY);
      // The walk bound releases only when an underlying read settles: a
      // race deadline never frees a slot. Restore real timers, settle one
      // walk's underlying fs read, and the refused acquisition retries into a
      // fresh walk — a fake-timer-frozen walk would never release its slot.
      vi.useRealTimers();
      // The walk bound releases only when an underlying read settles: release
      // the first walk and await the controlled reader's own settlement signal
      // — the promise its release resolves — so the underlying filesystem read
      // provably finished. That settlement alone is still not the bound's
      // release: the guarded workspace reader resolves one promise hop later,
      // and `releaseUnderlying` queues only when that hop runs. The hop's
      // continuation precedes this await's (it attached to the controlled
      // read first), so by the time this continuation suspends on a macrotask
      // the release callback is already queued — and a macrotask boundary
      // drains it before the retry asks the bound for a slot, without counting
      // event-loop turns or hoping a busy runner schedules the release first.
      gates[0]!.release();
      await gates[0]!.settled;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const retry = acquirers[SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY]!("Use bulk8.", undefined);
      expect(gates).toHaveLength(SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY + 1);
      // The retry's underlying walk settles like any other: release and join
      // it, and the opportunistic acquisition verifies its delivered text
      // against the walked bundle — a mismatch omits — without holding the
      // served read.
      const retryGate = gates[SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY]!;
      retryGate.release();
      await retryGate.settled;
      expect(await retry).toBeUndefined();
    } finally {
      vi.useRealTimers();
      // Join every released-but-unsettled read so none dangles past the test:
      // releasing without awaiting would leave the still-gated walks'
      // underlying reads unresolved past teardown.
      const released = gates.splice(0, gates.length);
      for (const gate of released) {
        gate.release();
      }
      await Promise.allSettled(released.map((gate) => gate.settled));
    }
  } finally {
    f.release();
  }
});

it("bounds outstanding discovery walks per preparation", async () => {
  const f = await fixture();
  try {
    // Route the fixture's own guide bundle through the gated owning reader
    // as well, so every discovered walk in this test is observable.
    for (const skill of f.snapshot.resolvedSkills ?? []) {
      recordSkillFileHost(skill, "workspace");
    }
    // Nine more workspace-hosted bundles beside the fixture's guide.
    const extraSkills: Skill[] = [];
    for (let i = 0; i < 9; i += 1) {
      const name = `bulk${i}`;
      const hostDir = path.join(f.host, "skills", name);
      await fs.mkdir(hostDir, { recursive: true });
      await fs.writeFile(
        path.join(hostDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.\n`,
      );
      const gatewayDir = path.join(f.gateway, "skills", name);
      extraSkills.push(
        recordSkillFileHost(
          createCanonicalFixtureSkill({
            name,
            description: name,
            filePath: path.join(gatewayDir, "SKILL.md"),
            baseDir: gatewayDir,
            source: "openclaw-workspace",
          }),
          "workspace",
        ),
      );
    }
    const snapshot = {
      ...f.snapshot,
      skills: [...f.snapshot.skills, ...extraSkills.map((skill) => ({ name: skill.name }))],
      resolvedSkills: [...(f.snapshot.resolvedSkills ?? []), ...extraSkills],
    };
    const orig = f.skillResources.readSkillFiles.getMockImplementation()!;
    // Release gates whose settlement the test can await (same shape as the
    // delivery-walks test): a walk-bound slot frees only when the underlying
    // read settles, so batch boundaries wait on that signal, never on turns.
    const gates: Array<{ release: () => void; settled: Promise<unknown> }> = [];
    f.skillResources.readSkillFiles.mockImplementation(
      (skill: Skill, options: { allowMissingRoot: boolean }) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const settled = gate.then(() => orig(skill, options));
        void settled.catch(() => undefined);
        gates.push({ release, settled });
        return settled;
      },
    );
    const pending = stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
      workspaceDir: f.gateway,
    });
    const total = snapshot.resolvedSkills!.length;
    // Exactly one bound of walks is in flight; the next batch starts only
    // when this one settles.
    for (let i = 0; i < 100 && gates.length < SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(gates.length).toBe(SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY);
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(gates.length).toBe(SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY);
    // Release the first batch and await its underlying reads' actual
    // settlement before asserting the next batch: event-loop turns cannot
    // establish that a released walk's filesystem read finished, so a busy
    // runner must not decide whether the bound admits the next batch.
    const firstBatch = gates.splice(0, gates.length);
    for (const gate of firstBatch) {
      gate.release();
    }
    await Promise.allSettled(firstBatch.map((gate) => gate.settled));
    // The next batch registers exactly the walks beyond the bound, and only
    // now that the first bound has settled.
    const remaining = total - SKILL_BUNDLE_IDENTITY_WALK_CONCURRENCY;
    for (let i = 0; i < 100 && gates.length < remaining; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(gates.length).toBe(remaining);
    const secondBatch = gates.splice(0, gates.length);
    for (const gate of secondBatch) {
      gate.release();
    }
    // Join every released-but-unsettled read so none dangles past the test.
    await Promise.allSettled(secondBatch.map((gate) => gate.settled));
    const stamped = await pending;
    for (const skill of snapshot.resolvedSkills ?? []) {
      const entry = stamped.snapshot?.resolvedSkills?.find(
        (candidate) => candidate.name === skill.name,
      );
      expect(entry?.bundleFingerprint).toBeTypeOf("string");
    }
  } finally {
    f.release();
  }
});
