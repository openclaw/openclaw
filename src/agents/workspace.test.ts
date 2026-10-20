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
  DEFAULT_AGENTS_FILENAME as AGENTS,
  DEFAULT_BOOTSTRAP_FILENAME as BOOTSTRAP,
  DEFAULT_IDENTITY_FILENAME as IDENTITY,
  DEFAULT_MEMORY_FILENAME as MEMORY,
  DEFAULT_SOUL_FILENAME as SOUL,
  DEFAULT_USER_FILENAME as USER,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
  loadWorkspaceBootstrapFiles,
  resolveWorkspaceBootstrapStatus,
  resolveDefaultAgentWorkspaceDir,
  WORKSPACE_VANISHED_ERROR_CODE,
} from "./workspace.js";

const HEARTBEAT = "HEARTBEAT.md";
const SEEDED = { bootstrapSeededAt: "2026-07-15T10:00:00.000Z" };
const COMPLETED = { ...SEEDED, setupCompletedAt: "2026-07-15T10:01:00.000Z" };
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T/;
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
  vi.restoreAllMocks();
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
function readWorkspaceFile(name: string) {
  return fs.readFile(workspacePath(name), "utf8");
}
function attest(generatedHashes: ReadonlyMap<string, string>, attestedAtMs = Date.now()) {
  return replaceWorkspaceAttestation({ workspaceDir: tempDir, attestedAtMs, generatedHashes });
}

async function replaceWorkspace(files: Record<string, string> = {}) {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(workspacePath(name)), { recursive: true });
    await writeWorkspaceFile(name, content);
  }
}

function ensureWorkspace(
  ensureBootstrapFiles = true,
  options: Omit<
    NonNullable<Parameters<typeof ensureAgentWorkspace>[0]>,
    "ensureBootstrapFiles"
  > = {},
) {
  return ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles, ...options });
}

function workspaceGate(message = "workspace owner retired") {
  const entered = createDeferred();
  const release = createDeferred();
  const retired = new Error(message);
  const gate = {
    entered,
    release,
    retired,
    current: true,
    assertHost: () => {
      if (!gate.current) {
        throw retired;
      }
    },
    async enter() {
      entered.resolve();
      await release.promise;
    },
  };
  return gate;
}

it.each([
  [undefined, ".openclaw"],
  ["work", ".openclaw-work"],
] as const)("roots profile %s under OPENCLAW_HOME", (profile, stateDir) => {
  expect(
    resolveDefaultAgentWorkspaceDir({
      OPENCLAW_PROFILE: profile,
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    }),
  ).toBe(path.join(path.resolve("/srv/openclaw-home"), stateDir, "workspace"));
});

it("rejects invalid environment-only profile names", () => {
  expect(() =>
    resolveDefaultAgentWorkspaceDir({
      OPENCLAW_PROFILE: "../escape",
      HOME: "/home/peter",
    }),
  ).toThrow('Invalid profile name: "../escape"');
});

async function readWorkspaceState(dir: string) {
  return (await readWorkspaceStateSnapshot(dir)).setup;
}

async function expectBootstrapSeeded(dir: string) {
  await fs.access(path.join(dir, BOOTSTRAP));
  expect((await readWorkspaceState(dir)).bootstrapSeededAt).toMatch(TIMESTAMP);
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toHaveProperty("code", "ENOENT");
}

async function expectWorkspaceVanished(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toMatchObject({
    code: WORKSPACE_VANISHED_ERROR_CODE,
    name: "WorkspaceVanishedError",
  });
}

async function expectCompletedWithoutBootstrap(dir: string) {
  await fs.access(path.join(dir, IDENTITY));
  await expectPathMissing(path.join(dir, BOOTSTRAP));
  expect((await readWorkspaceState(dir)).setupCompletedAt).toMatch(TIMESTAMP);
}

it("refuses to re-seed a future-attested workspace after only generated remnants survive", async () => {
  await ensureWorkspace();
  const snapshot = await readWorkspaceStateSnapshot(tempDir);
  const generatedAgents = await readWorkspaceFile(AGENTS);
  await attest(snapshot.attestation!.generatedHashes, Date.now() + 60_000);
  await replaceWorkspace({ [AGENTS]: generatedAgents });
  await expectWorkspaceVanished(ensureWorkspace());
  await expectPathMissing(workspacePath(BOOTSTRAP));
});

