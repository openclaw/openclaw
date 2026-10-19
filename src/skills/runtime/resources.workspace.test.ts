import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  registerDiagnosticTracePropagationBridge,
  resetDiagnosticTracePropagationForTest,
} from "../../infra/diagnostic-trace-propagation.js";
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
import { writeSkill as writeSkillDocument } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { ExplicitSkillSelection } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import {
  bumpSkillsSnapshotVersion,
  markSkillsSupportingFilesChanged,
  type SkillsSourceScope,
} from "./refresh-state.js";
import {
  materializeSkillResources as materialize,
  prepareSkillResourceDelivery as prepare,
  readSkillResourceFiles,
  resolveExplicitSkillResource,
  stampDiscoveredSkillBundleIdentities,
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
  return {
    ...result,
    skill: (name = "guide") =>
      result.snapshot.resolvedSkills!.find((skill) => skill.name === name)!,
  };
}
const read = (baseDir: string, file: string) => fs.readFile(path.join(baseDir, file), "utf8");
async function writeSkill(dir: string, name: string, hidden = false, body?: string) {
  await writeSkillDocument({
    dir,
    name,
    description: name,
    body,
    frontmatterExtra: hidden ? "disable-model-invocation: true" : undefined,
  });
}

// The active-tracing gate discovery stamping keys on: a registered
// trace-propagation bridge is exactly the exporter-owned tracing consumer the
// diagnostics-otel service registers while traces are active, and a
// metrics-only install never registers one.
function registerActiveTracingBridge() {
  return registerDiagnosticTracePropagationBridge({
    resolveTraceContext: () => undefined,
  });
}

afterEach(() => {
  resetDiagnosticTracePropagationForTest();
});
async function fixture() {
  const root = temps.make("remote-skill-resources-");
  const gateway = path.join(root, "gateway");
  const host = path.join(root, "host");
  for (const [base, text] of [
    [gateway, "stale Gateway script"],
    [host, "current host script"],
  ] as const) {
    const dir = path.join(base, "skills", "guide");
    await writeSkill(dir, "guide", false, "Use check.sh.");
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
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});

it("keeps Gateway and workspace rewrites separate when their source paths collide", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills![0]!;
  recordSkillFileHost(workspaceSkill, "workspace");
  const gatewaySkill = recordSkillFileHost(
    { ...workspaceSkill, name: "zeta-gateway-guide" },
    "gateway",
  );
  f.snapshot.skills.push({ name: gatewaySkill.name });
  f.snapshot.resolvedSkills?.push(gatewaySkill);
  const materialized = await materializeSkillResources((await f.deliver())!);
  const gatewayCopy = materialized.skill(gatewaySkill.name);
  const workspaceCopy = materialized.skill();
  expect(materialized.rewriteReferences(workspaceSkill.filePath)).toBe(gatewayCopy.filePath);
  expect(materialized.rewriteReferences("workspace-skill://workspace/guide/SKILL.md")).toBe(
    workspaceCopy.filePath,
  );
  expect(await read(gatewayCopy.baseDir, "check.sh")).toBe("stale Gateway script");
  expect(await read(workspaceCopy.baseDir, "check.sh")).toBe("current host script");
});

it("delivers Gateway Workshop files without a live workspace binding", async () => {
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: { agentDir: path.join(f.gateway, "agent") } } },
  };
  const workshop = resolveWorkshopSkillsDir(config, "main");
  for (const name of ["visible", "hidden"]) {
    await writeSkill(path.join(workshop, name), name, name === "hidden");
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
    const skill = materialized.skill(name);
    expect(await read(skill.baseDir, "run.sh")).toBe(`echo ${name}`);
    expect((await fs.stat(path.join(skill.baseDir, "run.sh"))).mode & 0o111).not.toBe(0);
  }
  expect(f.skillResources.resolveExplicitSkill).not.toHaveBeenCalled();
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
});

it("resolves explicit hidden Skills on the host before native catalog validation", async () => {
  await writeSkill(path.join(f.host, "skills", "hidden"), "hidden", true, "Hidden instructions.");
  f.snapshot.skills.push({ name: "hidden" });
  const selected = {
    name: "command-alias",
    path: path.join(f.gateway, "skills", "hidden", "SKILL.md"),
  };
  const delivery = await f.deliver([selected]);
  expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
  expect(delivery?.skills.map((skill) => skill.name)).toEqual(["guide", "hidden"]);
  expect(delivery?.skills[1]).toMatchObject({ sourcePath: selected.path, modelVisible: true });
});

