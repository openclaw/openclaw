import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { prepareSandboxDependencyTemplate } from "../../agents/sandbox/dependency-template.js";
import { createCopyWorktreeBackend } from "../../agents/worktrees/filesystem-backend.test-support.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { listTemplatesAsync } from "../../agents/worktrees/template-registry-async.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { cloneLocalWorkspaceTemplate } from "./local-workspace-template.js";

const mocks = vi.hoisted(() => ({
  backend: vi.fn(),
  install: vi.fn<typeof prepareSandboxDependencyTemplate>(),
}));
vi.mock("../../agents/worktrees/filesystem-backend.js", () => ({
  detectWorktreeFilesystemBackend: mocks.backend,
}));
vi.mock("../../agents/worktrees/capacity.js", () => ({
  requireWorktreeDiskSpace: vi.fn(),
  WORKTREE_SETUP_HEADROOM_BYTES: 4 * 1024 ** 3,
}));
vi.mock("../../agents/sandbox/dependency-template.js", () => ({
  resolveSandboxDependencyTemplateIdentity: async () => ({
    key: "pinned-guest-image",
    docker: { workdir: "/workspace" },
  }),
  prepareSandboxDependencyTemplate: mocks.install,
  retireSandboxDependencyTemplate: async () => {},
}));

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
    vi.unstubAllEnvs();
  }),
);
const sandbox = resolveSandboxConfigForAgent();
const read = (root: string, relative: string) => fs.readFile(path.join(root, relative), "utf8");
const git = (root: string, ...args: string[]) => requireGit(root, args);
const sourceText = "export const version = 'original';\n";
const firstLock = "lockfileVersion: '9.0'\n# first generation\n";
const secondLock = "lockfileVersion: '9.0'\n# second generation\n";
let source: string;
let baseCommit: string;
let changedCommit: string;
const ignoreVariants = new Map<string, string>();
let env: NodeJS.ProcessEnv;

async function expectMissing(root: string, relative: string) {
  await expect(fs.lstat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
}

async function write(root: string, relative: string, value: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function writeModulesManifest(root: string, virtualStoreDir = ".pnpm") {
  await write(
    root,
    "node_modules/.modules.yaml",
    `virtualStoreDir: ${JSON.stringify(virtualStoreDir)}\n`,
  );
}

beforeAll(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_SYSTEM", os.devNull);
  const root = directories.make("openclaw-dependency-template-");
  source = path.join(root, "source");
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  await fs.mkdir(source);
  await git(source, "init", "--quiet", "--template=", "-b", "main");
  await git(source, "config", "user.name", "OpenClaw Test");
  await git(source, "config", "user.email", "test@example.invalid");
  await write(source, "source.ts", sourceText);
  await write(source, "pnpm-lock.yaml", firstLock);
  await write(source, "package.json", '{"name":"fixture","private":true}\n');
  await write(source, "packages/tool/package.json", '{"name":"fixture-tool"}\n');
  await write(source, ".gitignore", "node_modules/\n.env*\n.npmrc\nbuild/\n");
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "fixture");
  baseCommit = await git(source, "rev-parse", "HEAD");
  await write(source, "pnpm-lock.yaml", secondLock);
  await git(source, "commit", "--quiet", "-am", "lockfile update");
  changedCommit = await git(source, "rev-parse", "HEAD");
  for (const pattern of ["node_modules/*", ""]) {
    await write(source, ".gitignore", `${pattern}\n.env*\n.npmrc\nbuild/\n`);
    await git(source, "commit", "--quiet", "-am", "dependency ignore variant");
    ignoreVariants.set(pattern, await git(source, "rev-parse", "HEAD"));
  }
  await write(source, ".env.local", "synthetic host-only credential\n");
  await write(source, ".npmrc", "synthetic host-only registry credential\n");
  await git(source, "config", "credential.helper", "!echo synthetic-host-credential");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backend.mockResolvedValue(createCopyWorktreeBackend());
  mocks.install.mockImplementation(async ({ directory }) => {
    await expectMissing(directory, ".env.local");
    await expectMissing(directory, ".npmrc");
    await writeModulesManifest(directory);
    await write(
      directory,
      "node_modules/dependency/index.js",
      await read(directory, "pnpm-lock.yaml"),
    );
    return { installed: true };
  });
});

async function fixture(signal: AbortSignal) {
  const root = directories.make("openclaw-dependency-consumers-");
  const templateRoot = path.join(root, "templates");
  await fs.mkdir(templateRoot);
  return async (name: string, commit = baseCommit) => {
    const temporaryRoot = path.join(root, `${name}-temporary`);
    const destination = path.join(root, name);
    await fs.mkdir(temporaryRoot);
    expect(
      await cloneLocalWorkspaceTemplate({
        source,
        repoRoot: source,
        baseCommit: commit,
        branch: `openclaw/${name}`,
        destination,
        temporaryRoot,
        templateRoot,
        env,
        sandbox,
        guard: {
          signal,
          commitGuard: () => signal.throwIfAborted(),
          rollbackGuard: () => {},
        },
      }),
    ).toBe(true);
    return destination;
  };
}

