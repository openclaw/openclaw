import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { addManagedWorktree } from "./checkout.js";
import { requireGit } from "./git.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const initialize = useManagedWorktreeTestRepository();
const roots = useAutoCleanupTempDirTracker(afterEach);
const promptFiles = [
  "AGENTS.md",
  ".agents/skills/example/SKILL.md",
  ".codex/skills/local/SKILL.md",
];
let root: string;
let repo: string;
let destination: string;
let commit: string;

async function write(relative: string, content: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function snapshot() {
  return await Promise.all(
    promptFiles.map(async (relative) => {
      const target = path.join(destination, relative);
      const stat = await fs.stat(target);
      return { relative, bytes: await fs.readFile(target), ino: stat.ino, mtimeMs: stat.mtimeMs };
    }),
  );
}

async function create(onPromptReady: (commit: string) => Promise<void>) {
  return await addManagedWorktree({
    env: process.env,
    now: Date.now,
    enabled: false,
    repoRoot: repo,
    commonDir: path.join(repo, ".git"),
    worktreeRoot: root,
    destination,
    base: commit,
    branch: "prompt",
    requireSpace: async () => {},
    commitGuard: () => {},
    onPromptReady,
  });
}

beforeEach(async () => {
  root = roots.make("worktree-prompt-");
  repo = await initialize(root);
  destination = path.join(root, "checkout");
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  for (const relative of promptFiles) {
    await write(relative, `committed ${relative}\n`);
  }
  await write("src/main.ts", "remaining checkout\n");
  await requireGit(repo, ["add", "."]);
  await requireGit(repo, ["commit", "-qm", "prompt inputs"]);
  commit = await requireGit(repo, ["rev-parse", "HEAD"]);
});

afterEach(() => vi.unstubAllEnvs());

it.each(["lf", "crlf"])(
  "preserves %s prompt bytes and stat data across complete materialization",
  async (eol) => {
    await write(".gitattributes", `* text=auto eol=${eol}\n`);
    await requireGit(repo, ["config", "filter.unused.smudge", "unused-filter-must-not-run"]);
    await write(".agents/.gitattributes", "* text eol=lf\n");
    await requireGit(repo, ["add", "."]);
    await requireGit(repo, ["commit", "-qm", "prompt line endings"]);
    commit = await requireGit(repo, ["rev-parse", "HEAD"]);
    await write("AGENTS.md", "uncommitted instructions must not reach the model\n");
    let early: Awaited<ReturnType<typeof snapshot>> | undefined;
    const result = await create(async (preparedCommit) => {
      expect(preparedCommit).toBe(commit);
      expect(await requireGit(destination, ["symbolic-ref", "--short", "HEAD"])).toBe("prompt");
      await expect(fs.access(path.join(destination, "src/main.ts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      early = await snapshot();
      expect(early.map((file) => file.bytes.toString())).toEqual(
        promptFiles.map(
          (relative) =>
            `committed ${relative}${eol === "crlf" && !relative.startsWith(".agents/") ? "\r\n" : "\n"}`,
        ),
      );
    });
    expect(result.code).toBe(0);
    expect(early).toBeDefined();
    expect(await snapshot()).toEqual(early);
    expect(await fs.readFile(path.join(destination, "src/main.ts"), "utf8")).toBe(
      `remaining checkout${eol === "crlf" ? "\r\n" : "\n"}`,
    );
    expect(await requireGit(destination, ["status", "--porcelain"])).toBe("");
    expect(await fs.readFile(path.join(repo, "AGENTS.md"), "utf8")).toBe(
      "uncommitted instructions must not reach the model\n",
    );
  },
);

it.each([".gitattributes", ".codex/config.toml"])(
  "retains ordinary materialization when %s can change prompt inputs",
  async (relative) => {
    await write(
      relative,
      relative === ".gitattributes" ? "AGENTS.md filter=custom\n" : "model = 'fixture'\n",
    );
    await requireGit(repo, ["add", "."]);
    await requireGit(repo, ["commit", "-qm", "checkout policy"]);
    commit = await requireGit(repo, ["rev-parse", "HEAD"]);
    const ready = vi.fn(async () => {});
    expect((await create(ready)).code).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    await expect(fs.access(path.join(destination, "src/main.ts"))).resolves.toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "retains ordinary checkout for linked prompt files",
  async () => {
    await fs.symlink("../AGENTS.md", path.join(repo, ".agents/linked.md"));
    await requireGit(repo, ["add", ".agents/linked.md"]);
    await requireGit(repo, ["commit", "-qm", "linked prompt input"]);
    commit = await requireGit(repo, ["rev-parse", "HEAD"]);
    const ready = vi.fn(async () => {});
    expect((await create(ready)).code).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    expect(await fs.readlink(path.join(destination, ".agents/linked.md"))).toBe("../AGENTS.md");
  },
);

it("removes its partial checkout when the prompt consumer rejects preparation", async () => {
  await expect(
    create(async () => {
      throw new Error("prompt consumer canceled");
    }),
  ).rejects.toThrow("prompt consumer canceled");
  await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await requireGit(repo, ["branch", "--list", "prompt"])).toBe("");
});
