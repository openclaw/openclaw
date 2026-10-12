import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { disposeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-disposal.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  isOpenClawAgentDatabaseRegistryChange,
  listOpenClawRegisteredAgentDatabases,
} from "./openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createTempStateDir(): string {
  return fs.realpathSync(tempDirs.make("agent-db-disposal-"));
}

function fixture() {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const options = { agentId: "main", env };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function aliasedFixture() {
  const options = fixture();
  const alias = path.join(options.env.OPENCLAW_STATE_DIR, "alias");
  const directory = path.dirname(options.path);
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  return {
    options,
    aliased: { ...options, path: path.join(alias, path.basename(options.path)) },
  };
}

function source(): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent() {},
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Disposal fixture lost admission");
          }
        }, binding.attachment),
      });
    },
  };
}

it("fences an absent disposal before a successor can open", async () => {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const options = { agentId: "worker-1", env };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const disposal = disposeOpenClawAgentDatabaseByPath(pathname, { env });
  try {
    expect(() => openOpenClawAgentDatabase(options)).toThrow("resources are closing");
  } finally {
    await expect(disposal).resolves.toBe(false);
  }
  const successor = openOpenClawAgentDatabase(options);
  expect(successor.db.isOpen).toBe(true);
});

it("disposes only its exact cached owner and unregisters that registry row", async () => {
  const stateDir = createTempStateDir();
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const first = openOpenClawAgentDatabase({ agentId: "worker-1", env });
  const second = openOpenClawAgentDatabase({ agentId: "worker-2", env });

  expect(await disposeOpenClawAgentDatabaseByPath(first.path, { env })).toBe(true);
  expect(first.db.isOpen).toBe(false);
  expect(second.db.isOpen).toBe(true);
  expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
    expect.objectContaining({ agentId: "worker-2", path: second.path }),
  ]);
  expect(await disposeOpenClawAgentDatabaseByPath(first.path, { env })).toBe(false);
  expect(second.db.isOpen).toBe(true);

  const reopened = openOpenClawAgentDatabase({
    agentId: "worker-1",
    env,
    path: first.path,
  });
  expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
    expect.objectContaining({ agentId: "worker-1", path: reopened.path }),
    expect.objectContaining({ agentId: "worker-2", path: second.path }),
  ]);
});

it("rejects a file replacement during registry removal publication", async () => {
  const options = fixture();
  const native = openOpenClawAgentDatabase(options);
  const originalInode = fs.statSync(options.path, { bigint: true }).ino;
  const retiredPath = path.join(path.dirname(options.path), "retired.sqlite");
  let replacementInode: bigint | undefined;
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (!isOpenClawAgentDatabaseRegistryChange(change) || replacementInode !== undefined) {
      return;
    }
    fs.renameSync(options.path, retiredPath);
    fs.copyFileSync(retiredPath, options.path, fs.constants.COPYFILE_EXCL);
    replacementInode = fs.statSync(options.path, { bigint: true }).ino;
  });
  try {
    await expect(
      disposeOpenClawAgentDatabaseByPath(options.path, { env: options.env }),
    ).rejects.toThrow("SQLite database file identity changed");
    expect(native.db.isOpen).toBe(false);
    expect(replacementInode).toBeDefined();
    expect(replacementInode).not.toBe(originalInode);
    expect(fs.statSync(options.path, { bigint: true }).ino).toBe(replacementInode);
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([]);
  } finally {
    unsubscribe();
  }
});

it.runIf(process.platform !== "win32").each([false, true])(
  "disposes a symlinked database only when its cached owner is unambiguous (duplicate=%s)",
  async (duplicate) => {
    const stateDir = fs.realpathSync(createTempStateDir());
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const realDir = path.join(stateDir, "probe-real");
    const aliasDir = path.join(stateDir, "probe-alias");
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, aliasDir, "dir");
    const realPath = path.join(realDir, "openclaw-agent.sqlite");
    const aliasPath = path.join(aliasDir, "openclaw-agent.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "probe", env, path: realPath });
    const alias = duplicate
      ? openOpenClawAgentDatabase({ agentId: "probe", env, path: aliasPath })
      : undefined;

    const disposal = disposeOpenClawAgentDatabaseByPath(duplicate ? realPath : aliasPath, {
      env,
    });
    if (duplicate) {
      await expect(disposal).rejects.toThrow("multiple native owners");
    } else {
      await expect(disposal).resolves.toBe(true);
    }
    expect(database.db.isOpen).toBe(duplicate);
    if (alias) {
      expect(alias.db.isOpen).toBe(true);
    } else {
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    }
  },
);

it("disposes a worker-created database through its registry owner without host data SQL", async () => {
  const options = fixture();
  const siblingOptions = {
    ...options,
    agentId: "sibling",
    path: path.join(options.env.OPENCLAW_STATE_DIR, "sibling.sqlite"),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const sibling = captureOpenClawAgentDatabaseExecution(siblingOptions);
  try {
    await execution.prepare(source());
    await sibling.prepare(source());
    await execution.release();
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toHaveLength(2);
    const sql = observeHostDataSql();
    try {
      await expect(
        disposeOpenClawAgentDatabaseByPath(options.path, { env: options.env }),
      ).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
      expect.objectContaining({ agentId: "sibling", path: siblingOptions.path }),
    ]);
    sibling.assertCurrent();
  } finally {
    await Promise.allSettled([execution.release(), sibling.release()]);
  }
});

it("disposes a registered native alias and its canonical worker together", async () => {
  const { options, aliased } = aliasedFixture();
  const native = openOpenClawAgentDatabase(aliased);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  try {
    await execution.prepare(source());
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([
      expect.objectContaining({ path: aliased.path }),
    ]);
    await expect(
      disposeOpenClawAgentDatabaseByPath(aliased.path, { env: options.env }),
    ).resolves.toBe(true);
    expect(native.db.isOpen).toBe(false);
    expect(() => execution.assertCurrent()).toThrow(/closed/);
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([]);
  } finally {
    await execution.release();
  }
});

it("drains an unregistered worker through an alias first seen during disposal", async () => {
  const root = fixture();
  const options = {
    ...root,
    path: path.join(root.env.OPENCLAW_STATE_DIR, "imports", "archive.sqlite"),
  };
  const execution = captureOpenClawAgentDatabaseExecution(options);
  try {
    await execution.prepare(source());
    expect(listOpenClawRegisteredAgentDatabases({ env: options.env })).toEqual([]);
    const aliasDir = path.join(root.env.OPENCLAW_STATE_DIR, "archive-alias");
    fs.symlinkSync(
      path.dirname(options.path),
      aliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      disposeOpenClawAgentDatabaseByPath(path.join(aliasDir, "archive.sqlite"), {
        env: options.env,
      }),
    ).resolves.toBe(false);
    expect(() => execution.assertCurrent()).toThrow(/closed/);
  } finally {
    await execution.release();
  }
});
