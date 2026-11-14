import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useWorkspaceFilesystemBlock } from "../../test/helpers/workspace-filesystem-block.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { withOpenClawStateDatabaseReadSnapshot as withSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase as openDatabase,
  runOpenClawStateWriteTransaction as writeTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { resolveBootstrapFilesForPreparation as bootstrap } from "./bootstrap-files.js";
import { assertConfiguredWorkspaceStateReady as assertReady } from "./workspace-state-dirs.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import { readCanonicalWorkspaceStateSnapshot } from "./workspace-state-read.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace as expire,
  deleteWorkspaceState as remove,
  mergeWorkspaceSetupState as merge,
  prepareWorkspaceStateDeletion as deletionPlan,
  readWorkspaceStateSnapshot as read,
  replaceWorkspaceAttestation as attest,
} from "./workspace-state-store.js";

const expiredAt = 24 * 60 * 60 * 1000 + 2_001;
const seededAt = "2026-07-16T01:00:00.000Z";
const completedAt = "2026-07-16T02:00:00.000Z";
const milestone = { setupCompletedAt: completedAt };
const filesystemBlock = useWorkspaceFilesystemBlock();

let state: OpenClawTestState;
let dir: string;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-reader-" });
  dir = state.workspaceDir;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
  await state.cleanup();
});

async function seed() {
  await merge(dir, { bootstrapSeededAt: seededAt }, 1_000);
  await attest(attestation(1_000, "AGENTS.md", "a"));
  return await read(dir);
}
function attestation(at: number, file: string, hash: string) {
  return {
    workspaceDir: dir,
    attestedAtMs: at,
    nowMs: at,
    generatedHashes: new Map([[file, hash.repeat(64)]]),
  };
}
function link(alias: string, target = dir) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
function replacementAlias() {
  const alias = state.path("alias"),
    replacement = state.path("replacement");
  fs.mkdirSync(replacement);
  link(alias);
  return { alias, replacement };
}

async function withoutMainThreadSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  using _ = { [Symbol.dispose]: () => sql.restore() };
  const result = await run();
  sql.expectIdle();
  return result;
}

it("reuses unchanged workspace facts and refreshes them after each owning write", async () => {
  expect((await read(dir)).setupExists).toBe(false);
  const initial = await seed();
  expect(initial.setup.bootstrapSeededAt).toBe(seededAt);
  await readCanonicalWorkspaceStateSnapshot(dir);
  const execute = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
  const probes = [
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs, "lstatSync"),
    vi.spyOn(fs.realpathSync, "native"),
  ];
  const unchanged = await withoutMainThreadSql(() => readCanonicalWorkspaceStateSnapshot(dir));
  expect(unchanged).toEqual(initial);
  expect(execute).not.toHaveBeenCalled();
  for (const filesystemProbe of probes) {
    expect(filesystemProbe.mock.calls.filter(([pathname]) => pathname === dir)).toHaveLength(0);
    filesystemProbe.mockRestore();
  }

  await merge(dir, milestone);
  execute.mockClear();
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
  expect(execute).not.toHaveBeenCalled();
  await attest(attestation(2_000, "TOOLS.md", "b"));
  execute.mockClear();
  expect((await read(dir)).attestation).toEqual({
    attestedAtMs: 2_000,
    generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
  });
  expect(execute).not.toHaveBeenCalled();
  await remove(await deletionPlan(dir));
  expect(await read(dir)).toMatchObject({ setupExists: false, setup: { version: 1 } });
});

