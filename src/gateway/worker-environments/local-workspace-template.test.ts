import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { prepareSandboxDependencyTemplate } from "../../agents/sandbox/dependency-template.js";
import { withWorktreeAllocationLease } from "../../agents/worktrees/allocation.js";
import { createCopyWorktreeBackend } from "../../agents/worktrees/filesystem-backend.test-support.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { listTemplatesAsync } from "../../agents/worktrees/template-registry-async.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { prewarmLocalWorkspaceTemplates } from "./local-workspace-prewarm.js";
import { cloneLocalWorkspaceTemplate } from "./local-workspace-template.js";

const mocks = vi.hoisted(() => ({
  backend: vi.fn(),
  install: vi.fn<typeof prepareSandboxDependencyTemplate>(),
}));
// mock-isolation: A portable copy backend exercises template ownership without native mounts.
vi.mock("../../agents/worktrees/filesystem-backend.js", () => ({
  detectWorktreeFilesystemBackend: mocks.backend,
}));
// mock-isolation: The installer writes synthetic dependencies; no real container engine is used.
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
const dependencyFile = "node_modules/dependency/index.js";
let source: string;
let baseCommit: string;
let changedCommit: string;
let env: NodeJS.ProcessEnv;

async function expectMissing(root: string, ...relatives: string[]) {
  for (const relative of relatives) {
    await expect(fs.lstat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
  }
}

async function write(root: string, relative: string, value: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function writeModulesManifest(root: string, virtualStoreDir = ".pnpm") {
  const yaml = `virtualStoreDir: ${JSON.stringify(virtualStoreDir)}\n`;
  await write(root, "node_modules/.modules.yaml", yaml);
}

async function installFiles(directory: string, files: Record<string, string>) {
  await writeModulesManifest(directory);
  for (const [relative, contents] of Object.entries(files)) {
    await write(directory, relative, contents);
  }
  return { installed: true as const };
}

async function checkClones(signal: AbortSignal, check: (checkout: string) => Promise<void>) {
  const clone = await fixture(signal);
  for (const name of ["first", "second"]) {
    await check(await clone(name));
  }
  expect(mocks.install).toHaveBeenCalledOnce();
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
  await write(source, ".gitignore", "\n.env*\n.npmrc\nbuild/\n");
  await git(source, "commit", "--quiet", "-am", "dependency ignore variant");
  const remote = path.join(root, "origin.git");
  await git(root, "clone", "--quiet", "--bare", source, remote);
  await git(source, "remote", "add", "origin", remote);
  await write(source, ".env.local", "synthetic host-only credential\n");
  await write(source, ".npmrc", "synthetic host-only registry credential\n");
  await git(source, "config", "credential.helper", "!echo synthetic-host-credential");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backend.mockResolvedValue(createCopyWorktreeBackend());
  mocks.install.mockImplementation(async ({ directory }) => {
    await expectMissing(directory, ".env.local", ".npmrc");
    return installFiles(directory, { [dependencyFile]: await read(directory, "pnpm-lock.yaml") });
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
          requireDiskSpace: async () => {},
        },
      }),
    ).toBe(true);
    return destination;
  };
}

it("isolates dependency clones and rebuilds after lockfile changes", async ({ signal }) => {
  const clone = await fixture(signal);
  const first = await clone("first");
  expect(await read(first, dependencyFile)).toBe(firstLock);
  const template = (await listTemplatesAsync(env)).find(
    (record) => record.worktreeRoot === path.join(path.dirname(first), "templates"),
  );
  assert(template, "Template was not reserved");
  const indexPath = path.join(template.path, ".git", "index");
  const originalIndex = await fs.readFile(indexPath);
  // Warm validation must not refresh an index that another reader can be cloning.
  await fs.utimes(path.join(template.path, "source.ts"), 1, 1);
  await write(first, dependencyFile, "consumer edit\n");
  const second = await clone("second");
  expect((await fs.readFile(indexPath)).equals(originalIndex)).toBe(true);
  expect(await read(second, dependencyFile)).toBe(firstLock);
  expect(await read(first, dependencyFile)).toBe("consumer edit\n");
  expect(await git(second, "branch", "--show-current")).toBe("openclaw/second");
  expect(mocks.install).toHaveBeenCalledOnce();

  const third = await clone("changed-lock", changedCommit);
  expect(await read(third, dependencyFile)).toBe(secondLock);
  expect(await read(third, "pnpm-lock.yaml")).toBe(secondLock);
  expect(mocks.install).toHaveBeenCalledTimes(2);
  const templates = (await listTemplatesAsync(env)).filter(
    (record) => record.sourceCommit === changedCommit,
  );
  expect(templates).toMatchObject([{ status: "ready" }]);
});

it("retains dependencies without credentials or install debris", async ({ signal }) => {
  mocks.install.mockImplementation(async ({ directory }) => {
    await expectMissing(directory, ".env.local", ".npmrc");
    return installFiles(directory, {
      [dependencyFile]: "root dependency\n",
      [`packages/tool/${dependencyFile}`]: "workspace dependency\n",
      "build/output.js": "generated output\n",
      "untracked-output.txt": "generated output\n",
      ".env.installer": "synthetic installer output\n",
    });
  });
  await checkClones(signal, async (checkout) => {
    expect(await read(checkout, dependencyFile)).toBe("root dependency\n");
    expect(await read(checkout, `packages/tool/${dependencyFile}`)).toBe("workspace dependency\n");
    expect(await read(checkout, ".git/config")).not.toContain("credential");
    await expectMissing(
      checkout,
      ".env.local",
      ".npmrc",
      ".env.installer",
      "build",
      "untracked-output.txt",
    );
  });
});

