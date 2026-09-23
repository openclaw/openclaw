import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getRefsFileExtents } from "../../../test/helpers/refs.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { listTemplates } from "./template-registry.js";

const execFileAsync = promisify(execFile);
const refsRoot = process.env.OPENCLAW_TEST_REFS_ROOT;
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe.skipIf(process.platform !== "win32" || !refsRoot)(
  "managed ReFS worktrees (requires OPENCLAW_TEST_REFS_ROOT)",
  () => {
    const initializeRepository = useManagedWorktreeTestRepository();
    const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
      afterEach(() => {
        vi.unstubAllEnvs();
        closeOpenClawStateDatabaseForTest();
        cleanup();
      }),
    );

    it("uses the configured ReFS root through create, restore, invalidation and template cleanup", async () => {
      const root = tempDirs.make("openclaw-service-refs-source-");
      const worktreeRoot = tempDirs.make("openclaw-service-refs-worktrees-", refsRoot);
      const configPath = path.join(root, "gitconfig");
      await fs.writeFile(configPath, "");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
      vi.stubEnv("GIT_CONFIG_GLOBAL", configPath);
      const repo = await initializeRepository(root);
      const payload = Buffer.alloc(128 * 1024, 0x5a);
      await fs.writeFile(path.join(repo, "payload"), payload);
      await git(repo, "add", "payload");
      await git(repo, "commit", "-m", "ReFS source fixture");
      const originalHead = await git(repo, "rev-parse", "HEAD");
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
      let now = Date.now();
      const service = new ManagedWorktreeService({
        env,
        now: () => now,
        getConfig: () => ({ worktreeRoot }),
      });
      const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
      const template = listTemplates(env)[0];
      assert(template);
      expect(template.backend).toBe("refs");
      expect(path.relative(worktreeRoot, first.path).startsWith("..")).toBe(false);
      const second = await service.create({ repoRoot: repo, name: "second", baseRef: "HEAD" });
      expect(listTemplates(env).map((entry) => entry.id)).toEqual([template.id]);
      const templateExtents = getRefsFileExtents(path.join(template.path, "payload"));
      expect(templateExtents.some((extent) => extent.lcn >= 0n)).toBe(true);
      for (const record of [first, second]) {
        expect(await fs.readFile(path.join(record.path, "payload"))).toEqual(payload);
        expect(getRefsFileExtents(path.join(record.path, "payload"))).toEqual(templateExtents);
        expect(await git(record.path, "status", "--porcelain")).toBe("");
        expect(await git(record.path, "symbolic-ref", "--short", "HEAD")).toBe(record.branch);
      }
      await fs.writeFile(path.join(first.path, "README.md"), "saved edit\n");
      await fs.writeFile(path.join(first.path, "untracked.txt"), "saved new file\n");
      await service.remove({ id: first.id, reason: "native ReFS proof" });
      await expect(fs.access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
      const restored = await service.restore({ id: first.id });
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
      expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
        "saved new file\n",
      );
      expect(await fs.readFile(path.join(second.path, "README.md"), "utf8")).toBe("base\n");
      await fs.writeFile(path.join(repo, "README.md"), "new source\n");
      await git(repo, "add", "README.md");
      await git(repo, "commit", "-m", "invalidate ReFS template");
      const third = await service.create({ repoRoot: repo, name: "third", baseRef: "HEAD" });
      expect(await fs.readFile(path.join(third.path, "README.md"), "utf8")).toBe("new source\n");
      expect(listTemplates(env)[0]?.sourceCommit).toBe(await git(repo, "rev-parse", "HEAD"));
      await expect(fs.access(template.path)).rejects.toMatchObject({ code: "ENOENT" });
      now += IDLE_GC_MS + 1;
      expect((await service.gc()).removed).toEqual([]);
      expect(listTemplates(env)).toEqual([]);
      expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("saved edit\n");
      expect(await fs.readFile(path.join(second.path, "payload"))).toEqual(payload);
      expect(await git(second.path, "status", "--porcelain")).toBe("");
    });
  },
);
