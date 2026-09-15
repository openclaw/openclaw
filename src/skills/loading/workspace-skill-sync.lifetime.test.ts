import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCliCleanup } from "../../agents/cli-runner/cleanup.js";
import { createAgentCleanupScope } from "../../agents/run-cleanup-timeout.js";
import {
  attachPublishedSandboxSkills,
  releasePublishedSandboxSkills,
  retainPublishedSandboxSkillsUntil,
} from "../../agents/sandbox/published-skills-handoff.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import {
  acquireWorkspaceSkills,
  type PublishedWorkspaceSkills,
} from "./workspace-skill-sync.runtime.js";

async function fixture(
  run: (f: {
    source: string;
    target: string;
    write: (version: string) => Promise<void>;
    acquire: (
      options?: Partial<Parameters<typeof acquireWorkspaceSkills>[0]>,
    ) => Promise<PublishedWorkspaceSkills>;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-lifetime-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const skill = path.join(source, "skills", "demo");
  const owned: PublishedWorkspaceSkills[] = [];
  await fs.mkdir(skill, { recursive: true });
  try {
    await run({
      source,
      target,
      write: async (version) => {
        await fs.writeFile(
          path.join(skill, "SKILL.md"),
          `---\nname: demo\ndescription: ${version}\n---\n${version}\n`,
        );
        await fs.writeFile(path.join(skill, "companion.txt"), version);
        bumpSkillsSnapshotVersion({ workspaceDir: source });
      },
      acquire: async (options = {}) => {
        const result = await acquireWorkspaceSkills({
          ...options,
          sourceWorkspaceDir: source,
          targetWorkspaceDir: target,
          bundledSkillsDir: path.join(root, "bundled"),
          managedSkillsDir: path.join(root, "managed"),
        });
        owned.push(result);
        return result;
      },
    });
  } finally {
    await Promise.all(owned.map((p) => p.release()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
function location(p: PublishedWorkspaceSkills) {
  return p.skillUsagePaths.find((x) => x.skillName === "demo")!.readPath;
}

it("retains complete A catalog and companions across B/C, reclaiming only released owners", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    const original = await fs.readFile(location(a), "utf8");
    await f.write("B");
    const b = await f.acquire();
    await f.write("C");
    const c = await f.acquire();
    expect(a.skillsSnapshot.prompt).toContain("A");
    expect(c.skillsSnapshot.prompt).toContain("C");
    expect(await fs.readFile(location(a), "utf8")).toBe(original);
    expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
      "A",
    );
    await b.release();
    await expect(fs.access(location(b))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(location(a), "utf8")).toBe(original);
    await a.release();
    await a.release();
    expect(await fs.readFile(path.join(path.dirname(location(c)), "companion.txt"), "utf8")).toBe(
      "C",
    );
  }));

it("does not publish partial copies or disturb A when B materialization fails", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    await f.write("B");
    const failure = new Error("copy refused");
    const copy = vi.spyOn(fs, "cp").mockRejectedValueOnce(failure);
    try {
      await expect(f.acquire()).rejects.toBe(failure);
    } finally {
      copy.mockRestore();
    }
    expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
      "A",
    );
    expect(await fs.readdir(path.join(f.target, "skills", ".openclaw-catalogs"))).toHaveLength(1);
  }));

it("keeps files for cleanup still executing after cancellation reporting", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    const owner = {};
    attachPublishedSandboxSkills(owner, {}, a);
    const pending = createDeferred();
    void retainPublishedSandboxSkillsUntil(owner, pending.promise);
    await releasePublishedSandboxSkills(owner);
    expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
      "A",
    );
    pending.resolve();
    await vi.waitFor(async () => {
      await expect(fs.access(location(a))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }));

it("leaves the previous complete catalog readable while a later copy is paused", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    const initial = await fs.readFile(location(a), "utf8");
    await f.write("B");
    const copying = createDeferred();
    const resume = createDeferred();
    const actualCopy = fs.cp;
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (...args) => {
      copying.resolve();
      await resume.promise;
      return actualCopy(...args);
    });
    const b = f.acquire();
    try {
      await copying.promise;
      expect(await fs.readFile(location(a), "utf8")).toBe(initial);
      expect(a.skillsSnapshot.prompt).toContain("A");
    } finally {
      resume.resolve();
      copy.mockRestore();
    }
    const publishedB = await b;
    expect(
      await fs.readFile(path.join(path.dirname(location(publishedB)), "companion.txt"), "utf8"),
    ).toBe("B");
    expect(await fs.readFile(location(a), "utf8")).toBe(initial);
  }));

