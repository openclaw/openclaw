import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { SkillResourceDeliveryLimitError } from "./resource-delivery-error.js";
import { materializeSkillResources, prepareSkillResourceDelivery } from "./resources.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const markdown = "---\ndescription: Workspace procedure\n---\n# Guide\nRun scripts/check.sh.\n";
async function writeSkill(workspace: string, name: string, content = markdown) {
  const directory = path.join(workspace, "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}
async function loadSnapshot(workspace: string) {
  const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
  return await buildSkillSnapshot(workspace, { entries });
}

describe("prepared workspace skill resources", () => {
  it("accepts 8 MiB of combined resources and identifies aggregate overflow", async () => {
    const workspace = temps.make("skill-delivery-limit-");
    let lastSupport = "";
    for (const name of ["alpha", "beta"]) {
      const directory = await writeSkill(workspace, name);
      for (let index = 0; index < 4; index++) {
        lastSupport = path.join(directory, `reference-${index}.txt`);
        const size = 1024 * 1024 - (index === 3 ? Buffer.byteLength(markdown) : 0);
        await fs.writeFile(lastSupport, Buffer.alloc(size, "a"));
      }
    }
    const snapshot = await loadSnapshot(workspace);
    const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(delivery?.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);

    await fs.appendFile(lastSupport, "a");
    await expect(prepareSkillResourceDelivery(snapshot, () => {})).rejects.toBeInstanceOf(
      SkillResourceDeliveryLimitError,
    );
  });

  it("recreates stable session paths and prompt bytes independent of delivery order", async () => {
    const workspace = await fs.realpath(temps.make("skill-stable-workspace-"));
    const root = temps.make("skill-stable-inputs-");
    const resolveRoot = vi
      .spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(root);
    const scope = { sessionId: "stable-session", workspaceDir: workspace };
    await writeSkill(workspace, "beta");
    const alpha = await writeSkill(workspace, "alpha");
    const support = path.join(alpha, "reference.md");
    await fs.writeFile(support, "original reference");
    const snapshot = await loadSnapshot(workspace);
    const delivery = (await prepareSkillResourceDelivery(snapshot, () => {}))!;
    try {
      const first = await materializeSkillResources(delivery, () => {}, scope);
      const previousPrompt = first.snapshot.prompt;
      const previousReference = first.rewriteReferences(support);
      expect(path.basename(first.directory)).toMatch(/^skill-resources-[a-f0-9]{16}$/);
      expect(path.basename(path.dirname(previousReference))).toMatch(/^alpha-[a-f0-9]{12}$/);
      await first.cleanup();
      expect(existsSync(first.directory)).toBe(false);

      const second = await materializeSkillResources(
        { ...delivery, skills: delivery.skills.toReversed() },
        () => {},
        scope,
      );
      try {
        expect(second.snapshot.prompt).toBe(previousPrompt);
        expect(second.rewriteReferences(support)).toBe(previousReference);
        expect(await fs.readFile(previousReference, "utf8")).toBe("original reference");
        // A retained cleanup handle must never delete a later turn's files.
        await first.cleanup();
        expect(await fs.readFile(previousReference, "utf8")).toBe("original reference");
      } finally {
        await second.cleanup();
      }

      await fs.writeFile(support, "refreshed reference");
      const refreshed = (await prepareSkillResourceDelivery(snapshot, () => {}))!;
      const third = await materializeSkillResources(refreshed, () => {}, scope);
      try {
        expect(third.rewriteReferences(support)).not.toBe(previousReference);
        expect(await fs.readFile(third.rewriteReferences(support), "utf8")).toBe(
          "refreshed reference",
        );
        expect(existsSync(previousReference)).toBe(false);
      } finally {
        await third.cleanup();
      }
    } finally {
      resolveRoot.mockRestore();
    }
  });

  it("never replaces or cleans a live session's skill inputs and isolates other sessions", async () => {
    const workspace = await fs.realpath(temps.make("skill-locked-workspace-"));
    const root = temps.make("skill-locked-inputs-");
    const resolveRoot = vi
      .spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(root);
    await writeSkill(workspace, "guide");
    const delivery = (await prepareSkillResourceDelivery(await loadSnapshot(workspace), () => {}))!;
    const scope = { sessionId: "active-session", workspaceDir: workspace };
    const first = await materializeSkillResources(delivery, () => {}, scope);
    try {
      await expect(materializeSkillResources(delivery, () => {}, scope)).rejects.toMatchObject({
        code: "file_lock_timeout",
      });
      const other = await materializeSkillResources(delivery, () => {}, {
        ...scope,
        sessionId: "other-session",
      });
      expect(other.directory).not.toBe(first.directory);
      await other.cleanup();
      expect(await fs.readFile(first.snapshot.resolvedSkills![0]!.filePath, "utf8")).toBe(markdown);
    } finally {
      await first.cleanup();
      resolveRoot.mockRestore();
    }
  });

  it("preserves the exact frozen abort error after partial materialization and failed cleanup", async () => {
    const workspace = temps.make("skill-rollback-");
    const directory = await writeSkill(workspace, "partial");
    await fs.writeFile(path.join(directory, "reference.md"), "supporting resource");
    const delivery = await prepareSkillResourceDelivery(await loadSnapshot(workspace), () => {});
    let artifactRoot: string | undefined;
    let retainedFile: string | undefined;
    const originalWriteFile = fs.writeFile;
    const writeFile = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (target, data, options) => {
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
      expect(await fs.readFile(retainedFile!, "utf8")).toBe(markdown);
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

  it("delivers current supporting bytes to a fresh worker with a rehydrated catalog snapshot", async () => {
    const workspace = await fs.realpath(temps.make("skill-resource-refresh-"));
    const directory = await writeSkill(workspace, "mutable");
    const scriptPath = path.join(directory, "scripts/check.sh");
    await fs.mkdir(path.dirname(scriptPath));
    await fs.writeFile(scriptPath, "#!/bin/sh\nprintf before\n");
    const snapshot = {
      ...(await loadSnapshot(workspace)),
      version: 1,
    };
    const first = await prepareSkillResourceDelivery(snapshot, () => {});
    const preparedBytes = structuredClone(first);
    await fs.writeFile(scriptPath, "#!/bin/sh\nprintf after\n");
    const next = await prepareSkillResourceDelivery(structuredClone(snapshot), () => {});
    const worker = await materializeSkillResources(next!, () => {});
    try {
      const skill = worker.snapshot.resolvedSkills![0]!;
      expect(skill.contentHash).toBe(next!.skills[0]!.revision);
      expect(skill.contentHash).not.toBe(first!.skills[0]!.revision);
      expect(await fs.readFile(path.join(skill.baseDir, "scripts/check.sh"), "utf8")).toBe(
        "#!/bin/sh\nprintf after\n",
      );
      expect(await fs.readFile(skill.filePath, "utf8")).toBe(markdown);
      expect(first).toEqual(preparedBytes);
    } finally {
      await worker.cleanup();
    }
  });

  it.each([false, true])(
    "keeps concurrent turn cancellation isolated (rehydrated: %s)",
    async (rehydrated) => {
      const workspace = await fs.realpath(temps.make("skill-turns-"));
      await writeSkill(workspace, "independent");
      const snapshot = {
        ...(await loadSnapshot(workspace)),
        ...(rehydrated ? { version: 1 } : {}),
      };
      let closed = false;
      const cancelled = prepareSkillResourceDelivery(snapshot, () => {
        if (closed) {
          throw new Error("Turn closed");
        }
      });
      const active = prepareSkillResourceDelivery(
        rehydrated ? structuredClone(snapshot) : snapshot,
        () => {},
      );
      closed = true;
      const [cancelledResult, activeResult] = await Promise.allSettled([cancelled, active]);
      expect(cancelledResult).toMatchObject({
        status: "rejected",
        reason: new Error("Turn closed"),
      });
      expect(activeResult).toMatchObject({
        status: "fulfilled",
        value: { skills: [{ name: "independent" }] },
      });
      expect(await prepareSkillResourceDelivery(snapshot, () => {})).toEqual(await active);
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a discovered skill whose root becomes a broken symlink between turns",
    async () => {
      const workspace = await fs.realpath(temps.make("skill-stale-root-"));
      const healthyDir = await writeSkill(workspace, "healthy");
      const staleDir = await writeSkill(workspace, "stale");
      const snapshot = await loadSnapshot(workspace);
      expect((await prepareSkillResourceDelivery(snapshot, () => {}))?.skills).toHaveLength(2);

      await fs.rm(staleDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleDir, "dir");

      await expect(prepareSkillResourceDelivery(snapshot, () => {})).resolves.toMatchObject({
        skills: [{ name: "healthy" }],
      });
      await fs.rm(healthyDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-healthy-target"), healthyDir, "dir");
      await expect(prepareSkillResourceDelivery(snapshot, () => {})).resolves.toEqual({
        version: 1,
        skills: [],
      });
      await expect(
        prepareSkillResourceDelivery(snapshot, () => {}, [
          { name: "stale", path: path.join(staleDir, "SKILL.md") },
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringMatching(/skill="stale".*root=.*stale.*ENOENT/s),
      });
    },
  );

  it("names an unavailable explicit skill and root", async () => {
    const workspace = await fs.realpath(temps.make("skill-missing-explicit-"));
    await writeSkill(workspace, "visible");
    const missingPath = path.join(workspace, "skills", "missing", "SKILL.md");

    await expect(
      prepareSkillResourceDelivery(await loadSnapshot(workspace), () => {}, [
        { name: "missing", path: missingPath },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringMatching(/skill="missing".*root=.*missing.*ENOENT/s),
    });
  });

  it("materializes directory-name skills and contained aliases with exact bytes and permissions", async () => {
    const workspace = await fs.realpath(temps.make("skill-nested-link-"));
    const directory = await writeSkill(workspace, "directory-name");
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
    const snapshot = await loadSnapshot(workspace);
    expect(snapshot.resolvedSkills).toMatchObject([
      { name: "directory-name", description: "Workspace procedure" },
    ]);
    const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(delivery?.skills).toMatchObject([{ name: "directory-name" }]);
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      const skill = materialized.snapshot.resolvedSkills![0]!;
      expect(skill.name).toBe("directory-name");
      expect(skill.description).toBe("Workspace procedure");
      expect(await fs.readFile(skill.filePath, "utf8")).toBe(markdown);
      if (process.platform !== "win32") {
        expect((await fs.stat(materialized.directory)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(skill.filePath)).mode & 0o777).toBe(0o400);
      }
      for (const name of instructionFiles) {
        expect(await fs.readFile(path.join(skill.baseDir, name), "utf8")).toBe(instructions);
        expect((await fs.lstat(path.join(skill.baseDir, name))).isFile()).toBe(true);
      }
      for (const name of scriptFiles) {
        const target = path.join(skill.baseDir, name);
        expect(await fs.readFile(target, "utf8")).toBe(script);
        expect((await fs.lstat(target)).isFile()).toBe(true);
        if (process.platform !== "win32") {
          expect((await fs.stat(target)).mode & 0o777).toBe(0o500);
        }
      }
    } finally {
      await materialized.cleanup();
    }
  });

  it
    .runIf(process.platform !== "win32")
    .each(["outside", "broken", "cycle", "directory", "hardlink", "excluded"] as const)(
    "rejects %s skill aliases with selected skill diagnostics",
    async (kind) => {
      const workspace = await fs.realpath(temps.make("skill-unsafe-link-"));
      const directory = await writeSkill(workspace, "linked");
      const alias = path.join(directory, "linked-support");
      if (kind === "hardlink") {
        const target = path.join(directory, "support.txt");
        await fs.writeFile(target, "hardlinked support");
        await fs.link(target, alias);
      } else {
        let target = "missing";
        if (kind === "outside") {
          target = path.join(workspace, "outside.txt");
          await fs.writeFile(target, "outside skill boundary");
        } else if (kind === "cycle") {
          target = "linked-support";
        } else if (kind === "directory") {
          target = "support";
          await fs.mkdir(path.join(directory, target));
        } else if (kind === "excluded") {
          target = ".git/config";
          await fs.mkdir(path.join(directory, ".git"));
          await fs.writeFile(path.join(directory, target), "excluded repository metadata");
        }
        await fs.symlink(target, alias);
      }
      await expect(
        prepareSkillResourceDelivery(await loadSnapshot(workspace), () => {}),
      ).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringMatching(/skill="linked".*root=.*linked/s),
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a file moved into an excluded tree while its alias is opening",
    async () => {
      const workspace = await fs.realpath(temps.make("skill-alias-race-"));
      const directory = await writeSkill(workspace, "linked");
      const target = path.join(directory, "support.txt");
      const excluded = path.join(directory, ".git", "support.txt");
      await fs.mkdir(path.dirname(excluded));
      await fs.writeFile(target, "supporting instructions");
      await fs.symlink("support.txt", path.join(directory, "alias.txt"));
      const snapshot = await loadSnapshot(workspace);
      const originalOpen = fs.open;
      let moved = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (file === target && !moved) {
          moved = true;
          await fs.rename(target, excluded);
          await fs.symlink(".git/support.txt", target);
        }
        return handle;
      });
      try {
        await expect(prepareSkillResourceDelivery(snapshot, () => {})).rejects.toMatchObject({
          code: "INVALID_BUNDLE",
          message: expect.stringContaining("link target is not an included regular file"),
        });
        expect(moved).toBe(true);
      } finally {
        open.mockRestore();
      }
    },
  );

  it("excludes Git and dependency trees before spending the traversal budget", async () => {
    const workspace = await fs.realpath(temps.make("skill-exclusions-"));
    const directory = await writeSkill(
      workspace,
      "guide",
      `---\nname: guide\ndescription: Test\n---\n# Guide\n`,
    );
    await fs.mkdir(path.join(directory, ".git"));
    await Promise.all(
      Array.from({ length: 513 }, (_, index) =>
        fs.writeFile(path.join(directory, ".git", String(index)), ""),
      ),
    );
    await fs.mkdir(path.join(directory, "node_modules", "dependency"), { recursive: true });
    await fs.writeFile(path.join(directory, "node_modules", "dependency", "index.js"), "excluded");
    const delivery = await prepareSkillResourceDelivery(await loadSnapshot(workspace), () => {});
    expect(delivery?.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("delivers only selected resources from a large discovery catalog and admits explicit hidden skills without changing the snapshot", async () => {
    const workspace = await fs.realpath(temps.make("skill-selected-"));
    await writeSkill(workspace, "visible");
    const hiddenDir = await writeSkill(
      workspace,
      "hidden",
      "---\nname: hidden\ndescription: Hidden procedure\ndisable-model-invocation: true\n---\n# Hidden\n",
    );
    const omittedDir = await writeSkill(
      workspace,
      "z-omitted",
      "---\nname: z-omitted\ndescription: Test\n---\n# Omitted\n",
    );
    const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
    const snapshot = await buildSkillSnapshot(workspace, {
      entries,
      config: { skills: { limits: { maxSkillsInPrompt: 1 } } },
    });
    expect(snapshot.prompt).toContain("<name>visible</name>");
    expect(snapshot.prompt).not.toContain("<name>z-omitted</name>");
    expect(snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["visible"]);
    const omitted = snapshot.discoverySkills!.find((skill) => skill.name === "z-omitted")!;
    snapshot.discoverySkills!.push(
      ...Array.from({ length: 300 }, (_, index) => ({ ...omitted, name: `extra-${index}` })),
    );
    await fs.rm(omittedDir, { recursive: true });
    const before = structuredClone(snapshot);
    const ordinary = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(ordinary?.skills.map((skill) => skill.name)).toEqual(["visible"]);
    const explicit = await prepareSkillResourceDelivery(snapshot, () => {}, [
      { name: "hidden", path: path.join(hiddenDir, "SKILL.md") },
    ]);
    expect(explicit?.skills.map((skill) => skill.name)).toEqual(["visible", "hidden"]);
    expect(explicit?.skills[1]?.modelVisible).toBe(true);
    expect(snapshot).toEqual(before);
    expect(await prepareSkillResourceDelivery(snapshot, () => {})).toEqual(ordinary);
    const worker = await materializeSkillResources(ordinary!, () => {});
    try {
      expect(worker.snapshot.discoverySkills?.map((skill) => skill.name)).toEqual(["visible"]);
      const delivered = worker.snapshot.discoverySkills![0]!;
      expect(delivered.filePath).not.toBe(snapshot.resolvedSkills![0]!.filePath);
      expect(await fs.readFile(delivered.filePath, "utf8")).toBe(markdown);
    } finally {
      await worker.cleanup();
    }
  });
});
