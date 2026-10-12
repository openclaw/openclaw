// Workspace tests cover bootstrap seeding, attestation safety, bootstrap file
// filtering, and setup-completion state for agent workspaces.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import * as commandExec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { registerWorkspaceBootstrapTests } from "./workspace-bootstrap.test-utils.js";
import { LEGACY_WORKSPACE_ATTESTATION_HEADER } from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { registerWorkspacePreparationTests } from "./workspace-preparation.test-utils.js";
import * as workspaceState from "./workspace-state-store.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
  loadWorkspaceBootstrapFiles,
  resolveWorkspaceBootstrapStatus,
  resolveDefaultAgentWorkspaceDir,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

const LEGACY_HEARTBEAT_FILENAME = "HEARTBEAT.md";
let testState: OpenClawTestState | undefined;
let tempDir: string;

beforeEach(async () => {
  resetLegacyWorkspaceStateCheckForTest();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-state-",
  });
  await fs.mkdir(testState.workspaceDir, { recursive: true });
  tempDir = await fs.realpath(testState.workspaceDir);
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  resetLegacyWorkspaceStateCheckForTest();
  await testState?.cleanup();
  testState = undefined;
});

function getWorkspaceTestFixture() {
  if (!testState) {
    throw new Error("Workspace test state is not initialized");
  }
  return { state: testState, tempDir };
}

function workspacePath(...parts: string[]) {
  return path.join(tempDir, ...parts);
}
async function writeWorkspaceFile(name: string, content: string) {
  await fs.writeFile(workspacePath(name), content);
}

function ensureWorkspace(ensureBootstrapFiles = true) {
  return ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles });
}

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("roots the unprofiled default workspace under OPENCLAW_HOME", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    });

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "workspace"));
  });

  it("roots named profile workspaces inside the profile state directory", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    });

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw-work", "workspace"));
  });

  it("rejects invalid environment-only profile names", () => {
    expect(() =>
      resolveDefaultAgentWorkspaceDir({
        OPENCLAW_PROFILE: "../escape",
        HOME: "/home/peter",
      }),
    ).toThrow('Invalid profile name: "../escape"');
  });

  it("prefers OPENCLAW_WORKSPACE_DIR for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_WORKSPACE_DIR: "/srv/openclaw-workspace",
      OPENCLAW_PROFILE: "work",
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    });

    expect(dir).toBe(path.resolve("/srv/openclaw-workspace"));
  });
});

async function readWorkspaceState(dir: string) {
  return (await readWorkspaceStateSnapshot(dir)).setup;
}

async function expectBootstrapSeeded(dir: string) {
  await expect(fs.access(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
  const state = await readWorkspaceState(dir);
  expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function expectWorkspaceVanished(action: Promise<unknown>): Promise<void> {
  // Recently attested generated workspaces must not be silently recreated after
  // deletion or wipe; that could hide user data loss.
  await expect(action).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
    name: "WorkspaceVanishedError",
  });
}

async function expectCompletedWithoutBootstrap(dir: string) {
  await expect(fs.access(path.join(dir, DEFAULT_IDENTITY_FILENAME))).resolves.toBeUndefined();
  await expectPathMissing(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME));
  const state = await readWorkspaceState(dir);
  expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
}