it("preserves an explicitly empty catalog despite available workspace skills", async () =>
  fixture(async (f) => {
    await f.write("A");
    const empty = await f.acquire({ skillsSnapshot: { prompt: "", skills: [] } });
    expect(empty.skillsSnapshot.prompt).toBe("");
    expect(empty.skillsSnapshot.skills).toEqual([]);
    expect(empty.skillUsagePaths).toEqual([]);
  }));

it("applies the selected filter to both the published prompt and readable files", async () =>
  fixture(async (f) => {
    await f.write("A");
    const second = path.join(f.source, "skills", "other");
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(
      path.join(second, "SKILL.md"),
      "---\nname: other\ndescription: excluded\n---\nexcluded\n",
    );
    bumpSkillsSnapshotVersion({ workspaceDir: f.source });
    const selected = await f.acquire({ skillFilter: ["demo"] });
    expect(selected.skillsSnapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["demo"]);
    expect(selected.skillUsagePaths.map((skill) => skill.skillName)).toEqual(["demo"]);
    expect(selected.skillsSnapshot.prompt).not.toContain("excluded");
    expect(await fs.readdir(path.dirname(path.dirname(location(selected))))).not.toContain("other");
  }));

it("refuses a changed source version during copying without releasing a live catalog", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    await f.write("B");
    const actualCopy = fs.cp;
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (...args) => {
      await actualCopy(...args);
      bumpSkillsSnapshotVersion({ workspaceDir: f.source });
    });
    try {
      await expect(f.acquire()).rejects.toThrow("Skills changed while materializing");
    } finally {
      copy.mockRestore();
    }
    expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
      "A",
    );
    expect(await fs.readdir(path.join(f.target, "skills", ".openclaw-catalogs"))).toHaveLength(1);
  }));

it("records failed deletion without masking execution outcome and permits release retry", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    const owner = {};
    attachPublishedSandboxSkills(owner, {}, a);
    const scope = createAgentCleanupScope();
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("release refused"));
    try {
      await scope.run(() => releasePublishedSandboxSkills(owner));
    } finally {
      remove.mockRestore();
    }
    expect(scope.outcome).toBe("uncertain");
    expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
      "A",
    );
    await releasePublishedSandboxSkills(owner);
    await expect(fs.access(location(a))).rejects.toMatchObject({ code: "ENOENT" });
  }));

it("keeps the catalog through the real CLI one-shot cleanup timeout", async () =>
  fixture(async (f) => {
    await f.write("A");
    const a = await f.acquire();
    const owner = {};
    attachPublishedSandboxSkills(owner, {}, a);
    const pending = createDeferred();
    vi.useFakeTimers();
    try {
      const reported = runCliCleanup(
        {
          runId: "catalog-cleanup",
          sessionId: "catalog-cleanup",
          oneShotCliRun: true,
          skillsOwner: owner,
        },
        "catalog-test",
        () => pending.promise,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await reported;
      await releasePublishedSandboxSkills(owner);
      expect(await fs.readFile(path.join(path.dirname(location(a)), "companion.txt"), "utf8")).toBe(
        "A",
      );
    } finally {
      vi.useRealTimers();
      pending.resolve();
    }
    await vi.waitFor(async () => {
      await expect(fs.access(location(a))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }));

it("exports private source files without changing sources or following copied symlinks", async () =>
  fixture(async (f) => {
    await f.write("private");
    const skill = path.join(f.source, "skills", "demo");
    const sourceFile = path.join(skill, "SKILL.md");
    const executable = path.join(skill, "run.sh");
    const external = path.join(f.source, "not-published.txt");
    await fs.chmod(skill, 0o700);
    await fs.chmod(sourceFile, 0o600);
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    await fs.writeFile(external, "not an admitted skill", { mode: 0o600 });
    await fs.symlink(external, path.join(skill, "external-link"));
    const publication = await f.acquire();
    const publishedFile = location(publication);
    expect((await fs.stat(path.dirname(publishedFile))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(publishedFile)).mode & 0o777).toBe(0o444);
    expect((await fs.stat(path.join(path.dirname(publishedFile), "run.sh"))).mode & 0o777).toBe(
      0o555,
    );
    expect((await fs.stat(skill)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(sourceFile)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(external)).mode & 0o777).toBe(0o600);
  }));
