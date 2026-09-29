import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

async function readAcl(file: string): Promise<string[]> {
  const { stdout } = await execFileAsync("/bin/ls", ["-lde", file]);
  return stdout
    .split("\n")
    .filter((line) => /^\s+\d+:/u.test(line))
    .map((line) => line.trim());
}

describe.skipIf(process.platform !== "darwin")("managed worktrees on native APFS", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  it.each(["directory_inherit", "file_inherit,directory_inherit"])(
    "preserves %s ACLs like native Git checkout",
    async (inheritance) => {
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      const root = tempDirs.make("openclaw-service-apfs-acl-");
      const repo = await initializeRepository(root);
      await fs.mkdir(path.join(repo, "nested"));
      await fs.writeFile(path.join(repo, "nested", "payload"), "tracked source\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "nested fixture");
      const worktreeRoot = path.join(root, "worktrees");
      await fs.mkdir(worktreeRoot);
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
      let worktreeAcceleration = false;
      const service = new ManagedWorktreeService({
        env,
        getConfig: () => ({ worktreeRoot, worktreeAcceleration }),
      });
      const seed = await service.create({ repoRoot: repo, name: "seed", baseRef: "HEAD" });
      await execFileAsync("/bin/chmod", [
        "+a",
        `everyone allow read,${inheritance}`,
        path.dirname(seed.path),
      ]);
      const control = await service.create({ repoRoot: repo, name: "control", baseRef: "HEAD" });
      worktreeAcceleration = true;
      const created = await service.create({ repoRoot: repo, name: "inherited", baseRef: "HEAD" });
      const relativePaths = ["", "README.md", "nested", "nested/payload"];
      const expected = await Promise.all(
        relativePaths.map((relative) => readAcl(path.join(control.path, relative))),
      );
      expect(expected.some((acl) => acl.length > 0)).toBe(true);
      expect(
        await Promise.all(
          relativePaths.map((relative) => readAcl(path.join(created.path, relative))),
        ),
      ).toEqual(expected);
      expect(await git(created.path, "status", "--porcelain")).toBe("");
      expect(listTemplates(env)).toEqual([]);
    },
  );

  it("reevaluates destination ACLs before reusing a clean template", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-service-apfs-acl-reuse-");
    const repo = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    const parent = path.dirname(first.path);
    await execFileAsync("/bin/chmod", [
      "+a",
      "everyone allow read,file_inherit,directory_inherit",
      parent,
    ]);
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });
    expect(await readAcl(path.join(second.path, "README.md"))).toEqual([
      "0: group:everyone inherited allow read",
    ]);
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    await execFileAsync("/bin/chmod", ["-N", parent]);
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", parent]);
    const third = await service.create({ repoRoot: repo, name: "third", baseRef: "HEAD" });
    expect(await readAcl(path.join(third.path, "README.md"))).toEqual([]);
    expect(getApfsCloneId(path.join(third.path, "README.md"))).toBe(
      getApfsCloneId(path.join(template.path, "README.md")),
    );
  });

  it("does not transplant ACLs from a cached template root", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-service-apfs-stale-acl-");
    const repo = await initializeRepository(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
    await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", template.path]);
    const created = await service.create({ repoRoot: repo, name: "clean-root", baseRef: "HEAD" });
    expect(await readAcl(created.path)).toEqual([]);
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it.each(["parent", "template"])(
    "uses Git if %s ACLs change during native cloning",
    async (changed) => {
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      const root = tempDirs.make("openclaw-service-apfs-acl-race-");
      const repo = await initializeRepository(root);
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
      const copy = nativeWorktreeFilesystem.copy;
      vi.spyOn(nativeWorktreeFilesystem, "copy").mockImplementationOnce(
        async (source, destination, options) => {
          await execFileAsync("/bin/chmod", [
            "+a",
            changed === "parent"
              ? "everyone allow read,file_inherit,directory_inherit"
              : "everyone allow read",
            changed === "parent" ? path.dirname(destination) : source,
          ]);
          await copy(source, destination, options);
        },
      );
      const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
      const created = await service.create({
        repoRoot: repo,
        name: "changed-policy",
        baseRef: "HEAD",
      });
      expect(await readAcl(path.join(created.path, "README.md"))).toEqual(
        changed === "parent" ? ["0: group:everyone inherited allow read"] : [],
      );
      if (changed === "template") {
        expect(await readAcl(created.path)).toEqual([]);
      }
      expect(await git(created.path, "status", "--porcelain")).toBe("");
    },
  );

  it("uses Git when ACL inspection is unavailable", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-service-apfs-acl-unavailable-");
    const repo = await initializeRepository(root);
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    vi.spyOn(apfsFilesystem, "readDirectoryAcl").mockReturnValue(undefined);
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
    const created = await service.create({ repoRoot: repo, name: "unavailable", baseRef: "HEAD" });
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(listTemplates(env)).toEqual([]);
  });

  it("clones through creation, independent provisioning, restore, invalidation and cleanup", async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const root = tempDirs.make("openclaw-service-apfs-");
    const repo = await initializeRepository(root);
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nsetup.txt\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await fs.writeFile(path.join(repo, "payload"), Buffer.alloc(128 * 1024, 0x5a));
    await fs.writeFile(path.join(repo, "executable"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink("payload", path.join(repo, "link"));
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "source fixture");
    const originalHead = await git(repo, "rev-parse", "HEAD");
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      '#!/bin/sh\nprintf "%s" "$OPENCLAW_WORKTREE_PATH" > setup.txt\n',
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(repo, ".env.local"), "first");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    let now = Date.now();
    const service = new ManagedWorktreeService({ env, now: () => now, getConfig: () => ({}) });
    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const template = listTemplates(env)[0];
    assert(template);
    expect(template.backend).toBe("apfs");
    await fs.writeFile(path.join(repo, ".env.local"), "second");
    const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });
    expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
    for (const record of [first, second]) {
      expect(getApfsCloneId(path.join(record.path, "payload"))).toBe(
        getApfsCloneId(path.join(template.path, "payload")),
      );
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
      expect((await fs.stat(path.join(record.path, "executable"))).mode & 0o777).toBe(0o755);
      expect(await fs.readlink(path.join(record.path, "link"))).toBe("payload");
      expect(await fs.readFile(path.join(record.path, "setup.txt"), "utf8")).toBe(record.path);
    }
    expect(await fs.readFile(path.join(first.path, ".env.local"), "utf8")).toBe("first");
    expect(await fs.readFile(path.join(second.path, ".env.local"), "utf8")).toBe("second");
    await expect(fs.access(path.join(template.path, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.writeFile(path.join(first.path, "README.md"), "saved edit\n");
    await fs.writeFile(path.join(first.path, "untracked.txt"), "saved new file\n");
    expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
    await service.remove({ id: first.id, reason: "native APFS proof" });
    const restored = await service.restore({ id: first.id });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "saved new file\n",
    );
    await fs.writeFile(path.join(repo, "README.md"), "new source\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "invalidate template");
    const third = await service.create({ repoRoot: repo, name: "third", baseRef: "HEAD" });
    expect(await fs.readFile(path.join(third.path, "README.md"), "utf8")).toBe("new source\n");
    expect(listTemplates(env)[0]?.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
    now += IDLE_GC_MS + 1;
    expect((await service.gc()).removed).toEqual([]);
    expect(listTemplates(env)).toEqual([]);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
  });
});