it.for(["external virtual store", "install failure", "tracked source changed"])(
  "caches a clean source-only fallback after %s",
  async (failure, { signal }) => {
    mocks.install.mockImplementation(async ({ directory }) => {
      if (failure === "external virtual store") {
        await writeModulesManifest(directory, "../.pnpm");
        await write(directory, ".pnpm/dependency/index.js", "external virtual store\n");
        await fs.symlink(
          "../.pnpm/dependency",
          path.join(directory, "node_modules/dependency"),
          "dir",
        );
        return { installed: true };
      }
      await installFiles(directory, {
        [dependencyFile]: "partial installation\n",
        ".env.installer": "synthetic installer output\n",
        ...(failure === "tracked source changed" ? { "source.ts": "changed by install\n" } : {}),
      });
      return failure === "install failure"
        ? { installed: false, reason: "synthetic install failure" }
        : { installed: true };
    });
    await checkClones(signal, async (checkout) => {
      expect(await read(checkout, "source.ts")).toBe(sourceText);
      expect(await read(checkout, "pnpm-lock.yaml")).toBe(firstLock);
      await expectMissing(
        checkout,
        "node_modules",
        ".pnpm",
        ".env.installer",
        ".env.local",
        ".npmrc",
      );
    });
  },
);

function prewarmFixture() {
  const state = directories.make("openclaw-dependency-prewarm-");
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  const config: OpenClawConfig = {
    agents: {
      defaults: { sandbox: { mode: "non-main" } },
      entries: { main: { workspace: source } },
    },
  };
  const prepare = (signal: AbortSignal) =>
    prewarmLocalWorkspaceTemplates({ getConfig: () => config, signal });
  return { state, config, env: { ...process.env }, prepare };
}

function holdInstall() {
  const started = createDeferred<AbortSignal>();
  const release = createDeferred();
  const install = mocks.install.getMockImplementation()!;
  mocks.install.mockImplementationOnce(async (params) => {
    if (!params.signal) {
      throw new Error("Background install needs cancellation");
    }
    started.resolve(params.signal);
    await release.promise;
    params.signal.throwIfAborted();
    return await install(params);
  });
  const waitForStart = (preparation: Promise<void>) =>
    awaitGateBeforeSettlement(started.promise, preparation, "Background install did not start");
  return { waitForStart, release };
}

it.each(["default", "agent-override"] as const)(
  "does not prepare dependency templates when sandboxing is off (%s)",
  async (mode) => {
    const warmed = prewarmFixture();
    warmed.config.agents = {
      ...(mode === "agent-override" ? { defaults: { sandbox: { mode: "all" } } } : {}),
      entries: {
        main: {
          workspace: source,
          ...(mode === "agent-override" ? { sandbox: { mode: "off" } } : {}),
        },
      },
    };
    await warmed.prepare(new AbortController().signal);
    await expectMissing(warmed.state, "worktree-projections");
    expect(mocks.install).not.toHaveBeenCalled();
  },
);

it("joins background preparation through the allocation owner", async ({ signal }) => {
  const warmed = prewarmFixture();
  const { waitForStart, release } = holdInstall();
  const preparation = warmed.prepare(signal);
  try {
    await waitForStart(preparation);
    const templateRoot = path.join(warmed.state, "worktree-projections");
    const destination = path.join(templateRoot, "first-session");
    const selectedCommit = await git(source, "rev-parse", "HEAD");
    const cloning = withWorktreeAllocationLease({ env: warmed.env, signal }, (guard) =>
      cloneLocalWorkspaceTemplate({
        source,
        repoRoot: source,
        baseCommit: selectedCommit,
        branch: "openclaw/first-session",
        destination,
        temporaryRoot: templateRoot,
        templateRoot,
        env: warmed.env,
        sandbox,
        guard: { ...guard, signal: guard.signal ?? signal },
      }),
    );
    release.resolve();
    await expect(cloning).resolves.toBe(true);
    await preparation;
    expect(await read(destination, dependencyFile)).toBe(secondLock);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(await listTemplatesAsync(warmed.env)).toMatchObject([
      { status: "ready", sourceCommit: selectedCommit },
    ]);
  } finally {
    release.resolve();
    await preparation;
  }
});

it.each(["shutdown", "config"])(
  "settles an interrupted background install before releasing allocation (%s)",
  async (reason) => {
    const warmed = prewarmFixture();
    const controller = new AbortController();
    const { waitForStart, release } = holdInstall();
    let settled = false;
    const preparation = warmed.prepare(controller.signal).then(() => {
      settled = true;
    });
    try {
      const signal = await waitForStart(preparation);
      if (reason === "shutdown") {
        controller.abort();
      } else {
        sessionChanges.emit({ all: true, scope: "config" });
      }
      expect(signal.aborted).toBe(true);
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      await preparation;
      expect(await listTemplatesAsync(warmed.env)).toMatchObject([{ status: "preparing" }]);
    } finally {
      controller.abort();
      release.resolve();
      await preparation;
    }
  },
);
