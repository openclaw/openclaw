import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import {
  expandExplicitSkillReferences,
  skillCommandsToExplicitSelections,
} from "../discovery/chat-command-invocation.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import type { Skill } from "../loading/skill-contract.js";
import { escapeSkillXml, formatSkillsCompactForPrompt } from "../loading/skill-contract.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { recordSkillFileHost } from "../skill-file-host.js";
import { writeSkill as writeSkillDocument } from "../test-support/e2e-test-helpers.js";
import type { ExplicitSkillSelection } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { SkillResourceDeliveryLimitError } from "./resource-delivery-error.js";
import {
  materializeSkillResources,
  readSkillResourceFiles,
  resolveExplicitSkillResource,
  prepareSkillResourceDelivery as prepareDelivery,
} from "./resources.js";

const releases: (() => void | Promise<void>)[] = [];
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    let pending = Promise.resolve();
    // A failed finalizer must not strand the remaining resources.
    for (const release of [...releases.splice(0).toReversed(), cleanup]) {
      pending = pending.finally(release);
    }
    await pending;
  }),
);
let workspace: string;
beforeEach(async () => {
  workspace = await fs.realpath(temps.make("skill-resources-"));
});
const prepare = (
  snapshot: Parameters<typeof prepareDelivery>[0],
  selections: Parameters<typeof prepareDelivery>[2] = [],
) => prepareDelivery(snapshot, () => {}, selections);
const markdown = "---\ndescription: Workspace procedure\n---\n# Guide\nRun scripts/check.sh.\n";
const read = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const selectSkill = (name: string, dir: string) => ({ name, path: path.join(dir, "SKILL.md") });
const location = (file: string) => `<location>${escapeSkillXml(file)}</location>`;
async function writeSkill(name: string, content = markdown) {
  const directory = path.join(workspace, "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}
async function loadSnapshot(config?: OpenClawConfig, directory = workspace) {
  const entries = loadWorkspaceSkills(directory, { workspaceOnly: true });
  return await buildSkillSnapshot(directory, { entries, config });
}
async function materialize(
  delivery: Parameters<typeof materializeSkillResources>[0],
  scope?: Parameters<typeof materializeSkillResources>[2],
) {
  const resource = await materializeSkillResources(delivery, () => {}, scope);
  releases.push(resource.cleanup);
  return {
    ...resource,
    skill: (name = "guide") =>
      resource.snapshot.resolvedSkills.find((skill) => skill.name === name)!,
  };
}
const privateInputs = (prefix: string) =>
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temps.make(prefix));
const invalidBundle = (message: string | RegExp) => ({
  code: "INVALID_BUNDLE",
  message:
    typeof message === "string" ? expect.stringContaining(message) : expect.stringMatching(message),
});
async function expectFile(base: string, name: string, content: string, mode?: number) {
  const file = path.join(base, name);
  expect(await read(file)).toBe(content);
  expect((await fs.lstat(file)).isFile()).toBe(true);
  if (mode !== undefined && process.platform !== "win32") {
    expect((await fs.stat(file)).mode & 0o777).toBe(mode);
  }
}

it("accepts 8 MiB of combined resources and identifies aggregate overflow", async () => {
  let lastSupport = "";
  for (const name of ["alpha", "beta"]) {
    const directory = await writeSkill(name);
    for (let index = 0; index < 4; index++) {
      lastSupport = path.join(directory, `reference-${index}.txt`);
      const size = 1024 * 1024 - (index === 3 ? Buffer.byteLength(markdown) : 0);
      await fs.writeFile(lastSupport, Buffer.alloc(size, "a"));
    }
  }
  const snapshot = await loadSnapshot();
  const delivery = await prepare(snapshot);
  expect(delivery?.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);

  await fs.appendFile(lastSupport, "a");
  await expect(prepare(snapshot)).rejects.toBeInstanceOf(SkillResourceDeliveryLimitError);
});

it("reserves delivery slots for prompted and explicit skills before additional discovery", async () => {
  for (let index = 0; index < 257; index++) {
    await writeSkill(`guide-${String(index).padStart(3, "0")}`);
  }
  const hidden = await writeSkill(
    "zz-explicit",
    "---\ndescription: Explicit procedure\ndisable-model-invocation: true\n---\n# Explicit\n",
  );
  const config = {
    skills: { limits: { maxSkillsInPrompt: 1, maxSkillsLoadedPerSource: 300 } },
  };
  const snapshot = await buildSkillSnapshot(workspace, {
    entries: loadWorkspaceSkills(workspace, { workspaceOnly: true, config }),
    config,
  });
  const delivery = await prepare(snapshot, [selectSkill("zz-explicit", hidden)]);
  expect(delivery?.skills).toHaveLength(256);
  expect(
    delivery?.skills.filter((skill) => skill.modelVisible === true).map((skill) => skill.name),
  ).toEqual(["guide-000", "zz-explicit"]);
  expect(delivery?.skills.some((skill) => skill.name === "guide-256")).toBe(false);
});

it("recreates stable session paths and prompt bytes independent of delivery order", async () => {
  privateInputs("skill-stable-inputs-&-");
  const scope = { sessionId: "stable-session", workspaceDir: workspace };
  await writeSkill("beta");
  const alpha = await writeSkill("alpha&tools");
  const support = path.join(alpha, "reference.md");
  await fs.writeFile(support, "original reference");
  const snapshot = await loadSnapshot();
  const delivery = (await prepare(snapshot))!;
  const gatewaySkills = snapshot.resolvedSkills!.toReversed().map((skill) =>
    Object.assign({}, skill, {
      filePath: skill.name === "beta" ? "~/gateway/skills/beta/SKILL.md" : skill.filePath,
    }),
  );
  const gatewayPrompt = [
    "System instructions before the catalog.",
    "Skills catalog using compact format (descriptions shortened).",
    formatSkillsCompactForPrompt(gatewaySkills, { descriptionMaxChars: 8 }),
    "System instructions after the catalog.",
  ].join("\n");
  const first = await materialize(delivery, scope);
  const prompt = first.snapshot.prompt;
  const rewrittenPrompt = first.rewriteReferences(gatewayPrompt);
  let expectedPrompt = gatewayPrompt;
  for (const source of gatewaySkills) {
    const target = first.snapshot.resolvedSkills.find((skill) => skill.name === source.name)!;
    expectedPrompt = expectedPrompt.replace(location(source.filePath), location(target.filePath));
  }
  expect(rewrittenPrompt).toBe(expectedPrompt);
  expect(rewrittenPrompt).not.toContain("~/gateway/");
  const reference = first.rewriteReferences(support);
  expect(path.basename(first.directory)).toMatch(/^skill-resources-[a-f0-9]{16}$/);
  expect(path.basename(path.dirname(reference))).toMatch(/^alphatools-[a-f0-9]{12}$/);
  await first.cleanup();
  expect(existsSync(first.directory)).toBe(false);

  const second = await materialize({ ...delivery, skills: delivery.skills.toReversed() }, scope);
  expect(second.snapshot.prompt).toBe(prompt);
  expect(second.rewriteReferences(gatewayPrompt)).toBe(rewrittenPrompt);
  expect(second.rewriteReferences(support)).toBe(reference);
  expect(await read(reference)).toBe("original reference");
  // A retained cleanup handle must never delete a later turn's files.
  await first.cleanup();
  expect(await read(reference)).toBe("original reference");
  await second.cleanup();

  await fs.writeFile(support, "refreshed reference");
  const refreshed = (await prepare(snapshot))!;
  const third = await materialize(refreshed, scope);
  expect(third.rewriteReferences(support)).not.toBe(reference);
  expect(await read(third.rewriteReferences(support))).toBe("refreshed reference");
  expect(existsSync(reference)).toBe(false);
});

it("rewrites unambiguous XML catalog locations without choosing between same-named sources", async () => {
  await writeSkill("guide");
  const delivery = (await prepare(await loadSnapshot()))!;
  const name = "Review & Guide";
  const source = delivery.skills[0]!;
  const copy = await materialize({
    ...delivery,
    skills: [
      { ...source, name, displayName: "first", sourcePath: "/first/SKILL.md" },
      { ...source, name, displayName: "second", sourcePath: "/second&source/SKILL.md" },
      { ...source, name: name.toLowerCase(), sourcePath: "/first/SKILL.md" },
    ],
  });
  const skills = copy.snapshot.resolvedSkills!;
  const second = skills.find((skill) => skill.displayName === "second")!;
  const workspaceUri = `workspace-skill://workspace/${encodeURIComponent(name.trim())}/SKILL.md`;
  const prompt = formatSkillsCompactForPrompt([
    { ...second, filePath: "~/shared/SKILL.md" },
    { ...second, filePath: workspaceUri },
    { ...second, filePath: "/second&source/SKILL.md" },
    { ...second, name: name.toLowerCase(), filePath: "/external/SKILL.md" },
  ]);
  expect(copy.rewriteReferences(prompt)).toBe(
    prompt.replace("<location>/second&amp;source/SKILL.md</location>", location(second.filePath)),
  );
});

it("never replaces or cleans a live session's skill inputs and isolates other sessions", async () => {
  privateInputs("skill-locked-inputs-");
  await writeSkill("guide");
  const delivery = (await prepare(await loadSnapshot()))!;
  const scope = { sessionId: "active-session", workspaceDir: workspace };
  const first = await materialize(delivery, scope);
  await expect(materialize(delivery, scope)).rejects.toMatchObject({ code: "file_lock_timeout" });
  const other = await materialize(delivery, { ...scope, sessionId: "other-session" });
  expect(other.directory).not.toBe(first.directory);
  await other.cleanup();
  expect(await read(first.snapshot.resolvedSkills![0]!.filePath)).toBe(markdown);
});

it("preserves the exact frozen abort error after partial materialization and failed cleanup", async () => {
  const directory = await writeSkill("partial");
  await fs.writeFile(path.join(directory, "reference.md"), "supporting resource");
  const delivery = await prepare(await loadSnapshot());
  let artifactRoot: string | undefined;
  let retainedFile: string | undefined;
  const originalWriteFile = fs.writeFile;
  const writeFile = vi.spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
    await originalWriteFile(target, data, options);
    if (typeof target === "string" && path.basename(target) === "SKILL.md") {
      retainedFile = target;
      artifactRoot = path.dirname(path.dirname(target));
    }
  });
  const primary = Object.freeze(
    Object.assign(new Error("Prepared turn closed"), { name: "AbortError" }),
  );
  const secret = "synthetic-cleanup-secret";
  const deletionError = new Error(`EACCES: token=${secret} ${"🦞".repeat(2_000)}`);
  const originalRm = fs.rm;
  const rm = vi
    .spyOn(fs, "rm")
    .mockImplementation((target, options) =>
      target === artifactRoot ? Promise.reject(deletionError) : originalRm(target, options),
    );
  const warn = vi.fn();
  const previousConsole = loggingState.rawConsole;
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  try {
    const result = await materializeSkillResources(delivery!, () => {
      if (retainedFile) {
        throw primary;
      }
    }).catch((error: unknown) => error);
    expect.soft(result).toBe(primary);
    expect(retainedFile).toBeDefined();
    expect(await read(retainedFile!)).toBe(markdown);
    expect(existsSync(path.join(path.dirname(retainedFile!), "reference.md"))).toBe(false);
    const warning = warn.mock.calls.flat().map(String).join("\n");
    expect.soft(warning).toContain("Materialized skill cleanup failed");
    expect.soft(warning).toContain(path.basename(path.dirname(path.dirname(retainedFile!))));
    expect.soft(warning).toContain("EACCES");
    expect.soft(warning).not.toContain(secret);
    expect.soft(warning).not.toContain(markdown);
    expect.soft(warning.length).toBeLessThanOrEqual(1_200);
    expect.soft(Buffer.from(warning, "utf8").toString("utf8")).toBe(warning);
  } finally {
    writeFile.mockRestore();
    rm.mockRestore();
    loggingState.rawConsole = previousConsole;
    setLoggerOverride(null);
    resetLogger();
    if (artifactRoot) {
      await fs.rm(artifactRoot, { recursive: true, force: true });
    }
  }
});