it("shares one installed generation across independent checkouts and replaces it after a lockfile commit", async ({
  signal,
}) => {
  const clone = await fixture(signal);
  const first = await clone("first");
  expect(await read(first, "node_modules/dependency/index.js")).toBe(firstLock);
  await write(first, "node_modules/dependency/index.js", "consumer edit\n");
  const second = await clone("second");
  expect(await read(second, "node_modules/dependency/index.js")).toBe(firstLock);
  expect(await read(first, "node_modules/dependency/index.js")).toBe("consumer edit\n");
  expect(await git(second, "branch", "--show-current")).toBe("openclaw/second");
  expect(mocks.install).toHaveBeenCalledOnce();

  const third = await clone("changed-lock", changedCommit);
  expect(await read(third, "node_modules/dependency/index.js")).toBe(secondLock);
  expect(await read(third, "pnpm-lock.yaml")).toBe(secondLock);
  expect(mocks.install).toHaveBeenCalledTimes(2);
  const templates = (await listTemplatesAsync(env)).filter(
    (record) => record.sourceCommit === changedCommit,
  );
  expect(templates).toHaveLength(1);
  expect(templates[0]?.status).toBe("ready");
});

it("retains installed packages when Git reports ignored children or unignored modules", async ({
  signal,
}) => {
  for (const commit of ignoreVariants.values()) {
    const clone = await fixture(signal);
    for (const name of ["first", "second"]) {
      const checkout = await clone(name, commit);
      expect(await read(checkout, "node_modules/dependency/index.js")).toBe(secondLock);
    }
  }
  expect(mocks.install).toHaveBeenCalledTimes(2);
});

it("retains only installed node_modules and never copies source credentials", async ({
  signal,
}) => {
  mocks.install.mockImplementation(async ({ directory }) => {
    await expectMissing(directory, ".env.local");
    await expectMissing(directory, ".npmrc");
    await writeModulesManifest(directory);
    await write(directory, "node_modules/dependency/index.js", "root dependency\n");
    await write(
      directory,
      "packages/tool/node_modules/dependency/index.js",
      "workspace dependency\n",
    );
    await write(directory, "build/output.js", "generated output\n");
    await write(directory, "untracked-output.txt", "generated output\n");
    await write(directory, ".env.installer", "synthetic installer output\n");
    return { installed: true };
  });
  const clone = await fixture(signal);
  for (const name of ["first", "second"]) {
    const checkout = await clone(name);
    expect(await read(checkout, "node_modules/dependency/index.js")).toBe("root dependency\n");
    expect(await read(checkout, "packages/tool/node_modules/dependency/index.js")).toBe(
      "workspace dependency\n",
    );
    expect(await read(checkout, ".git/config")).not.toContain("credential");
    for (const relative of [
      ".env.local",
      ".npmrc",
      ".env.installer",
      "build",
      "untracked-output.txt",
    ]) {
      await expectMissing(checkout, relative);
    }
  }
  expect(mocks.install).toHaveBeenCalledOnce();
});

it("rebuilds a ready generation after its template directory was removed", async ({ signal }) => {
  const previous = new Set((await listTemplatesAsync(env)).map((row) => row.id));
  const clone = await fixture(signal);
  await clone("first");
  const created = (await listTemplatesAsync(env)).find((row) => !previous.has(row.id));
  if (!created) {
    throw new Error("Template was not reserved");
  }
  await fs.rm(created.path, { recursive: true });
  const second = await clone("second");
  expect(await read(second, "node_modules/dependency/index.js")).toBe(firstLock);
  expect((await listTemplatesAsync(env)).some((row) => row.id === created.id)).toBe(false);
  expect(mocks.install).toHaveBeenCalledTimes(2);
});

it("falls back instead of retaining links into a virtual store that would be trimmed", async ({
  signal,
}) => {
  mocks.install.mockImplementation(async ({ directory }) => {
    await writeModulesManifest(directory, "../.pnpm");
    await write(directory, ".pnpm/dependency/index.js", "external virtual store\n");
    await fs.symlink("../.pnpm/dependency", path.join(directory, "node_modules/dependency"), "dir");
    return { installed: true };
  });
  const clone = await fixture(signal);
  for (const name of ["first", "second"]) {
    const checkout = await clone(name);
    expect(await read(checkout, "source.ts")).toBe(sourceText);
    await expectMissing(checkout, "node_modules");
    await expectMissing(checkout, ".pnpm");
  }
  expect(mocks.install).toHaveBeenCalledOnce();
});

for (const failure of ["install failure", "tracked source changed", "frozen lockfile changed"]) {
  it(`caches a clean source-only fallback after ${failure}`, async ({ signal }) => {
    mocks.install.mockImplementation(async ({ directory }) => {
      await writeModulesManifest(directory);
      await write(directory, "node_modules/dependency/index.js", "partial installation\n");
      await write(directory, ".env.installer", "synthetic installer output\n");
      if (failure === "tracked source changed") {
        await write(directory, "source.ts", "changed by install\n");
      }
      if (failure === "frozen lockfile changed") {
        await write(directory, "pnpm-lock.yaml", secondLock);
      }
      return failure === "install failure"
        ? { installed: false, reason: "synthetic install failure" }
        : { installed: true };
    });
    const clone = await fixture(signal);
    for (const name of ["first", "second"]) {
      const checkout = await clone(name);
      expect(await read(checkout, "source.ts")).toBe(sourceText);
      expect(await read(checkout, "pnpm-lock.yaml")).toBe(firstLock);
      await expectMissing(checkout, "node_modules");
      await expectMissing(checkout, ".env.installer");
      await expectMissing(checkout, ".env.local");
      await expectMissing(checkout, ".npmrc");
    }
    expect(mocks.install).toHaveBeenCalledOnce();
  });
}
