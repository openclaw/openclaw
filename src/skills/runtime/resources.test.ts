import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { escapeSkillXml, formatSkillsCompactForPrompt } from "../loading/skill-contract.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { SkillResourceDeliveryLimitError } from "./resource-delivery-error.js";
import {
  materializeSkillResources,
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
const read = (file: string) => fs.readFile(file, "utf8");
const selected = (name: string, dir: string) => ({ name, path: path.join(dir, "SKILL.md") });
async function writeSkill(name: string, content = markdown) {
  const directory = path.join(workspace, "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}
async function loadSnapshot(config?: OpenClawConfig) {
  const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
  return await buildSkillSnapshot(workspace, { entries, config });
}
async function materialize(
  delivery: Parameters<typeof materializeSkillResources>[0],
  scope?: Parameters<typeof materializeSkillResources>[2],
) {
  const resource = await materializeSkillResources(delivery, () => {}, scope);
  releases.push(resource.cleanup);
  return resource;
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
  const delivery = await prepare(snapshot, [selected("zz-explicit", hidden)]);
  expect(delivery?.skills).toHaveLength(256);
  expect(delivery?.skills.find((skill) => skill.name === "guide-000")).toMatchObject({
    modelVisible: true,
  });
  expect(delivery?.skills.find((skill) => skill.name === "zz-explicit")).toMatchObject({
    modelVisible: true,
  });
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
  const previousPrompt = first.snapshot.prompt;
  const previousRewrittenPrompt = first.rewriteReferences(gatewayPrompt);
  let expectedPrompt = gatewayPrompt;
  for (const source of gatewaySkills) {
    const target = first.snapshot.resolvedSkills.find((skill) => skill.name === source.name)!;
    expectedPrompt = expectedPrompt.replace(
      `<location>${escapeSkillXml(source.filePath)}</location>`,
      `<location>${escapeSkillXml(target.filePath)}</location>`,
    );
  }
  expect(previousRewrittenPrompt).toBe(expectedPrompt);
  expect(previousRewrittenPrompt).not.toContain("~/gateway/");
  const previousReference = first.rewriteReferences(support);
  expect(path.basename(first.directory)).toMatch(/^skill-resources-[a-f0-9]{16}$/);
  expect(path.basename(path.dirname(previousReference))).toMatch(/^alphatools-[a-f0-9]{12}$/);
  await first.cleanup();
  expect(existsSync(first.directory)).toBe(false);

  const second = await materialize({ ...delivery, skills: delivery.skills.toReversed() }, scope);
  expect(second.snapshot.prompt).toBe(previousPrompt);
  expect(second.rewriteReferences(gatewayPrompt)).toBe(previousRewrittenPrompt);
  expect(second.rewriteReferences(support)).toBe(previousReference);
  expect(await read(previousReference)).toBe("original reference");
  // A retained cleanup handle must never delete a later turn's files.
  await first.cleanup();
  expect(await read(previousReference)).toBe("original reference");
  await second.cleanup();

  await fs.writeFile(support, "refreshed reference");
  const refreshed = (await prepare(snapshot))!;
  const third = await materialize(refreshed, scope);
  expect(third.rewriteReferences(support)).not.toBe(previousReference);
  expect(await read(third.rewriteReferences(support))).toBe("refreshed reference");
  expect(existsSync(previousReference)).toBe(false);
});

it("rewrites unambiguous XML catalog locations without choosing between same-named sources", async () => {
  await writeSkill("guide");
  const delivery = (await prepare(await loadSnapshot()))!;
  const name = "Review & Guide";
  const source = delivery.skills[0]!;
  const materialized = await materialize({
    ...delivery,
    skills: [
      { ...source, name, displayName: "first", sourcePath: "/first/SKILL.md" },
      { ...source, name, displayName: "second", sourcePath: "/second&source/SKILL.md" },
      { ...source, name: name.toLowerCase(), sourcePath: "/first/SKILL.md" },
    ],
  });
  const skills = materialized.snapshot.resolvedSkills!;
  const second = skills.find((skill) => skill.displayName === "second")!;
  const workspaceUri = `workspace-skill://workspace/${encodeURIComponent(name.trim())}/SKILL.md`;
  const prompt = formatSkillsCompactForPrompt([
    { ...second, filePath: "~/shared/SKILL.md" },
    { ...second, filePath: workspaceUri },
    { ...second, filePath: "/second&source/SKILL.md" },
    { ...second, name: name.toLowerCase(), filePath: "/external/SKILL.md" },
  ]);
  expect(materialized.rewriteReferences(prompt)).toBe(
    prompt.replace(
      "<location>/second&amp;source/SKILL.md</location>",
      `<location>${escapeSkillXml(second.filePath)}</location>`,
    ),
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
  const primary = new Error("Prepared turn closed");
  primary.name = "AbortError";
  Object.freeze(primary);
  const secret = "synthetic-cleanup-secret";
  const deletionError = new Error(`EACCES: token=${secret} ${"🦞".repeat(2_000)}`);
  const originalRm = fs.rm;
  const rm = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
    if (target === artifactRoot) {
      return Promise.reject(deletionError);
    }
    return originalRm(target, options);
  });
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

it.runIf(process.platform !== "win32")(
  "omits a discovered skill whose root becomes a broken symlink between turns",
  async () => {
    const healthyDir = await writeSkill("healthy");
    const staleDir = await writeSkill("stale");
    const snapshot = await loadSnapshot();
    expect((await prepare(snapshot))?.skills).toHaveLength(2);

    await fs.rm(staleDir, { recursive: true });
    await fs.symlink(path.join(workspace, "missing-stale-target"), staleDir, "dir");

    await expect(prepare(snapshot)).resolves.toMatchObject({ skills: [{ name: "healthy" }] });
    await fs.rm(healthyDir, { recursive: true });
    await fs.symlink(path.join(workspace, "missing-healthy-target"), healthyDir, "dir");
    await expect(prepare(snapshot)).resolves.toEqual({ version: 1, skills: [] });
    await expect(prepare(snapshot, [selected("stale", staleDir)])).rejects.toMatchObject(
      invalidBundle(/skill="stale".*root=.*stale.*ENOENT/s),
    );
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
  const snapshot = await loadSnapshot();
  const delivery = await prepare(snapshot);
  const materialized = await materialize(delivery!);
  const skill = materialized.snapshot.resolvedSkills![0]!;
  expect(skill).toMatchObject({ name: "directory-name", description: "Workspace procedure" });
  expect(await read(skill.filePath)).toBe(markdown);
  if (process.platform !== "win32") {
    expect((await fs.stat(materialized.directory)).mode & 0o777).toBe(0o700);
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
  const explicit = await prepare(snapshot, [selected("hidden", hiddenDir)]);
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