it.each([false, true])(
  "keeps concurrent turn cancellation isolated (rehydrated: %s)",
  async (rehydrated) => {
    await writeSkill("independent");
    const snapshot = {
      ...(await loadSnapshot()),
      ...(rehydrated ? { version: 1 } : {}),
    };
    let closed = false;
    const cancelled = prepareDelivery(snapshot, () => {
      if (closed) {
        throw new Error("Turn closed");
      }
    });
    const active = prepare(rehydrated ? structuredClone(snapshot) : snapshot);
    closed = true;
    expect(await Promise.allSettled([cancelled, active])).toMatchObject([
      { status: "rejected", reason: new Error("Turn closed") },
      { status: "fulfilled", value: { skills: [{ name: "independent" }] } },
    ]);
    expect(await prepare(snapshot)).toEqual(await active);
  },
);

it("names an unavailable explicit skill and root", async () => {
  await writeSkill("visible");
  const missingPath = path.join(workspace, "skills", "missing", "SKILL.md");

  await expect(
    prepare(await loadSnapshot(), [{ name: "missing", path: missingPath }]),
  ).rejects.toMatchObject(invalidBundle(/skill="missing".*root=.*missing.*ENOENT/s));
});

it("materializes directory-name skills and contained aliases with exact bytes and permissions", async () => {
  const directory = await writeSkill("directory-name");
  const instructions = "# Review instructions\nPreserve the user's changes.\n";
  const script = "#!/bin/sh\nprintf ready\n";
  await fs.writeFile(path.join(directory, "AGENTS.md"), instructions);
  await fs.mkdir(path.join(directory, "scripts"));
  await fs.writeFile(path.join(directory, "scripts/check.sh"), script, { mode: 0o700 });
  const instructionFiles = ["AGENTS.md"];
  const scriptFiles = ["scripts/check.sh"];
  if (process.platform !== "win32") {
    await fs.symlink("AGENTS.md", path.join(directory, "CLAUDE.md"));
    await fs.symlink("scripts/check.sh", path.join(directory, "check.sh"));
    instructionFiles.push("CLAUDE.md");
    scriptFiles.push("check.sh");
  }
  const copy = await materialize((await prepare(await loadSnapshot()))!);
  const skill = copy.snapshot.resolvedSkills![0]!;
  expect(skill).toMatchObject({ name: "directory-name", description: "Workspace procedure" });
  expect(await read(skill.filePath)).toBe(markdown);
  if (process.platform !== "win32") {
    expect((await fs.stat(copy.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(skill.filePath)).mode & 0o777).toBe(0o400);
  }
  for (const name of instructionFiles) {
    await expectFile(skill.baseDir, name, instructions);
  }
  for (const name of scriptFiles) {
    await expectFile(skill.baseDir, name, script, 0o500);
  }
});

it
  .runIf(process.platform !== "win32")
  .each(["outside", "broken", "cycle", "directory", "hardlink", "excluded"] as const)(
  "rejects %s skill aliases with selected skill diagnostics",
  async (kind) => {
    const directory = await writeSkill("linked");
    const alias = path.join(directory, "linked-support");
    const target = {
      outside: path.join(workspace, "outside.txt"),
      broken: "missing",
      cycle: "linked-support",
      directory: "support",
      hardlink: "support.txt",
      excluded: ".git/config",
    }[kind];
    if (kind === "directory") {
      await fs.mkdir(path.join(directory, target));
    } else if (["outside", "hardlink", "excluded"].includes(kind)) {
      const file = path.resolve(directory, target);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "support");
    }
    await (kind === "hardlink"
      ? fs.link(path.join(directory, target), alias)
      : fs.symlink(target, alias));
    await expect(prepare(await loadSnapshot())).rejects.toMatchObject(
      invalidBundle(/skill="linked".*root=.*linked/s),
    );
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a file moved into an excluded tree while its alias is opening",
  async () => {
    const directory = await writeSkill("linked");
    const target = path.join(directory, "support.txt");
    const excluded = path.join(directory, ".git", "support.txt");
    await fs.mkdir(path.dirname(excluded));
    await fs.writeFile(target, "supporting instructions");
    await fs.symlink("support.txt", path.join(directory, "alias.txt"));
    const snapshot = await loadSnapshot();
    const originalOpen = fs.open;
    let moved = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (file === target && !moved) {
        moved = true;
        await fs.rename(target, excluded);
        await fs.symlink(".git/support.txt", target);
      }
      return handle;
    });
    await expect(prepare(snapshot)).rejects.toMatchObject(
      invalidBundle("link target is not an included regular file"),
    );
    expect(moved).toBe(true);
  },
);