it("delivers the selected host's hidden Skill when both hosts use the same path", async () => {
  for (const [root, text] of [
    [f.gateway, "Gateway hidden resource"],
    [f.host, "Node hidden resource"],
  ] as const) {
    const hidden = path.join(root, "skills", "hidden");
    await writeSkill(hidden, "hidden", true, `${text} instructions.`);
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
  const { rewriteReferences: rewrite } = materialized;
  const hidden = materialized.skill("hidden");
  expect(await fs.readFile(hidden.filePath, "utf8")).toContain(
    "Node hidden resource instructions.",
  );
  expect(await read(hidden.baseDir, "resource.txt")).toBe("Node hidden resource");
  expect(rewrite(expandedReference)).toContain(`SKILL.md: ${hidden.filePath}`);
  expect(rewrite("workspace-skill://workspace/hidden/resource.txt")).toBe(
    path.join(hidden.baseDir, "resource.txt"),
  );
  expect(f.skillResources.resolveExplicitSkill).toHaveBeenCalledWith(selected);
});

it("skips a vanished discovered host root but still rejects its explicit selection", async () => {
  await fs.rm(path.join(f.host, "skills", "guide"), { recursive: true });
  await expect(f.deliver()).resolves.toEqual({ version: 1, skills: [] });
  await expect(
    f.deliver([{ name: "guide", path: path.join(f.gateway, "skills", "guide", "SKILL.md") }]),
  ).rejects.toThrow("guide");
});

it("does not fall back to Gateway files after the host binding stops", async () => {
  f.release();
  await expect(f.deliver()).rejects.toThrow("stopped or not ready");
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
});

it("preserves local resource delivery for stopped document-only adapters", async () => {
  f.release();
  const readFile = vi.fn();
  const release = registerAgentWorkspaceAccess(f.gateway, {
    bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
  });
  release();
  cleanups.push(release);
  const materialized = await materializeSkillResources((await f.deliver())!);
  expect(await read(materialized.skill().baseDir, "check.sh")).toBe("stale Gateway script");
  expect(readFile).not.toHaveBeenCalled();
});

it("stamps each host's bundle identity when Gateway and workspace skills share one path", async () => {
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
  registerActiveTracingBridge();
  const stamped = await stampDiscoveredSkillBundleIdentities(
    f.snapshot.resolvedSkills ?? [],
    f.gateway,
  );
  const gatewayEntry = stamped.find((skill) => skill.name === gatewaySkill.name);
  const workspaceEntry = stamped.find((skill) => skill.name === workspaceSkill.name);
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
});

it("reads remote-hosted bundle identities through the owning reader when the path is absent on the Gateway", async () => {
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
  registerActiveTracingBridge();
  const stamped = await stampDiscoveredSkillBundleIdentities(
    f.snapshot.resolvedSkills ?? [],
    f.gateway,
  );
  const entry = stamped.find((skill) => skill.name === "hostonly");
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
    registerActiveTracingBridge();
    const stamped = await stampDiscoveredSkillBundleIdentities(
      snapshot.resolvedSkills ?? [],
      gateway,
    );
    const entry = stamped[0];
    // The owning reader is unavailable, so the identity omits instead of
    // guessing which host owns the bytes.
    expect(entry?.bundleFingerprint).toBeUndefined();
  } finally {
    release();
  }
});

it("omits an identity without failing the preparation when its reader walk fails", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  // The owning reader's tree walk fails: the identity is telemetry-only, so
  // the preparation omits it instead of failing the run.
  f.skillResources.readSkillFiles.mockImplementationOnce(() =>
    Promise.reject(new Error("reader transport failed")),
  );
  registerActiveTracingBridge();
  const stamped = await stampDiscoveredSkillBundleIdentities(
    f.snapshot.resolvedSkills ?? [],
    f.gateway,
  );
  const entry = stamped.find((skill) => skill.name === workspaceSkill.name);
  if (!entry) {
    throw new Error("missing stamped workspace entry");
  }
  expect(entry.bundleFingerprint).toBeUndefined();
});

it("omits a carried stamp when a reload recomputation fails to re-verify it", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  // The watcher observed a reload, and the entry carries the previous
  // bundle's stamp; the recomputing tree walk fails once (transient
  // transport). The refresh cannot re-verify the carried stamp against
  // the reloaded bundle, so the entry omits its identity instead of
  // describing the previous bundle.
  f.skillResources.readSkillFiles.mockImplementationOnce(() =>
    Promise.reject(new Error("reader transport failed")),
  );
  registerActiveTracingBridge();
  const stamped = await stampDiscoveredSkillBundleIdentities(
    [{ ...workspaceSkill, bundleFingerprint: "fp-previous-bundle" }],
    f.gateway,
    { recompute: true },
  );
  const entry = stamped.find((skill) => skill.name === workspaceSkill.name);
  if (!entry) {
    throw new Error("missing stamped workspace entry");
  }
  expect(entry.bundleFingerprint).toBeUndefined();
});