it("accepts attested historical AGENTS.md while ignoring retired generated hashes", async () => {
  const oldGeneratedAgents = "old generated agents\n";
  await writeWorkspaceFile(AGENTS, oldGeneratedAgents);
  await mergeWorkspaceSetupState(tempDir, COMPLETED);
  await attest(
    new Map([
      [AGENTS, createHash("sha256").update(oldGeneratedAgents).digest("hex")],
      ["RETIRED.md", "a".repeat(64)],
    ]),
  );
  await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
  await expectPathMissing(workspacePath(BOOTSTRAP));
});

it("accepts a recently attested workspace when only custom skills survive", async () => {
  await ensureWorkspace();
  await replaceWorkspace({ "skills/.DS_Store": "", "skills/local-skill/SKILL.md": "---\n" });
  await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
  await expectPathMissing(workspacePath(BOOTSTRAP));
  expect((await readWorkspaceState(tempDir)).setupCompletedAt).toMatch(TIMESTAMP);
});

it("refuses to accept a wiped skip-bootstrap workspace with only metadata leftovers", async () => {
  await writeWorkspaceFile("seed.txt", "preseeded\n");
  await ensureWorkspace(false);
  await replaceWorkspace({ ".DS_Store": "" });
  await fs.mkdir(workspacePath(".openclaw"), { recursive: true });
  await fs.mkdir(workspacePath("skills"), { recursive: true });
  await expectWorkspaceVanished(ensureWorkspace(false));
  await expectPathMissing(workspacePath(BOOTSTRAP));
});

it("reseeds expired SQLite state with a missing workspace", async () => {
  const expiredAtMs = Date.now() - 25 * 60 * 60 * 1000;
  await mergeWorkspaceSetupState(tempDir, COMPLETED, expiredAtMs);
  await attest(new Map(), expiredAtMs);
  await fs.rm(tempDir, { recursive: true, force: true });
  await ensureWorkspace();
  await expectBootstrapSeeded(tempDir);
  expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
});

it("requires Doctor when SQLite setup state coexists with a legacy attestation", async () => {
  await mergeWorkspaceSetupState(tempDir, SEEDED);
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
  await writeWorkspaceFile(IDENTITY, "# IDENTITY.md\n\n- **Name:** Example\n");
  await expect(resolveWorkspaceBootstrapStatus(tempDir)).resolves.toBe("pending");
  await fs.access(workspacePath(BOOTSTRAP));
  expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBeUndefined();
  await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(true);
  await ensureWorkspace();
  await expectCompletedWithoutBootstrap(tempDir);
  await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
});

it("does not read setup state for an absent bootstrap file and refreshes after a setup wait", async () => {
  const actual = workspaceState.readWorkspaceStateSnapshot;
  const read = vi.spyOn(workspaceState, "readWorkspaceStateSnapshot");
  await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
  expect(read).not.toHaveBeenCalled();
  await writeWorkspaceFile(BOOTSTRAP, "# Bootstrap\n");
  read.mockImplementationOnce(async (...args) => {
    const snapshot = await actual(...args);
    await fs.unlink(workspacePath(BOOTSTRAP));
    return snapshot;
  });
  await expect(isWorkspaceBootstrapPending(tempDir)).resolves.toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
});

it("propagates a transient profile read after the retry budget is exhausted", async () => {
  await ensureWorkspace();
  const identityPath = workspacePath(IDENTITY);
  const originalReadFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
    if (filePath === identityPath) {
      throw Object.assign(new Error("Unknown system error -11, read"), {
        code: "EAGAIN",
        errno: -11,
      });
    }
    return await originalReadFile(filePath, options);
  });
  await expect(ensureWorkspace()).rejects.toMatchObject({ code: "EAGAIN" });
});

it("records stale bootstrap completion when BOOTSTRAP.md cleanup fails", async () => {
  await ensureWorkspace();
  await writeWorkspaceFile(IDENTITY, "# IDENTITY.md\n\n- **Name:** Example\n");
  const bootstrapPath = workspacePath(BOOTSTRAP);
  const originalRm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (filePath, options) => {
    if (filePath === bootstrapPath) {
      throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    }
    await originalRm(filePath, options);
  });
  await ensureWorkspace();
  await fs.access(bootstrapPath);
  expect((await readWorkspaceState(tempDir)).setupCompletedAt).toMatch(TIMESTAMP);
});

