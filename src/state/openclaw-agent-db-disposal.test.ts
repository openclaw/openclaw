import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { disposeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-disposal.js";
import { useAgentDatabaseDirectories } from "./openclaw-agent-db-lifecycle.test-support.js";
import {
  isOpenClawAgentDatabaseRegistryChange,
  listOpenClawRegisteredAgentDatabases,
} from "./openclaw-agent-db-registry-listing.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
const tempDirs = useAgentDatabaseDirectories();

function createTempStateDir(): string {
  return fs.realpathSync(tempDirs.make("agent-db-disposal-"));
}

function fixture(agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
  const options = { agentId, env };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function dispose(options: ReturnType<typeof fixture>) {
  return disposeOpenClawAgentDatabaseByPath(options.path, { env: options.env });
}

function registry(options: ReturnType<typeof fixture>) {
  return listOpenClawRegisteredAgentDatabases({ env: options.env });
}

function aliasedFixture(options = fixture()) {
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
  const options = fixture("worker-1");
  const disposal = dispose(options);
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
  using _ = { [Symbol.dispose]: () => unsubscribe() };

  await expect(dispose(options)).rejects.toThrow("SQLite database file identity changed");
  expect(native.db.isOpen).toBe(false);
  expect(replacementInode).toBeDefined();
  expect(replacementInode).not.toBe(originalInode);
  expect(fs.statSync(options.path, { bigint: true }).ino).toBe(replacementInode);
  expect(registry(options)).toEqual([]);
});

it.runIf(process.platform !== "win32")(
  "refuses to dispose a symlinked database with duplicate native owners",
  async () => {
    const { options, aliased } = aliasedFixture();
    const database = openOpenClawAgentDatabase(options);
    const alias = openOpenClawAgentDatabase(aliased);
    await expect(dispose(options)).rejects.toThrow("multiple native owners");
    expect(database.db.isOpen).toBe(true);
    expect(alias.db.isOpen).toBe(true);
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
    expect(registry(options)).toHaveLength(2);
    const sql = observeHostDataSql();
    {
      using _ = { [Symbol.dispose]: () => sql.restore() };

      await expect(dispose(options)).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    }
    expect(registry(options)).toEqual([
      expect.objectContaining({ agentId: "sibling", path: siblingOptions.path }),
    ]);
    sibling.assertCurrent();
  } finally {
    await Promise.allSettled([execution.release(), sibling.release()]);
  }
});

it.each(["registered", "unregistered"] as const)(
  "drains a %s worker through its native or newly discovered alias",
  async (kind) => {
    const root = fixture();
    const registered = kind === "registered";
    const options = registered
      ? root
      : {
          ...root,
          path: path.join(root.env.OPENCLAW_STATE_DIR, "imports", "archive.sqlite"),
        };
    let aliased = registered ? aliasedFixture(options).aliased : undefined;
    const native = aliased && openOpenClawAgentDatabase(aliased);
    const execution = captureOpenClawAgentDatabaseExecution(options);
    try {
      await execution.prepare(source());
      expect(registry(options)).toEqual(
        registered ? [expect.objectContaining({ path: aliased?.path })] : [],
      );
      aliased ??= aliasedFixture(options).aliased;
      await expect(dispose(aliased)).resolves.toBe(registered);
      if (native) {
        expect(native.db.isOpen).toBe(false);
      }
      expect(() => execution.assertCurrent()).toThrow(/closed/);
      expect(registry(options)).toEqual([]);
    } finally {
      await execution.release();
    }
  },
);