it("walks discovered bundles concurrently and coalesces same-directory siblings", async () => {
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
  // A same-directory sibling of the guide entry: two entries sharing one
  // loaded bundle directory must coalesce into a single walk.
  extraSkills.push(
    recordSkillFileHost(
      createCanonicalFixtureSkill({
        name: "guide-alias",
        description: "Guide alias",
        filePath: path.join(f.gateway, "skills", "guide", "SKILL.md"),
        baseDir: path.join(f.gateway, "skills", "guide"),
        source: "openclaw-workspace",
      }),
      "workspace",
    ),
  );
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
  registerActiveTracingBridge();
  const pending = stampDiscoveredSkillBundleIdentities(snapshot.resolvedSkills ?? [], f.gateway);
  // All distinct discovery walks start together — never serialized behind
  // an earlier bundle — and the same-directory sibling joins the guide
  // bundle's single walk instead of starting its own.
  for (let i = 0; i < 100 && gates.length < 3; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  expect(gates.length).toBe(3);
  for (const release of gates) {
    release();
  }
  const stamped = await pending;
  for (const skill of snapshot.resolvedSkills ?? []) {
    const entry = stamped.find((candidate) => candidate.name === skill.name);
    expect(entry?.bundleFingerprint).toBeTypeOf("string");
  }
  // The sibling's stamp is the same loaded bundle's identity.
  const guide = stamped.find((skill) => skill.name === "guide");
  const alias = stamped.find((skill) => skill.name === "guide-alias");
  expect(alias?.bundleFingerprint).toBe(guide?.bundleFingerprint);
});
it("hashes no bundles while tracing is disabled and keeps entries unstamped", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  f.skillResources.readSkillFiles.mockClear();
  // No exporter-owned tracing consumer is registered: the discovery pass
  // hashes nothing and copies the entries through unstamped.
  const stamped = await stampDiscoveredSkillBundleIdentities(
    f.snapshot.resolvedSkills ?? [],
    f.gateway,
  );
  expect(f.skillResources.readSkillFiles).not.toHaveBeenCalled();
  expect(stamped).toHaveLength((f.snapshot.resolvedSkills ?? []).length);
  expect(stamped.every((skill) => skill.bundleFingerprint === undefined)).toBe(true);
});

it("restamps the edited bundle after a watcher reload and never re-hashes a carried stamp", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  registerActiveTracingBridge();
  f.skillResources.readSkillFiles.mockClear();
  const before = await stampDiscoveredSkillBundleIdentities([workspaceSkill], f.gateway);
  const identityBefore = before[0]?.bundleFingerprint;
  expect(identityBefore).toBeTypeOf("string");
  expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
  // A support-file-only edit lands before the watcher's reload: the loaded
  // version keeps its identity (the disclosed staleness window).
  const guideHostDir = path.join(f.host, "skills", "guide");
  await fs.writeFile(path.join(guideHostDir, "check.sh"), "edited but not yet reloaded\n");
  const unchanged = await stampDiscoveredSkillBundleIdentities([before[0]!], f.gateway);
  expect(unchanged[0]?.bundleFingerprint).toBe(identityBefore);
  // No new walk and no re-hash: the carried stamp is trusted verbatim.
  expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
  // The watcher reloads the edited skill: the version bump restamps from the
  // reloaded tree, so future spans carry the new bundle identity.
  bumpSkillsSnapshotVersion({ workspaceDir: f.gateway, reason: "manual" });
  f.skillResources.readSkillFiles.mockClear();
  const after = await stampDiscoveredSkillBundleIdentities([workspaceSkill], f.gateway);
  const identityAfter = after[0]?.bundleFingerprint;
  expect(identityAfter).toBeTypeOf("string");
  expect(identityAfter).not.toBe(identityBefore);
  expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
});

it("re-stamps through the scoped resource version an execution-root watcher publishes", async () => {
  const workspaceSkill = f.snapshot.resolvedSkills?.[0];
  if (!workspaceSkill) {
    throw new Error("missing workspace skill fixture");
  }
  recordSkillFileHost(workspaceSkill, "workspace");
  const sourceScope: SkillsSourceScope = {
    executionWorkspaceDir: path.join(f.host, "execution"),
  };
  registerActiveTracingBridge();
  f.skillResources.readSkillFiles.mockClear();
  const before = await stampDiscoveredSkillBundleIdentities([workspaceSkill], f.gateway, {
    sourceScope,
  });
  const identityBefore = before[0]?.bundleFingerprint;
  expect(identityBefore).toBeTypeOf("string");
  // Steady state reuses the cached walk: the same loaded version hashes once.
  await stampDiscoveredSkillBundleIdentities([workspaceSkill], f.gateway, { sourceScope });
  expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(1);
  // An execution-root support-file edit publishes under its source scope, and
  // the unscoped version read cannot see it: the scoped read must drive the
  // cache identity, or even a fresh preparation reuses the obsolete stamp.
  await fs.writeFile(path.join(f.host, "skills", "guide", "check.sh"), "scoped watcher edit\n");
  markSkillsSupportingFilesChanged({ workspaceDir: f.gateway, sourceScopes: [sourceScope] });
  const after = await stampDiscoveredSkillBundleIdentities([workspaceSkill], f.gateway, {
    sourceScope,
  });
  expect(after[0]?.bundleFingerprint).toBeTypeOf("string");
  expect(after[0]?.bundleFingerprint).not.toBe(identityBefore);
  expect(f.skillResources.readSkillFiles).toHaveBeenCalledTimes(2);
});
