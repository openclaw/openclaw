// Workspace tests cover bootstrap seeding, attestation safety, bootstrap file
// filtering, and setup-completion state for agent workspaces.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as commandExec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as workspaceBootstrap from "./workspace-bootstrap-publish.js";
import { registerWorkspaceBootstrapTests } from "./workspace-bootstrap.test-utils.js";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  LEGACY_WORKSPACE_STATE_DIRNAME,
} from "./workspace-legacy-state.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
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
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
  resolveWorkspaceBootstrapStatus,
  resolveDefaultAgentWorkspaceDir,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

const LEGACY_HEARTBEAT_FILENAME = "HEARTBEAT.md";
let testState: OpenClawTestState | undefined;
let tempDir: string;
let disposeGitCohort: (() => Promise<void>) | undefined;

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
  try {
    await disposeGitCohort?.();
  } finally {
    disposeGitCohort = undefined;
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  }
});

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

const LEGACY_WORKSPACE_STATE_PATH_SEGMENTS = [
  LEGACY_WORKSPACE_STATE_DIRNAME,
  "workspace-state.json",
] as const;

async function readWorkspaceState(dir: string) {
  return (await readWorkspaceStateSnapshot(dir)).setup;
}

async function writeLegacyWorkspaceState(dir: string, state: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, LEGACY_WORKSPACE_STATE_PATH_SEGMENTS[0]), { recursive: true });
  await fs.writeFile(
    path.join(dir, ...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS),
    `${JSON.stringify(state)}\n`,
  );
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
  it("registers workspace aliases in the selected state database", async () => {
    const root = testState!.root;
    const workspace = path.join(root, "custom-db-workspace");
    const workspaceAlias = path.join(root, "custom-db-workspace-alias");
    const databasePath = path.join(root, "custom-state.sqlite");
    const options = { path: databasePath };
    const seededAt = "2026-07-31T12:00:00.000Z";
    await fs.mkdir(workspace);
    await fs.symlink(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    await mergeWorkspaceSetupState(workspace, { bootstrapSeededAt: seededAt }, Date.now(), options);

    expect((await readWorkspaceStateSnapshot(workspaceAlias, options)).setup).toEqual({
      version: 1,
      bootstrapSeededAt: seededAt,
    });
  });

  it("requires Doctor when partial SQLite state coexists with legacy setup state", async () => {
    const seededAt = "2026-07-15T10:00:00.000Z";
    await mergeWorkspaceSetupState(tempDir, { bootstrapSeededAt: seededAt });
    await writeLegacyWorkspaceState(tempDir, {
      version: 1,
      setupCompletedAt: "2026-07-15T10:01:00.000Z",
    });

    await expect(ensureWorkspace()).rejects.toThrow(/run openclaw doctor --fix/u);
    await expect(
      fs.access(workspacePath(...LEGACY_WORKSPACE_STATE_PATH_SEGMENTS)),
    ).resolves.toBeUndefined();
    expect((await readWorkspaceStateSnapshot(tempDir)).setup).toEqual({
      version: 1,
      bootstrapSeededAt: seededAt,
    });
  });

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

  it("allows repeated skip-bootstrap setup for an intentionally empty workspace", async () => {
    await ensureWorkspace(false);
    await expect(ensureWorkspace(false)).resolves.toMatchObject({ dir: tempDir });
  });

  it.each(["missing", "git-remnant"])(
    "reseeds expired SQLite state with a %s workspace",
    async (remnant) => {
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
      if (remnant === "git-remnant") {
        await fs.mkdir(workspacePath(".git"), { recursive: true });
      }
      await ensureWorkspace();
      await expectBootstrapSeeded(tempDir);
      expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
    },
  );

  it("requires Doctor when SQLite setup state coexists with a legacy attestation", async () => {
    await mergeWorkspaceSetupState(tempDir, {
      bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
    });
    const attestationPath = `${tempDir}.attested`;
    const marker = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${new Date().toISOString()}\n`;
    await fs.writeFile(attestationPath, marker);

    await expect(ensureWorkspace()).rejects.toThrow(/run openclaw doctor --fix/u);

    expect(await fs.readFile(attestationPath, "utf-8")).toBe(marker);
    expect((await readWorkspaceStateSnapshot(tempDir)).setupExists).toBe(true);
  });

  it("ignores and preserves a foreign sibling attestation file", async () => {
    const attestationPath = `${tempDir}.attested`;
    const siblingContent = "external attestation data\n";
    await fs.writeFile(attestationPath, siblingContent);

    await ensureWorkspace();

    await expectBootstrapSeeded(tempDir);
    expect(await fs.readFile(attestationPath, "utf-8")).toBe(siblingContent);
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

  it("keeps bootstrap pending when SOUL.md holds a previously shipped template", async () => {
    await ensureWorkspace();
    await writeWorkspaceFile(
      DEFAULT_SOUL_FILENAME,
      await fs.readFile("test/fixtures/agents/retired-workspace-templates/SOUL.md", "utf8"),
    );

    await ensureWorkspace();
    await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
    await expect(fs.access(workspacePath(DEFAULT_BOOTSTRAP_FILENAME))).resolves.toBeUndefined();
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
    ["missing", undefined],
    ["corrupt", "0".repeat(64)],
  ])("rejects generated survival evidence with a %s AGENTS.md hash", async (_kind, hash) => {
    await ensureWorkspace();
    await fs.rm(workspacePath(DEFAULT_BOOTSTRAP_FILENAME));
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
    await expectWorkspaceVanished(ensureWorkspace());
  });
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
        beforePersistentApply: () => {
          if (!current) {
            throw new Error("workspace owner retired");
          }
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

function startGitProvisioning(directories: string[], retryAfterFailure = false) {
  const dirs = directories.map((dir) => path.resolve(dir));
  const initGates = new Map(dirs.map((dir) => [dir, createDeferred()]));
  const admitted = createDeferred();
  const templates = createDeferred();
  const setup = createDeferred();
  const lateCaller = createDeferred();
  let agentsWrites = 0;
  let userWrites = 0;
  let setupWrites = 0;
  if (!retryAfterFailure) {
    lateCaller.resolve();
  }
  const realInstructions = workspaceBootstrap.publishAgentInstructions;
  const instructionsSpy = vi
    .spyOn(workspaceBootstrap, "publishAgentInstructions")
    .mockImplementation(async (...args) => {
      if (initGates.has(path.dirname(args[0]))) {
        if (++agentsWrites === dirs.length) {
          admitted.resolve();
        }
        // No seeding until all callers passed the real new-workspace admission.
        await admitted.promise;
      }
      return await realInstructions(...args);
    });
  const realPublish = workspaceBootstrap.publishBootstrapFile;
  const publishSpy = vi
    .spyOn(workspaceBootstrap, "publishBootstrapFile")
    .mockImplementation(async (...args) => {
      try {
        return await realPublish(...args);
      } finally {
        if (
          initGates.has(path.dirname(args[0])) &&
          path.basename(args[0]) === DEFAULT_USER_FILENAME
        ) {
          const last = ++userWrites === dirs.length;
          if (last) {
            templates.resolve();
          }
          // Finish real publication before any caller can inspect customization.
          await templates.promise;
          if (last) {
            await lateCaller.promise;
          }
        }
      }
    });
  const realMerge = workspaceState.mergeWorkspaceSetupState;
  const mergeSpy = vi
    .spyOn(workspaceState, "mergeWorkspaceSetupState")
    .mockImplementation(async (...args) => {
      const result = await realMerge(...args);
      if (initGates.has(args[0]) && ++setupWrites === dirs.length - Number(retryAfterFailure)) {
        setup.resolve();
      }
      return result;
    });
  const reads: Promise<void>[] = [];
  const realStat = fs.stat.bind(fs);
  const statSpy = vi.spyOn(fs, "stat").mockImplementation((file, options) => {
    const pending = realStat(file, options);
    if (
      typeof file === "string" &&
      path.basename(file) === ".git" &&
      initGates.has(path.dirname(file))
    ) {
      reads.push(
        pending.then(
          () => undefined,
          () => undefined,
        ),
      );
    }
    return pending;
  });
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    HOME: testState!.home,
    USERPROFILE: testState!.home,
    TMPDIR: testState!.root,
    TEMP: testState!.root,
    TMP: testState!.root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  const realRun = commandExec.runCommandWithTimeout;
  const attempts: string[] = [];
  let availability: Promise<unknown> | undefined;
  const commandSpy = vi
    .spyOn(commandExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      if (argv[0] !== "git") {
        return realRun(argv, options);
      }
      const settings = typeof options === "number" ? { timeoutMs: options } : options;
      if (argv[1] === "init") {
        const gate = settings.cwd && initGates.get(settings.cwd);
        if (!gate || !settings.cwd) {
          throw new Error("Refusing Git initialization outside the test workspace");
        }
        const fail = retryAfterFailure && attempts.length === 0;
        attempts.push(settings.cwd);
        await gate.promise;
        if (fail) {
          throw new Error("Injected Git initialization failure");
        }
      }
      const pending = realRun(argv, { ...settings, baseEnv });
      if (argv[1] === "--version") {
        availability = pending;
      }
      return pending;
    });
  const calls = directories.map((dir) => {
    const pending = ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    void pending.catch(() => undefined);
    return pending;
  });
  disposeGitCohort = async () => {
    for (const gate of [admitted, templates, lateCaller, ...initGates.values()]) {
      gate.resolve();
    }
    await Promise.allSettled(calls);
    for (const spy of [commandSpy, statSpy, mergeSpy, publishSpy, instructionsSpy]) {
      spy.mockRestore();
    }
  };
  const waitFor = <T>(pending: PromiseLike<T>) =>
    withTestTimeout(pending, 5_000, "Workspace provisioning did not reach the held Git operation");
  return {
    calls,
    attempts,
    release: (dir: string) => initGates.get(dir)!.resolve(),
    releaseLate: () => lateCaller.resolve(),
    async ready() {
      await waitFor(setup.promise);
      // Setup publication immediately precedes Git. Drain actual metadata/probe
      // work while init is held; no guessed delay decides the dispatch count.
      await waitFor(Promise.all(reads));
      await checkpoint();
      if (availability) {
        await waitFor(availability);
      }
      await checkpoint();
    },
    async expectRepository(dir: string) {
      const result = await realRun(["git", "rev-parse", "--show-toplevel"], {
        cwd: dir,
        timeoutMs: 5_000,
        baseEnv,
      });
      expect(result.code).toBe(0);
      expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(dir));
    },
  };
}

describe("ensureAgentWorkspace concurrent Git initialization", () => {
  it("shares initialization for concurrent callers resolving to the same workspace", async () => {
    const dir = testState!.path("git-workspace");
    const cohort = startGitProvisioning([dir, `${dir}${path.sep}.`]);
    await cohort.ready();
    expect(cohort.attempts).toEqual([dir]);
    cohort.release(dir);
    await Promise.all(cohort.calls);
    await cohort.expectRepository(dir);
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(cohort.attempts).toEqual([dir]);
  });

  it("lets an independent workspace finish while another initialization is held", async () => {
    const first = testState!.path("git-first");
    const second = testState!.path("git-second");
    const cohort = startGitProvisioning([first, second]);
    await cohort.ready();
    expect(cohort.attempts.toSorted()).toEqual([first, second]);
    cohort.release(second);
    await cohort.calls[1];
    await cohort.expectRepository(second);
    await expectPathMissing(path.join(first, ".git"));
    cohort.release(first);
    await cohort.calls[0];
    await cohort.expectRepository(first);
  });

  it("retries failed initialization only for a caller already admitted as brand-new", async () => {
    const dir = testState!.path("git-retry");
    const cohort = startGitProvisioning([dir, dir], true);
    await cohort.ready();
    expect(cohort.attempts).toEqual([dir]);
    cohort.release(dir);
    await Promise.race(cohort.calls);
    await expectPathMissing(path.join(dir, ".git"));
    // A newly started call sees seeded files and must not become retry-eligible.
    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });
    expect(cohort.attempts).toEqual([dir]);
    cohort.releaseLate();
    await Promise.all(cohort.calls);
    expect(cohort.attempts).toEqual([dir, dir]);
    await cohort.expectRepository(dir);
  });
});