it.each([
  { readSnapshot: read, observation: 1 },
  { readSnapshot: read, observation: 2 },
  { readSnapshot: (workspace: string) => read(workspace, { readOnly: true }), observation: 2 },
  { readSnapshot: readCanonicalWorkspaceStateSnapshot, observation: 1 },
])(
  "refuses a retired read during filesystem observation $observation",
  async ({ readSnapshot, observation }) => {
    await seed();
    let observations = 0;
    const stat = fs.promises.stat;
    vi.spyOn(fs.promises, "stat").mockImplementation(
      new Proxy(stat, {
        async apply(method, receiver, args) {
          if (args[0] === dir && ++observations === observation) {
            await closeDatabase();
          }
          return Reflect.apply(method, receiver, args);
        },
      }),
    );
    await expect(readSnapshot(dir)).rejects.toHaveProperty(
      "code",
      "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    );
  },
);

it("rolls back setup when a recovery hold arrives after caller preparation", async () => {
  const initial = await seed();
  writeTransaction((database) => {
    database.db.exec("DROP TABLE agent_deletion_journal");
    reconstructAgentDeletionJournal(database, [
      { agentId: "new", path: state.path("held.sqlite") },
    ]);
  });
  await withoutMainThreadSql(async () => {
    const refusal = await merge(dir, milestone, 2_000, {
      recoveryHoldPredicate: { agentId: "new", held: [], applies: true },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DuplicateAgentError);
    expect(await read(dir)).toEqual(initial);
  });
});

it.each(["merge", "delete"] as const)("rejects revoked %s", async (operation) => {
  const initial = await seed();
  const alias = state.path("grant-alias");
  link(alias);
  for (const stage of ["transaction", "commit"] as const) {
    let retired = false;
    const refusal = new Error("workspace owner retired");
    const spy = probe.admission(workerAdmission, (request, grant, admit) => {
      retired ||= request.stage === stage;
      admit(request, grant);
    });
    const options = {
      assertCurrent: () => {
        if (retired) {
          throw refusal;
        }
      },
    };
    const pending =
      operation === "merge"
        ? merge(alias, milestone, 2_000, options)
        : remove(await deletionPlan(alias), options);
    await expect(pending).rejects.toBe(refusal);
    spy.mockRestore();
    expect(retired).toBe(true);
    expect(await read(dir)).toEqual(initial);
  }
  fs.unlinkSync(alias);
  expect((await read(alias)).setupExists).toBe(false);
});

it("refuses expiry when content is restored before the commit observation", async () => {
  const initial = await seed();
  const filePath = path.join(dir, "AGENTS.md");
  let restored = false;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    if (!restored && request.stage === "transaction") {
      fs.writeFileSync(filePath, "Restored workspace instructions.");
      restored = true;
    }
    admit(request, grant);
  });
  await expect(expire(dir, expiredAt)).rejects.toThrow("Workspace filesystem changed");
  spy.mockRestore();
  expect(restored).toBe(true);
  expect(await read(dir)).toEqual(initial);
});

it("refuses commit when its owner retires during the worker filesystem observation", async ({
  signal,
}) => {
  const initial = await seed();
  const refusal = new Error("workspace owner retired during filesystem lookup");
  let current = true;
  // The transaction observation runs first; hold the committing observation.
  const blocked = filesystemBlock.arm(dir, 2);
  const pending = merge(dir, milestone, 2_000, {
    assertCurrent: () => {
      if (!current) {
        throw refusal;
      }
    },
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        blocked,
        pending,
        "Workspace worker did not reach its committing filesystem observation",
      ),
      signal,
    );
    current = false;
  } finally {
    filesystemBlock.release();
    await pending.catch(() => undefined);
  }
  await expect(pending).rejects.toBe(refusal);
  expect(await read(dir)).toEqual(initial);
});

it.each(["expiry", "deletion"] as const)(
  "preserves committed %s cleanup on lost reply",
  async (cleanup) => {
    await seed();
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    const spy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        await execute(...args);
        throw new Error("workspace cleanup reply lost");
      });
    await expect(
      cleanup === "deletion" ? remove(await deletionPlan(dir)) : expire(dir, expiredAt),
    ).rejects.toThrow("workspace cleanup reply lost");
    spy.mockRestore();
    expect((await read(dir)).setupExists).toBe(false);
  },
);

it("keeps captured first-writer setup milestones across queued merges and reopen", async () => {
  await seed();
  const next = { ...milestone };
  const first = merge(dir, next, 2_000);
  next.setupCompletedAt = "2026-07-17T02:00:00.000Z";
  const second = merge(dir, next, 3_000);
  expect((await first).setupCompletedAt).toBe(completedAt);
  expect((await second).setupCompletedAt).toBe(completedAt);
  await closeDatabase();
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
});

