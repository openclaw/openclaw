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
  "users/Profile_123/USER.md",
];
let root: string;
let repo: string;
let destination: string;
let commit: string;

const git = (...args: string[]) => requireGit(repo, args);
const read = (base: string, relative: string) => fs.readFile(path.join(base, relative), "utf8");
const expectPendingCheckout = () =>
  expect(fs.access(path.join(destination, "src/main.ts"))).rejects.toMatchObject({
    code: "ENOENT",
  });

async function save(message: string) {
  await git("add", ".");
  await git("commit", "-qm", message);
  commit = await git("rev-parse", "HEAD");
}

async function write(relative: string, content: string) {
  const target = path.join(repo, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

const snapshot = () =>
  Promise.all(
    promptFiles.map(async (relative) => {
      const target = path.join(destination, relative);
      const stat = await fs.stat(target);
      return { relative, bytes: await fs.readFile(target), ino: stat.ino, mtimeMs: stat.mtimeMs };
    }),
  );

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
  await save("prompt inputs");
});

afterEach(() => vi.unstubAllEnvs());

it.each(["lf", "crlf"])("preserves %s prompt bytes and stat data after checkout", async (eol) => {
  await write(".gitattributes", `* text=auto eol=${eol}\n`);
  await git("config", "filter.unused.smudge", "unused-filter-must-not-run");
  await write(".agents/.gitattributes", "* text eol=lf\n");
  await write("users/.gitattributes", "* text eol=crlf\n");
  await write("users/Profile_123/.gitattributes", "USER.md text eol=lf\n");
  await save("prompt line endings");
  const dirty = {
    "AGENTS.md": "uncommitted instructions must not reach the model\n",
    "users/Profile_123/USER.md": "uncommitted personal instructions\n",
  };
  for (const [relative, content] of Object.entries(dirty)) {
    await write(relative, content);
  }
  let early: Awaited<ReturnType<typeof snapshot>> | undefined;
  const result = await create(async (preparedCommit) => {
    expect(preparedCommit).toBe(commit);
    expect(await requireGit(destination, ["symbolic-ref", "--short", "HEAD"])).toBe("prompt");
    await expectPendingCheckout();
    early = await snapshot();
    expect(early.map((file) => file.bytes.toString())).toEqual(
      promptFiles.map(
        (relative) =>
          `committed ${relative}${eol === "crlf" && !relative.startsWith(".agents/") && !relative.startsWith("users/") ? "\r\n" : "\n"}`,
      ),
    );
  });
  expect(result.code).toBe(0);
  expect(await snapshot()).toEqual(early);
  expect(await read(destination, "src/main.ts")).toBe(
    `remaining checkout${eol === "crlf" ? "\r\n" : "\n"}`,
  );
  expect(await requireGit(destination, ["status", "--porcelain"])).toBe("");
  for (const [relative, content] of Object.entries(dirty)) {
    expect(await read(repo, relative)).toBe(content);
  }
});

it.each([".gitattributes", ".codex/config.toml", ".CODEX/config.toml"])(
  "falls back for prompt-changing %s",
  async (relative) => {
    await write(
      relative,
      relative === ".gitattributes" ? "AGENTS.md filter=custom\n" : "model = 'fixture'\n",
    );
    await save("checkout policy");
    const ready = vi.fn(async () => {});
    expect((await create(ready)).code).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    await fs.access(path.join(destination, "src/main.ts"));
  },
);

it.skipIf(process.platform === "win32")(
  "selects raw/mixed-case prompts, not unrelated attributes",
  async () => {
    const inputs = [
      "Skills/nested/example/SKILL.md",
      ".agents/skills/tab\tname/SKILL.md",
      "prompt\ninput.md",
      "users/Extra_Profile/USER.md",
    ];
    for (const relative of inputs) {
      await write(relative, `prompt ${relative}\n`);
    }
    await write("src/.GITATTRIBUTES", "*.ts text eol=lf\n");
    await save("selected prompt paths");
    const ready = vi.fn(async () => {
      for (const relative of inputs) {
        expect(await read(destination, relative)).toBe(`prompt ${relative}\n`);
      }
      await expectPendingCheckout();
    });
    expect((await create(ready)).code).toBe(0);
    expect(ready).toHaveBeenCalledOnce();
    expect(await requireGit(destination, ["status", "--porcelain"])).toBe("");
  },
);

it.skipIf(process.platform === "win32").each([
  { file: ".agents/linked.md", target: "../AGENTS.md" },
  { file: "users/Profile_123/USER.md", target: "../../AGENTS.md" },
])("retains ordinary checkout for linked prompt file $file", async ({ file, target }) => {
  await fs.rm(path.join(repo, file), { force: true });
  await fs.symlink(target, path.join(repo, file));
  await save("linked prompt input");
  const ready = vi.fn(async () => {});
  expect((await create(ready)).code).toBe(0);
  expect(ready).not.toHaveBeenCalled();
  expect(await fs.readlink(path.join(destination, file))).toBe(target);
});

it("removes its partial checkout when the prompt consumer rejects preparation", async () => {
  await expect(
    create(async () => {
      throw new Error("prompt consumer canceled");
    }),
  ).rejects.toThrow("prompt consumer canceled");
  await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git("branch", "--list", "prompt")).toBe("");
});