it("excludes Git and dependency trees before spending the traversal budget", async () => {
  const directory = await writeSkill("guide");
  await fs.mkdir(path.join(directory, ".git"));
  await Promise.all(
    Array.from({ length: 513 }, (_, index) =>
      fs.writeFile(path.join(directory, ".git", String(index)), ""),
    ),
  );
  await fs.mkdir(path.join(directory, "node_modules", "dependency"), { recursive: true });
  await fs.writeFile(path.join(directory, "node_modules", "dependency", "index.js"), "excluded");
  const delivery = await prepare(await loadSnapshot());
  expect(delivery?.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
});

it("delivers only selected resources from a large discovery catalog and admits explicit hidden skills without changing the snapshot", async () => {
  await writeSkill("visible");
  const hiddenMarkdown = markdown.replace("---\n", "---\ndisable-model-invocation: true\n");
  const hiddenDir = await writeSkill("hidden", hiddenMarkdown);
  const omittedDir = await writeSkill("z-omitted");
  const snapshot = await loadSnapshot({ skills: { limits: { maxSkillsInPrompt: 1 } } });
  expect(snapshot.prompt).toContain("<name>visible</name>");
  expect(snapshot.prompt).not.toContain("<name>z-omitted</name>");
  expect(snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["visible"]);
  const omitted = snapshot.discoverySkills!.find((skill) => skill.name === "z-omitted")!;
  snapshot.discoverySkills!.push(
    ...Array.from({ length: 300 }, (_, index) => ({ ...omitted, name: `extra-${index}` })),
  );
  await fs.rm(omittedDir, { recursive: true });
  const before = structuredClone(snapshot);
  const ordinary = await prepare(snapshot);
  expect(ordinary?.skills.map((skill) => skill.name)).toEqual(["visible"]);
  const explicit = await prepare(snapshot, [selectSkill("hidden", hiddenDir)]);
  expect(explicit?.skills.map((skill) => skill.name)).toEqual(["visible", "hidden"]);
  expect(explicit?.skills[1]?.modelVisible).toBe(true);
  expect(snapshot).toEqual(before);
  expect(await prepare(snapshot)).toEqual(ordinary);
  const worker = await materialize(ordinary!);
  expect(worker.snapshot.discoverySkills?.map((skill) => skill.name)).toEqual(["visible"]);
  const delivered = worker.snapshot.discoverySkills![0]!;
  expect(delivered.filePath).not.toBe(snapshot.resolvedSkills![0]!.filePath);
  expect(await read(delivered.filePath)).toBe(markdown);
});

async function writeHostSkill(dir: string, name: string, hidden = false, body?: string) {
  await writeSkillDocument({
    dir,
    name,
    description: name,
    body,
    frontmatterExtra: hidden ? "disable-model-invocation: true" : undefined,
  });
}
async function remoteFixture() {
  const gateway = path.join(workspace, "gateway");
  const host = path.join(workspace, "host");
  for (const [base, text] of [
    [gateway, "stale Gateway script"],
    [host, "current host script"],
  ] as const) {
    const dir = path.join(base, "skills", "guide");
    await writeHostSkill(dir, "guide", false, "Use check.sh.");
    await fs.writeFile(path.join(dir, "check.sh"), text);
  }
  const snapshot = await loadSnapshot(undefined, gateway);
  const toHost = (file: string) => path.join(host, path.relative(gateway, file));
  const toGateway = (skill: Skill): Skill => ({
    ...skill,
    filePath: path.join(gateway, path.relative(host, skill.filePath)),
    baseDir: path.join(gateway, path.relative(host, skill.baseDir)),
  });
  const reader = {
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
    skillResources: reader,
    loadSkills: async () => ({
      entries: loadWorkspaceSkills(host, { workspaceOnly: true }).map((entry) =>
        Object.assign({}, entry, { skill: toGateway(entry.skill) }),
      ),
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  releases.push(release);
  const deliver = (selected: ExplicitSkillSelection[] = [], source = snapshot) =>
    prepareDelivery(source, () => {}, selected, gateway);
  return { gateway, host, snapshot, reader, release, deliver };
}

it("keeps Gateway and workspace rewrites separate when their source paths collide", async () => {
  const f = await remoteFixture();
  const hostSkill = f.snapshot.resolvedSkills![0]!;
  recordSkillFileHost(hostSkill, "workspace");
  const localSkill = recordSkillFileHost({ ...hostSkill, name: "zeta-gateway-guide" }, "gateway");
  f.snapshot.skills.push({ name: localSkill.name });
  f.snapshot.resolvedSkills?.push(localSkill);
  const copy = await materialize((await f.deliver())!);
  const localCopy = copy.skill(localSkill.name);
  const hostCopy = copy.skill();
  expect(copy.rewriteReferences(hostSkill.filePath)).toBe(localCopy.filePath);
  expect(copy.rewriteReferences("workspace-skill://workspace/guide/SKILL.md")).toBe(
    hostCopy.filePath,
  );
  expect(await read(localCopy.baseDir, "check.sh")).toBe("stale Gateway script");
  expect(await read(hostCopy.baseDir, "check.sh")).toBe("current host script");
});

it("delivers Gateway Workshop files without a live workspace binding", async () => {
  const f = await remoteFixture();
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: { agentDir: path.join(f.gateway, "agent") } } },
  };
  const workshop = resolveWorkshopSkillsDir(config, "main");
  for (const name of ["visible", "hidden"]) {
    await writeHostSkill(path.join(workshop, name), name, name === "hidden");
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
  const copy = await materialize(delivery!);
  for (const name of ["visible", "hidden"]) {
    const skill = copy.skill(name);
    expect(await read(skill.baseDir, "run.sh")).toBe(`echo ${name}`);
    expect((await fs.stat(path.join(skill.baseDir, "run.sh"))).mode & 0o111).not.toBe(0);
  }
  expect(f.reader.resolveExplicitSkill).not.toHaveBeenCalled();
  expect(f.reader.readSkillFiles).not.toHaveBeenCalled();
});

it("resolves explicit hidden Skills on the host before native catalog validation", async () => {
  const f = await remoteFixture();
  await writeHostSkill(path.join(f.host, "skills", "hidden"), "hidden", true);
  f.snapshot.skills.push({ name: "hidden" });
  const selected = {
    name: "command-alias",
    path: path.join(f.gateway, "skills", "hidden", "SKILL.md"),
  };
  const delivery = await f.deliver([selected]);
  expect(f.reader.resolveExplicitSkill).toHaveBeenCalledWith(selected);
  expect(delivery?.skills.map((skill) => skill.name)).toEqual(["guide", "hidden"]);
  expect(delivery?.skills[1]).toMatchObject({ sourcePath: selected.path, modelVisible: true });
});

it("delivers the selected host's hidden Skill when both hosts use the same path", async () => {
  const f = await remoteFixture();
  for (const [root, text] of [
    [f.gateway, "Gateway hidden resource"],
    [f.host, "Node hidden resource"],
  ] as const) {
    const hidden = path.join(root, "skills", "hidden");
    await writeHostSkill(hidden, "hidden", true, `${text} instructions.`);
    await fs.writeFile(path.join(hidden, "resource.txt"), text);
  }
  const hiddenPath = path.join(f.gateway, "skills", "hidden", "SKILL.md");
  f.snapshot.skills.push({ name: "hidden", gatewayFilePath: hiddenPath }, { name: "hidden" });
  const hostEntry = loadWorkspaceSkills(f.host, { workspaceOnly: true }).find(
    (entry) => entry.skill.name === "hidden",
  )!;
  hostEntry.skill = recordSkillFileHost({ ...hostEntry.skill, filePath: hiddenPath }, "workspace");
  const [command] = buildWorkspaceSkillCommandSpecs(f.gateway, { entries: [hostEntry] });
  const [selected] = skillCommandsToExplicitSelections([command!]);
  expect(selected).toEqual({ name: "hidden", path: hiddenPath });
  const expanded = expandExplicitSkillReferences({
    text: "$hidden",
    skillCommands: [command!],
  }).body;
  expect(expanded).toContain("SKILL.md: workspace-skill://workspace/hidden/SKILL.md");
  const delivery = await f.deliver([selected!]);
  const copy = await materialize(delivery!);
  const { rewriteReferences: rewrite } = copy;
  const hidden = copy.skill("hidden");
  expect(await fs.readFile(hidden.filePath, "utf8")).toContain(
    "Node hidden resource instructions.",
  );
  expect(await read(hidden.baseDir, "resource.txt")).toBe("Node hidden resource");
  expect(rewrite(expanded)).toContain(`SKILL.md: ${hidden.filePath}`);
  expect(rewrite("workspace-skill://workspace/hidden/resource.txt")).toBe(
    path.join(hidden.baseDir, "resource.txt"),
  );
  expect(f.reader.resolveExplicitSkill).toHaveBeenCalledWith(selected);
});

it("skips a vanished discovered host root but still rejects its explicit selection", async () => {
  const f = await remoteFixture();
  await fs.rm(path.join(f.host, "skills", "guide"), { recursive: true });
  await expect(f.deliver()).resolves.toEqual({ version: 1, skills: [] });
  await expect(
    f.deliver([{ name: "guide", path: path.join(f.gateway, "skills", "guide", "SKILL.md") }]),
  ).rejects.toThrow("guide");
});

it("does not fall back to Gateway files after the host binding stops", async () => {
  const f = await remoteFixture();
  f.release();
  await expect(f.deliver()).rejects.toThrow("stopped or not ready");
  expect(f.reader.readSkillFiles).not.toHaveBeenCalled();
});

it("preserves local resource delivery for stopped document-only adapters", async () => {
  const f = await remoteFixture();
  f.release();
  const readFile = vi.fn();
  const release = registerAgentWorkspaceAccess(f.gateway, {
    bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
  });
  release();
  releases.push(release);
  const copy = await materialize((await f.deliver())!);
  expect(await read(copy.skill().baseDir, "check.sh")).toBe("stale Gateway script");
  expect(readFile).not.toHaveBeenCalled();
});
