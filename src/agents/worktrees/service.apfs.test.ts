import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { getApfsCloneId } from "../../../test/helpers/apfs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import {
  ageManagedWorktreeTemplates,
  git,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { listTemplatesAsync } from "./template-registry-async.js";

const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");

const execFileAsync = promisify(execFile);

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
    afterEach(async () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );

  let root: string, repo: string, env: NodeJS.ProcessEnv, service: ManagedWorktreeService;
  beforeEach(async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    root = tempDirs.make("openclaw-service-apfs-");
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env, getConfig: () => ({}) });
  });
  const create = (name: string) => service.create({ repoRoot: repo, name, baseRef: "HEAD" });

  it.each(["directory_inherit", "file_inherit,directory_inherit"])(
    "preserves %s ACLs like native Git checkout",
    async (inheritance) => {
      await fs.mkdir(path.join(repo, "nested"));
      await fs.writeFile(path.join(repo, "nested", "payload"), "tracked source\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "nested fixture");
      const worktreeRoot = path.join(root, "worktrees");
      await fs.mkdir(worktreeRoot);

      let worktreeAcceleration = false;
      service = new ManagedWorktreeService({
        env,
        getConfig: () => ({ worktreeRoot, worktreeAcceleration }),
      });
      const seed = await create("seed");
      await execFileAsync("/bin/chmod", [
        "+a",
        `everyone allow read,${inheritance}`,
        path.dirname(seed.path),
      ]);
      const control = await create("control");
      worktreeAcceleration = true;
      const created = await create("inherited");
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
      expect(await listTemplatesAsync(env)).toEqual([]);
    },
  );

  it("reevaluates destination ACLs before reusing a clean template", async () => {
    const first = await create("first");
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    const parent = path.dirname(first.path);
    await execFileAsync("/bin/chmod", [
      "+a",
      "everyone allow read,file_inherit,directory_inherit",
      parent,
    ]);
    const second = await create("second");
    expect(await readAcl(path.join(second.path, "README.md"))).toEqual([
      "0: group:everyone inherited allow read",
    ]);
    expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
    await execFileAsync("/bin/chmod", ["-N", parent]);
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", parent]);
    const third = await create("third");
    expect(await readAcl(path.join(third.path, "README.md"))).toEqual([]);
    expect(await getApfsCloneId(path.join(third.path, "README.md"))).toBe(
      await getApfsCloneId(path.join(template.path, "README.md")),
    );
  });

  it("does not transplant ACLs from a cached template root", async () => {
    await create("first");
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", template.path]);
    const created = await create("clean-root");
    expect(await readAcl(created.path)).toEqual([]);
    expect(await read(created.path, "README.md")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
  });

  it.each(["parent", "template"])(
    "uses Git if %s ACLs change during native cloning",
    async (changed) => {
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

      const created = await create("changed-policy");
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
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    vi.spyOn(apfsFilesystem, "readDirectoryAcl").mockResolvedValue(undefined);

    const created = await create("unavailable");
    expect(await read(created.path, "README.md")).toBe("base\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    expect(await listTemplatesAsync(env)).toEqual([]);
  });

  it("clones through creation, independent provisioning, restore, invalidation and cleanup", async () => {
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

    const first = await create("first");
    const template = (await listTemplatesAsync(env))[0];
    assert(template);
    expect(template.backend).toBe("apfs");
    await fs.writeFile(path.join(repo, ".env.local"), "second");
    const second = await create("second");
    expect((await listTemplatesAsync(env)).map((entry) => entry.id)).toEqual([template.id]);
    for (const record of [first, second]) {
      expect(await getApfsCloneId(path.join(record.path, "payload"))).toBe(
        await getApfsCloneId(path.join(template.path, "payload")),
      );
      expect(await git(record.path, "status", "--porcelain")).toBe("");
      expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
      expect((await fs.stat(path.join(record.path, "executable"))).mode & 0o777).toBe(0o755);
      expect(await fs.readlink(path.join(record.path, "link"))).toBe("payload");
      expect(await read(record.path, "setup.txt")).toBe(record.path);
    }
    expect(await read(first.path, ".env.local")).toBe("first");
    expect(await read(second.path, ".env.local")).toBe("second");
    await expect(fs.access(path.join(template.path, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.writeFile(path.join(first.path, "README.md"), "saved edit\n");
    await fs.writeFile(path.join(first.path, "untracked.txt"), "saved new file\n");
    expect(await read(second.path, "README.md")).toBe("base\n");
    await service.remove({ id: first.id, reason: "native APFS proof" });
    const restored = await service.restore({ id: first.id });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await read(restored.path, "README.md")).toBe("saved edit\n");
    expect(await read(restored.path, "untracked.txt")).toBe("saved new file\n");
    await fs.writeFile(path.join(repo, "README.md"), "new source\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "invalidate template");
    const third = await create("third");
    expect(await read(third.path, "README.md")).toBe("new source\n");
    expect((await listTemplatesAsync(env))[0]?.sourceCommit).toBe(
      await git(repo, "rev-parse", "HEAD"),
    );
    await ageManagedWorktreeTemplates(env, Date.now() - IDLE_GC_MS - 1);
    expect((await service.gc()).removed).toEqual([]);
    expect(await listTemplatesAsync(env)).toEqual([]);
    expect(await read(restored.path, "README.md")).toBe("saved edit\n");
    expect(await git(second.path, "status", "--porcelain")).toBe("");
  });
});