it.each(["legacy-read", "transaction"] as const)(
  "rolls back alias registration when its symlink is repointed at %s",
  async (stage) => {
    const initial = await seed();
    const { alias, replacement } = replacementAlias();
    const repoint = () => {
      fs.unlinkSync(alias);
      link(alias, replacement);
    };
    const lstat = fs.promises.lstat;
    const filesystem = vi.spyOn(fs.promises, "lstat").mockImplementation(
      new Proxy(lstat, {
        async apply(method, receiver, args) {
          if (
            stage === "legacy-read" &&
            args[0] === path.join(dir, "openclaw-workspace-state.json")
          ) {
            repoint();
          }
          return Reflect.apply(method, receiver, args);
        },
      }),
    );
    const spy = probe.admission(workerAdmission, (request, grant, admit) => {
      if (stage === "transaction" && request.stage === "transaction") {
        repoint();
      }
      admit(request, grant);
    });
    await expect(
      readCanonicalWorkspaceStateSnapshot(alias, {}, { beforeLegacyApply() {} }),
    ).rejects.toBeInstanceOf(WorkspaceAliasRepointedError);
    spy.mockRestore();
    filesystem.mockRestore();
    expect(
      openDatabase()
        .db.prepare("SELECT alias_path FROM workspace_path_aliases WHERE alias_path = ?")
        .get(alias),
    ).toBeUndefined();
    fs.unlinkSync(alias);
    expect((await read(alias)).setupExists).toBe(false);
    expect(await read(dir)).toEqual(initial);
  },
);

it("joins a granted workspace mutation before closing its database", async () => {
  await seed();
  let close: Promise<void> | undefined;
  let closed = false;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(request, () => {
      const granted = grant();
      if (request.stage === "commit") {
        close = closeDatabase().then(() => {
          closed = true;
        });
        expect(closed).toBe(false);
      }
      return granted;
    });
  });
  await expect(merge(dir, milestone, 2_000)).rejects.toMatchObject({
    message: "SQLite committed facts publication failed",
    code: "outcome-unknown",
    cause: {
      message: "OpenClaw state database read admission is closed",
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    },
  });
  expect(close).toBeDefined();
  await close;
  spy.mockRestore();
  expect(closed).toBe(true);
  expect((await read(dir)).setup.setupCompletedAt).toBe(completedAt);
});

it.each([false, true])("prepares bootstrap without SQL: completed=%s", async (completed) => {
  await seed();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "Synthetic agent instructions.\n");
  fs.writeFileSync(path.join(dir, "BOOTSTRAP.md"), "Synthetic setup instructions.\n");
  if (completed) {
    await merge(dir, milestone);
  }
  await closeDatabase();
  const files = await withoutMainThreadSql(() => bootstrap({ workspaceDir: dir }));
  expect(files.find((file) => file.name === "AGENTS.md")?.content).toContain(
    "Synthetic agent instructions.",
  );
  // Preparation treats read errors as incomplete setup, so success alone is insufficient.
  expect(files.some((file) => file.name === "BOOTSTRAP.md")).toBe(!completed);
});

it("keeps workspace reads on the selected composite snapshot", async () => {
  const initial = await seed();
  await withSnapshot(async () => {
    await merge(dir, milestone);
    expect(await withoutMainThreadSql(() => read(dir, { readOnly: true }))).toEqual(initial);
  });
  expect((await read(dir, { readOnly: true })).setup.setupCompletedAt).toBe(completedAt);
});

it("reads committed workspace state while the cached writer has an open transaction", async () => {
  const initial = await seed();
  const database = openDatabase();
  database.db.exec("BEGIN IMMEDIATE");
  using _ = { [Symbol.dispose]: () => database.db.exec("ROLLBACK") };
  database.db.prepare("UPDATE workspace_setup_state SET setup_completed_at = ?").run(completedAt);
  expect(await withoutMainThreadSql(() => read(dir, { database, readOnly: true }))).toEqual(
    initial,
  );
  expect(database.db.isOpen).toBe(true);
});

it("preserves repointed workspace alias error identity and repair details", async () => {
  await seed();
  const { alias, replacement } = replacementAlias();
  await read(alias);
  fs.unlinkSync(alias);
  link(alias, replacement);
  await closeDatabase();
  const error = await withoutMainThreadSql(() =>
    assertReady({
      cfg: { agents: { defaults: { workspace: alias, sandbox: { mode: "off" } } } },
      env: state.env,
      operation: "doctor",
    }).catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(WorkspaceAliasRepointedError);
  expect(error).toMatchObject({
    aliasPath: path.normalize(alias),
    storedWorkspacePath: path.normalize(dir),
    currentWorkspacePath: path.normalize(replacement),
  });
});