describe("ensureAgentWorkspace", () => {
  it("refuses to re-seed a future-attested workspace after only generated remnants survive", async () => {
    await ensureWorkspace();
    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    const generatedAgents = await fs.readFile(workspacePath(DEFAULT_AGENTS_FILENAME), "utf-8");
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now() + 60_000,
      generatedHashes: snapshot.attestation!.generatedHashes,
    });

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(workspacePath(DEFAULT_AGENTS_FILENAME), generatedAgents);

    await expectWorkspaceVanished(ensureWorkspace());
    await expectPathMissing(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("accepts attested historical AGENTS.md while ignoring retired generated hashes", async () => {
    const oldGeneratedAgents = "old generated agents\n";
    await fs.writeFile(workspacePath(DEFAULT_AGENTS_FILENAME), oldGeneratedAgents);
    await mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    });
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes: new Map([
        [DEFAULT_AGENTS_FILENAME, createHash("sha256").update(oldGeneratedAgents).digest("hex")],
        ["RETIRED.md", "a".repeat(64)],
      ]),
    });

    await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
    await expectPathMissing(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("uses template comparison when an attestation has no generated hashes", async () => {
    await ensureWorkspace();
    const generatedAgents = await fs.readFile(workspacePath(DEFAULT_AGENTS_FILENAME), "utf-8");

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(workspacePath(DEFAULT_AGENTS_FILENAME), generatedAgents);
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: Date.now(),
      generatedHashes: new Map(),
    });

    await expectWorkspaceVanished(ensureWorkspace());
    await expectPathMissing(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("accepts a recently attested workspace when only custom skills survive", async () => {
    await ensureWorkspace();

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(workspacePath("skills", "local-skill"), { recursive: true });
    await fs.writeFile(workspacePath("skills", ".DS_Store"), "");
    await fs.writeFile(workspacePath("skills", "local-skill", "SKILL.md"), "---\n");

    await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
    await expectPathMissing(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses to accept a wiped skip-bootstrap workspace with only metadata leftovers", async () => {
    await fs.writeFile(workspacePath("seed.txt"), "preseeded\n");
    await ensureWorkspace(false);

    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(workspacePath(".openclaw"), { recursive: true });
    await fs.mkdir(workspacePath("skills"), { recursive: true });
    await fs.writeFile(workspacePath(".DS_Store"), "");

    await expectWorkspaceVanished(ensureWorkspace(false));
    await expectPathMissing(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
  });

  it("reseeds expired SQLite state with a missing workspace", async () => {
    const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
    await mergeWorkspaceSetupState(
      tempDir,
      {
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      },
      expiredAtMs,
    );
    await replaceWorkspaceAttestation({
      workspaceDir: tempDir,
      attestedAtMs: expiredAtMs,
      generatedHashes: new Map(),
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    await ensureWorkspace();
    await expectBootstrapSeeded(tempDir);
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  });

  it("requires Doctor when SQLite setup state coexists with a legacy attestation", async () => {
    await mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
    });
    const attestationPath = `${tempDir}.attested`;
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${new Date().toISOString()}\n`;
    await fs.writeFile(attestationPath, marker);

    await expect(ensureWorkspace()).rejects.toThrow(/Run openclaw doctor --fix/u);

    expect(await fs.readFile(attestationPath, "utf-8")).toBe(marker);
    expect((await readWorkspaceStateSnapshot(tempDir)).setupExists).toBe(true);
  });

  it("treats git-backed workspaces as existing even when template files are missing", async () => {
    await fs.mkdir(workspacePath(".git"), { recursive: true });
    await fs.writeFile(workspacePath(".git", "HEAD"), "ref: refs/heads/main\n");

    await ensureWorkspace();

    await expectCompletedWithoutBootstrap(tempDir);
  });

  it("keeps bootstrap status read-only when stale completion evidence exists", async () => {
    await ensureWorkspace();
    await writeWorkspaceFile(DEFAULT_IDENTITY_FILENAME, "# IDENTITY.md\n\n- **Name:** Example\n");

    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(fs.access(workspacePath(DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
    expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(true);
    await ensureWorkspace();
    await expectCompletedWithoutBootstrap(tempDir);
    await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
  });

  it("does not read setup state for an absent bootstrap file and refreshes after a setup wait", async () => {
    const actual = workspaceState.readWorkspaceStateSnapshot;
    const read = vi.spyOn(workspaceState, "readWorkspaceStateSnapshot");
    try {
      await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
      await writeWorkspaceFile(DEFAULT_BOOTSTRAP_FILENAME, "# Bootstrap\n");
      read.mockImplementationOnce(async (...args) => {
        const snapshot = await actual(...args);
        await fs.unlink(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
        return snapshot;
      });
      await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  it("propagates a transient profile read after the retry budget is exhausted", async () => {
    await ensureWorkspace();
    const identityPath = workspacePath(DEFAULT_IDENTITY_FILENAME);
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === identityPath) {
        throw Object.assign(new Error("Unknown system error -11, read"), {
          code: "EAGAIN",
          errno: -11,
        });
      }
      return await originalReadFile(filePath, options);
    });

    try {
      await expect(ensureWorkspace()).rejects.toMatchObject({ code: "EAGAIN" });
    } finally {
      readSpy.mockRestore();
    }
  });

  it("records stale bootstrap completion when BOOTSTRAP.md cleanup fails", async () => {
    await ensureWorkspace();
    await writeWorkspaceFile(DEFAULT_IDENTITY_FILENAME, "# IDENTITY.md\n\n- **Name:** Example\n");
    const bootstrapPath = workspacePath(DEFAULT_BOOTSTRAP_FILENAME);
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
      if (filePath === bootstrapPath) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      await originalRm(filePath, options);
    });

    try {
      await ensureWorkspace();
      await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
      const state = await readWorkspaceState(tempDir);
      expect(state.setupCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("observes setup completed concurrently before writing optional bootstrap files", async () => {
    const agentsPath = workspacePath(DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "custom agents instructions\n", "utf8");
    await mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
    });
    const realAccess = fs.access.bind(fs);
    let completed = false;
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (filePath, mode) => {
      if (!completed && filePath === agentsPath) {
        completed = true;
        await mergeWorkspaceSetupState(tempDir, {
          setupCompletedAt: "2026-07-15T10:01:00.000Z",
        });
      }
      return await realAccess(filePath, mode);
    });

    try {
      await ensureWorkspace();
    } finally {
      accessSpy.mockRestore();
    }

    expect(completed).toBe(true);
    for (const filename of [
      DEFAULT_SOUL_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      LEGACY_HEARTBEAT_FILENAME,
    ]) {
      await expectPathMissing(workspacePath(filename));
    }
  });
});

registerWorkspaceBootstrapTests();

describe("workspace attestation survival", () => {
  it.each([
    ["generated", "corrupt", "0".repeat(64)],
    ["customized", "missing", undefined],
  ] as const)(
    "checks %s survival evidence with a %s AGENTS.md hash",
    async (content, _kind, hash) => {
      await ensureWorkspace();
      await fs.rm(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
      const customInstructions = "custom instructions\n";
      if (content === "customized") {
        await fs.writeFile(workspacePath(DEFAULT_AGENTS_FILENAME), customInstructions);
      }
      const snapshot = await readWorkspaceStateSnapshot(tempDir);
      const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
      if (hash === undefined) {
        generatedHashes.delete(DEFAULT_AGENTS_FILENAME);
      } else {
        generatedHashes.set(DEFAULT_AGENTS_FILENAME, hash);
      }
      await replaceWorkspaceAttestation({
        workspaceDir: tempDir,
        attestedAtMs: Date.now(),
        generatedHashes,
      });
      if (content === "customized") {
        await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
        await expect(fs.readFile(workspacePath(DEFAULT_AGENTS_FILENAME), "utf8")).resolves.toBe(
          customInstructions,
        );
      } else {
        await expectWorkspaceVanished(ensureWorkspace());
      }
    },
  );
});

describe("ensureAgentWorkspace runtime-managed-implicit provisioning", () => {
  it("creates only the directory for runtime-managed-implicit provisioning (#92015)", async () => {
    const targetDir = testState!.path("implicit-parent/implicit-acp-workspace");

    const result = await ensureAgentWorkspace({
      dir: targetDir,
      ensureBootstrapFiles: true,
      provisioning: "runtime-managed-implicit",
    });

    expect(result.dir).toBe(targetDir);
    expect(result.bootstrapPending).toBe(false);
    // Directory is provisioned so ACP cwd fallback and media staging keep working...
    await expect(fs.access(targetDir)).resolves.toBeUndefined();
    // ...but no bootstrap files, git repo, or workspace state are seeded.
    await expectPathMissing(path.join(targetDir, DEFAULT_AGENTS_FILENAME));
    await expectPathMissing(path.join(targetDir, DEFAULT_BOOTSTRAP_FILENAME));
    await expectPathMissing(path.join(targetDir, ".git"));
    expect((await workspaceState.readWorkspaceStateSnapshot(targetDir)).setupExists).toBe(false);
  });
});

describe("workspace completion persistence", () => {
  it.each(["committed", "failed", "retired-before-commit", "retired-after-commit"] as const)(
    "waits for the completion write before bootstrap cleanup: %s",
    async (outcome) => {
      const dir = testState!.workspaceDir;
      await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
      const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
      await fs.writeFile(path.join(dir, DEFAULT_USER_FILENAME), "A configured user.\n");
      const entered = createDeferred();
      const release = createDeferred();
      const realMerge = workspaceState.mergeWorkspaceSetupState;
      const write = vi
        .spyOn(workspaceState, "mergeWorkspaceSetupState")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          if (outcome === "failed") {
            throw new Error("completion write failed");
          }
          const result = await realMerge(...args);
          if (outcome === "retired-after-commit") {
            current = false;
          }
          return result;
        });
      let current = true;
      let settled = false;
      const pending = ensureAgentWorkspace({
        dir,
        ensureBootstrapFiles: true,
        guard: {
          assertHost: () => {
            if (!current) {
              throw new Error("workspace owner retired");
            }
          },
        },
      });
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await withTestTimeout(entered.promise, 5_000, "Completion write was not reached");
        await checkpoint();
        expect(settled).toBe(false);
        await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
        current = outcome !== "retired-before-commit";
        release.resolve();
        if (outcome === "committed") {
          await expect(pending).resolves.toMatchObject({ bootstrapPending: false });
          await expectPathMissing(bootstrapPath);
        } else {
          await expect(pending).rejects.toThrow(
            outcome === "failed" ? "completion write failed" : "workspace owner retired",
          );
          await expect(fs.access(bootstrapPath)).resolves.toBeUndefined();
        }
        const snapshot = await workspaceState.readWorkspaceStateSnapshot(dir);
        expect(Boolean(snapshot.setup.setupCompletedAt)).toBe(
          outcome === "committed" || outcome === "retired-after-commit",
        );
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        write.mockRestore();
      }
    },
  );
});

registerWorkspacePreparationTests({
  getFixture: getWorkspaceTestFixture,
  expectBootstrapSeeded,
  expectCompletedWithoutBootstrap,
  expectPathMissing,
});

function gitTestEnvironment(): NodeJS.ProcessEnv {
  const { state } = getWorkspaceTestFixture();
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    HOME: state.home,
    USERPROFILE: state.home,
    TMPDIR: state.root,
    TEMP: state.root,
    TMP: state.root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

it("settles admitted Git work through success, failure, and caller retirement", async ({
  signal,
}) => {
  const { state } = getWorkspaceTestFixture();
  for (const outcome of ["success", "failure", "retired"] as const) {
    const dir = state.path(`git-${outcome}`);
    const entered = createDeferred();
    const release = createDeferred();
    const baseEnv = gitTestEnvironment();
    const realRun = commandExec.runCommandWithTimeout;
    let attempts = 0;
    let gitSettled = false;
    let current = true;
    const retired = new Error("workspace owner retired during Git initialization");
    const command = vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv[0] !== "git") {
          return await realRun(argv, options);
        }
        const settings = typeof options === "number" ? { timeoutMs: options } : options;
        if (argv[1] !== "init") {
          return await realRun(argv, { ...settings, baseEnv });
        }
        expect(settings.cwd).toBe(dir);
        attempts++;
        entered.resolve();
        await release.promise;
        try {
          if (outcome === "failure") {
            throw new Error("Injected Git initialization failure");
          }
          return await realRun(argv, { ...settings, baseEnv });
        } finally {
          gitSettled = true;
        }
      });
    const first = ensureAgentWorkspace({
      dir,
      ensureBootstrapFiles: true,
      guard: {
        assertHost: () => {
          if (!current) {
            throw retired;
          }
        },
      },
    });
    void first.catch(() => undefined);
    let follower: ReturnType<typeof ensureAgentWorkspace> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, first, "Git initialization was not reached"),
        signal,
      );
      follower = ensureAgentWorkspace({
        dir,
        guard: { beforeLegacyApply: () => expect(gitSettled).toBe(true) },
      });
      void follower.catch(() => undefined);
      current = outcome !== "retired";
      release.resolve();
      if (outcome === "retired") {
        await expect(first).rejects.toBe(retired);
      } else {
        await expect(first).resolves.toMatchObject({ bootstrapPending: true });
      }
      await expect(follower).resolves.toEqual({ dir, bootstrapPending: false });
      expect(attempts).toBe(1);
      if (outcome !== "failure") {
        const result = await realRun(["git", "rev-parse", "--show-toplevel"], {
          cwd: dir,
          timeoutMs: 5_000,
          baseEnv,
        });
        expect(result.code).toBe(0);
        expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(dir));
      } else {
        await expectPathMissing(path.join(dir, ".git"));
        await expectBootstrapSeeded(dir);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([first, follower]);
      command.mockRestore();
    }
  }
});

describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "workspace permission failures",
  () => {
    afterEach(async () => {
      await fs.chmod(tempDir, 0o700);
    });

    it.each([0o300, 0o000])(
      "retains optional bootstrap entries when root mode is %s",
      async (mode) => {
        const names = [
          DEFAULT_AGENTS_FILENAME,
          DEFAULT_MEMORY_FILENAME,
          DEFAULT_USER_FILENAME,
        ] as const;
        for (const name of names) {
          await fs.writeFile(path.join(tempDir, name), `content:${name}`);
        }
        await fs.chmod(tempDir, mode);
        await expect(fs.readdir(tempDir)).rejects.toMatchObject({ code: "EACCES" });
        const files = await loadWorkspaceBootstrapFiles(tempDir, names);
        expect(files.map((file) => file.name).toSorted()).toEqual([...names].toSorted());
        for (const file of files) {
          expect(file.missing).toBe(false);
          if (mode === 0o300) {
            expect(file.content).toBe(`content:${file.name}`);
          } else {
            expect(file.content).toContain("[UNREADABLE:");
          }
        }
      },
    );

    it("omits absent optional bootstrap files when the root cannot be listed", async () => {
      await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "instructions");
      await fs.chmod(tempDir, 0o300);
      await expect(fs.readdir(tempDir)).rejects.toMatchObject({ code: "EACCES" });

      const files = await loadWorkspaceBootstrapFiles(tempDir, [
        DEFAULT_AGENTS_FILENAME,
        DEFAULT_MEMORY_FILENAME,
        DEFAULT_USER_FILENAME,
      ]);

      expect(files.map((file) => file.name)).toEqual([DEFAULT_AGENTS_FILENAME]);
      expect(files[0]?.content).toBe("instructions");
    });

    it("rejects skip-bootstrap setup under an unlistable root without changing content", async () => {
      await fs.writeFile(path.join(tempDir, DEFAULT_MEMORY_FILENAME), "user memory");
      await ensureWorkspace(false);
      const before = await fs.readdir(tempDir);
      const beforeState = await readWorkspaceStateSnapshot(tempDir);
      await fs.chmod(tempDir, 0o100);
      await expect(ensureWorkspace(false)).rejects.toMatchObject({ code: "EACCES" });
      await fs.chmod(tempDir, 0o700);
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(before.toSorted());
      expect(await fs.readFile(path.join(tempDir, DEFAULT_MEMORY_FILENAME), "utf8")).toBe(
        "user memory",
      );
      expect((await readWorkspaceStateSnapshot(tempDir)).setup).toEqual(beforeState.setup);
    });

    it("rejects setup under an unlistable root without completing onboarding", async () => {
      await ensureWorkspace();
      const before = (await readWorkspaceStateSnapshot(tempDir)).setup;
      expect(before.setupCompletedAt).toBeUndefined();
      const bootstrap = await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), "utf8");
      await fs.chmod(tempDir, 0o300);
      await expect(ensureWorkspace()).rejects.toMatchObject({ code: "EACCES" });
      expect(await fs.readFile(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME), "utf8")).toBe(
        bootstrap,
      );
      expect((await readWorkspaceStateSnapshot(tempDir)).setup).toEqual(before);
    });

    it("rejects setup under an unlistable root without changing surviving skills", async () => {
      await ensureWorkspace();
      const before = (await readWorkspaceStateSnapshot(tempDir)).setup;
      await fs.rm(tempDir, { recursive: true });
      const skill = path.join(tempDir, "skills", "local-skill", "SKILL.md");
      await fs.mkdir(path.dirname(skill), { recursive: true });
      await fs.writeFile(skill, "custom skill");
      await fs.chmod(tempDir, 0o300);
      await expect(ensureWorkspace()).rejects.toMatchObject({ code: "EACCES" });
      expect(await fs.readFile(skill, "utf8")).toBe("custom skill");
      expect((await readWorkspaceStateSnapshot(tempDir)).setup).toEqual(before);
    });
  },
);