it("preserves concurrent setup while refusing ambiguous bootstrap remnants", async () => {
  const agentsPath = workspacePath(AGENTS);
  await fs.writeFile(agentsPath, "custom agents instructions\n", "utf8");
  await mergeWorkspaceSetupState(tempDir, SEEDED);
  const realAccess = fs.access.bind(fs);
  let completed = false;
  vi.spyOn(fs, "access").mockImplementation(async (filePath, mode) => {
    if (!completed && filePath === agentsPath) {
      completed = true;
      await mergeWorkspaceSetupState(tempDir, { setupCompletedAt: COMPLETED.setupCompletedAt });
    }
    return await realAccess(filePath, mode);
  });
  await expectWorkspaceVanished(ensureWorkspace());
  expect(completed).toBe(true);
  expect((await readWorkspaceState(tempDir)).setupCompletedAt).toBe(COMPLETED.setupCompletedAt);
  for (const filename of [SOUL, IDENTITY, USER, HEARTBEAT]) {
    await expectPathMissing(workspacePath(filename));
  }
});

registerWorkspaceBootstrapTests();

it.each([
  ["generated", "corrupt", "0".repeat(64)],
  ["customized", "missing", undefined],
] as const)(
  "checks %s survival evidence with a %s AGENTS.md hash",
  async (content, _kind, hash) => {
    await ensureWorkspace();
    await fs.rm(workspacePath(BOOTSTRAP));
    const customInstructions = "custom instructions\n";
    if (content === "customized") {
      await fs.writeFile(workspacePath(AGENTS), customInstructions);
    }
    const snapshot = await readWorkspaceStateSnapshot(tempDir);
    const generatedHashes = new Map(snapshot.attestation!.generatedHashes);
    if (hash === undefined) {
      generatedHashes.delete(AGENTS);
    } else {
      generatedHashes.set(AGENTS, hash);
    }
    await attest(generatedHashes);
    if (content === "customized") {
      await expect(ensureWorkspace()).resolves.toMatchObject({ dir: tempDir });
      await expect(fs.readFile(workspacePath(AGENTS), "utf8")).resolves.toBe(customInstructions);
    } else {
      await expectWorkspaceVanished(ensureWorkspace());
    }
  },
);

it("creates only the directory for runtime-managed-implicit provisioning (#92015)", async () => {
  const targetDir = testState!.path("implicit-parent/implicit-acp-workspace");
  const result = await ensureAgentWorkspace({
    dir: targetDir,
    ensureBootstrapFiles: true,
    provisioning: "runtime-managed-implicit",
  });
  expect(result).toMatchObject({ dir: targetDir, bootstrapPending: false });
  await fs.access(targetDir);
  for (const name of [AGENTS, BOOTSTRAP, ".git"]) {
    await expectPathMissing(path.join(targetDir, name));
  }
  expect((await workspaceState.readWorkspaceStateSnapshot(targetDir)).setupExists).toBe(false);
});

it.each(["committed", "failed", "retired-before-commit", "retired-after-commit"] as const)(
  "waits for the completion write before bootstrap cleanup: %s",
  async (outcome) => {
    await ensureWorkspace();
    const bootstrapPath = workspacePath(BOOTSTRAP);
    await writeWorkspaceFile(USER, "A configured user.\n");
    const gate = workspaceGate();
    const realMerge = workspaceState.mergeWorkspaceSetupState;
    vi.spyOn(workspaceState, "mergeWorkspaceSetupState").mockImplementation(async (...args) => {
      await gate.enter();
      if (outcome === "failed") {
        throw new Error("completion write failed");
      }
      const result = await realMerge(...args);
      if (outcome === "retired-after-commit") {
        gate.current = false;
      }
      return result;
    });
    const pending = ensureWorkspace(true, { guard: gate });
    const markSettled = vi.fn();
    void pending.then(markSettled, markSettled);
    try {
      await withTestTimeout(gate.entered.promise, 5_000, "Completion write was not reached");
      await checkpoint();
      expect(markSettled).not.toHaveBeenCalled();
      await fs.access(bootstrapPath);
      gate.current = outcome !== "retired-before-commit";
      gate.release.resolve();
      if (outcome === "committed") {
        await expect(pending).resolves.toMatchObject({ bootstrapPending: false });
        await expectPathMissing(bootstrapPath);
      } else {
        await expect(pending).rejects.toThrow(
          outcome === "failed" ? "completion write failed" : "workspace owner retired",
        );
        await fs.access(bootstrapPath);
      }
      expect(Boolean((await readWorkspaceState(tempDir)).setupCompletedAt)).toBe(
        outcome === "committed" || outcome === "retired-after-commit",
      );
    } finally {
      gate.release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

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

it.for(["success", "failure", "retired"] as const)(
  "settles admitted Git work: %s",
  async (outcome, { signal }) => {
    const { state } = getWorkspaceTestFixture();
    const dir = state.path(`git-${outcome}`);
    const gate = workspaceGate("workspace owner retired during Git initialization");
    const baseEnv = gitTestEnvironment();
    const realRun = commandExec.runCommandWithTimeout;
    let attempts = 0;
    let gitSettled = false;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] !== "git") {
        return await realRun(argv, options);
      }
      const settings = typeof options === "number" ? { timeoutMs: options } : options;
      if (argv[1] !== "init") {
        return await realRun(argv, { ...settings, baseEnv });
      }
      expect(settings.cwd).toBe(dir);
      attempts++;
      await gate.enter();
      try {
        if (outcome === "failure") {
          throw new Error("Injected Git initialization failure");
        }
        return await realRun(argv, { ...settings, baseEnv });
      } finally {
        gitSettled = true;
      }
    });
    const first = ensureWorkspace(true, { dir, guard: gate });
    void first.catch(() => undefined);
    let follower: ReturnType<typeof ensureAgentWorkspace> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          gate.entered.promise,
          first,
          "Git initialization was not reached",
        ),
        signal,
      );
      follower = ensureAgentWorkspace({
        dir,
        guard: { beforeLegacyApply: () => expect(gitSettled).toBe(true) },
      });
      void follower.catch(() => undefined);
      gate.current = outcome !== "retired";
      gate.release.resolve();
      if (outcome === "retired") {
        await expect(first).rejects.toBe(gate.retired);
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
      gate.release.resolve();
      await Promise.allSettled([first, follower]);
    }
  },
);

describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "workspace permission failures",
  () => {
    afterEach(async () => {
      await fs.chmod(tempDir, 0o700);
    });

    it.each([0o300, 0o000])(
      "retains optional bootstrap entries when root mode is %s",
      async (mode) => {
        const names = [AGENTS, MEMORY, USER] as const;
        for (const name of names) {
          await fs.writeFile(path.join(tempDir, name), `content:${name}`);
        }
        await fs.chmod(tempDir, mode);
        await expect(fs.readdir(tempDir)).rejects.toMatchObject({ code: "EACCES" });
        const files = await loadWorkspaceBootstrapFiles(tempDir, names);
        expect(files.toSorted((a, b) => a.name.localeCompare(b.name))).toMatchObject(
          [...names].toSorted().map((name) => ({
            name,
            missing: false,
            content: mode === 0o300 ? `content:${name}` : expect.stringContaining("[UNREADABLE:"),
          })),
        );
      },
    );

    it("omits absent optional bootstrap files when the root cannot be listed", async () => {
      await fs.writeFile(path.join(tempDir, AGENTS), "instructions");
      await fs.chmod(tempDir, 0o300);
      await expect(fs.readdir(tempDir)).rejects.toMatchObject({ code: "EACCES" });
      const files = await loadWorkspaceBootstrapFiles(tempDir, [AGENTS, MEMORY, USER]);
      expect(files).toMatchObject([{ name: AGENTS, content: "instructions" }]);
    });

    it.each(["skip-bootstrap", "onboarding", "surviving skills"] as const)(
      "rejects unlistable %s setup without changing content or state",
      async (kind) => {
        const bootstrap = kind !== "skip-bootstrap";
        if (!bootstrap) {
          await writeWorkspaceFile(MEMORY, "user memory");
        }
        await ensureWorkspace(bootstrap);
        const before = await readWorkspaceState(tempDir);
        const names = await fs.readdir(tempDir);
        const file = !bootstrap
          ? MEMORY
          : kind === "onboarding"
            ? BOOTSTRAP
            : "skills/local-skill/SKILL.md";
        if (kind === "surviving skills") {
          await replaceWorkspace({ [file]: "custom skill" });
        }
        if (kind === "onboarding") {
          expect(before.setupCompletedAt).toBeUndefined();
        }
        const content = await readWorkspaceFile(file);
        await fs.chmod(tempDir, bootstrap ? 0o300 : 0o100);
        await expect(ensureWorkspace(bootstrap)).rejects.toMatchObject({ code: "EACCES" });
        if (!bootstrap) {
          await fs.chmod(tempDir, 0o700);
          expect((await fs.readdir(tempDir)).toSorted()).toEqual(names.toSorted());
        }
        expect(await readWorkspaceFile(file)).toBe(content);
        expect(await readWorkspaceState(tempDir)).toEqual(before);
      },
    );
  },
);
