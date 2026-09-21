import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { executeAgentDatabaseCleanupCommand } from "./openclaw-agent-execution-cleanup.worker.js";
import { readOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }),
  );
  children.clear();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function openChild(pathname: string, env: NodeJS.ProcessEnv) {
  const child = fork(
    fileURLToPath(new URL("./openclaw-agent-db-held-child.test-support.ts", import.meta.url)),
    ["integrity-lease", pathname],
    { execArgv: ["--import", "tsx"], env: { ...process.env, ...env }, silent: true },
  );
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error(`Agent child exited before opening: ${stderr}`));
    child.once("error", reject);
    child.once("exit", failed);
    child.once("message", (message) => {
      child.off("exit", failed);
      if (message === "ready") {
        resolve();
      } else {
        reject(new Error(`Unexpected agent child message: ${JSON.stringify(message)}`));
      }
    });
  });
  return child;
}

function openOwner() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-integrity-lease-") };
  const database = openOpenClawAgentDatabase({ agentId: "integrity-lease", env });
  return {
    env,
    database,
    record: () => readOpenClawAgentIntegrityVerification(database.path, env),
  };
}

it.each(process.platform === "win32" ? [false] : [false, true])(
  "publishes clean close only after the last process closes (alias: %s)",
  async (alias) => {
    const owner = openOwner();
    const childPath = alias ? `${owner.database.path}.alias` : owner.database.path;
    if (alias) {
      fs.symlinkSync(owner.database.path, childPath);
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env, path: childPath });
      closeOpenClawAgentDatabaseByPath(childPath);
      openOpenClawAgentDatabase({
        agentId: "integrity-lease",
        env: owner.env,
        path: owner.database.path,
      });
    }
    const child = await openChild(childPath, owner.env);
    expect(owner.record()?.clean_close).toBe(0);

    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(0);

    const exited = once(child, "exit");
    child.send("close");
    expect(await exited).toEqual([0, null]);
    expect(readOpenClawAgentIntegrityVerification(childPath, owner.env)?.clean_close).toBe(1);
  },
);

it.each(["forced cleanup", "stale admission"])(
  "recovers a killed process via %s without certifying a surviving handle",
  async (recovery) => {
    const owner = openOwner();
    const child = await openChild(owner.database.path, owner.env);
    const state = openOpenClawStateDatabase({ env: owner.env });
    const row = state.db
      .prepare("SELECT * FROM agent_database_leases WHERE owner_pid = ?")
      .get(child.pid!) as {
      lease_id: string;
      agent_id: string;
      path: string;
      owner_pid: number;
      owner_start_time: number | null;
    };
    const receipt: OpenClawAgentDatabaseWorkerLeaseReceipt = {
      leaseId: row.lease_id,
      agentId: row.agent_id,
      path: row.path,
      ownerPid: row.owner_pid,
      ownerStartTime: row.owner_start_time,
      sharedStatePath: state.path,
      sharedStateIdentity: readDatabasePathIdentitySync(state.path).key,
    };
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    if (recovery === "forced cleanup") {
      executeAgentDatabaseCleanupCommand(
        { type: "agentDatabases.releaseExitedLease", input: receipt },
        state,
        owner.env,
      );
      expect(owner.record()).toBeUndefined();
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.record()).toBeUndefined();
    } else {
      closeOpenClawAgentDatabaseByPath(owner.database.path);
      expect(owner.record()?.clean_close).toBe(0);
    }
    openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
    expect(owner.record()?.clean_close).toBe(0);
    expect(
      state.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE owner_pid = ?")
        .all(child.pid!),
    ).toEqual([]);
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(1);
  },
);

it("does not certify a failed checkpoint or native close", () => {
  const owner = openOwner();
  vi.spyOn(owner.database.walMaintenance, "close").mockReturnValueOnce(false);
  closeOpenClawAgentDatabaseByPath(owner.database.path);
  expect(owner.record()).toBeUndefined();

  closeOpenClawAgentDatabasesForTest();
  const reopened = openOpenClawAgentDatabase({ agentId: "integrity-lease", env: owner.env });
  const failure = new Error("synthetic native close failed");
  vi.spyOn(reopened.db, "close").mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => closeOpenClawAgentDatabaseByPath(reopened.path)).toThrow(failure);
  expect(owner.record()).toBeUndefined();
  closeOpenClawAgentDatabaseByPath(reopened.path);
  expect(owner.record()).toBeUndefined();
});

it("does not certify a last read-only release without a writer checkpoint", () => {
  const owner = openOwner();
  const options = { agentId: "integrity-lease", env: owner.env, path: owner.database.path };
  const lease = claimOpenClawAgentDatabaseLease(options);
  const reader = openOpenClawAgentDatabaseReadOnly(options);
  expect(reader.found).toBe(true);
  if (!reader.found) {
    throw new Error("Expected the existing real agent database");
  }
  try {
    closeOpenClawAgentDatabaseByPath(owner.database.path);
    expect(owner.record()?.clean_close).toBe(0);
  } finally {
    reader.database.close();
    releaseOpenClawAgentDatabaseLease(lease, { env: owner.env }, "read-only");
  }
  expect(owner.record()?.clean_close).toBe(0);
});
