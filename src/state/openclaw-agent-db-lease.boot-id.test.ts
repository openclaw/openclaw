import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  claimOpenClawAgentDatabaseLease,
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const bootId = vi.hoisted(() => ({
  current: "11111111-1111-4111-8111-111111111111" as string | null,
}));
const OTHER_BOOT_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("../shared/boot-id.js", () => ({
  readBootId: () => bootId.current,
  resetBootIdCacheForTest: () => {},
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  bootId.current = "11111111-1111-4111-8111-111111111111";
  closeOpenClawStateDatabaseForTest();
});

type LeaseRow = {
  lease_id: string;
  owner_pid: number;
  owner_start_time: number | null;
  owner_boot_id: string | null;
};

function createOwner() {
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: tempDirs.make("agent-lease-boot-id-") };
  const agentPath = path.join(env.OPENCLAW_STATE_DIR!, "agents", "main", "agent.sqlite");
  const state = () => openOpenClawStateDatabase({ env });
  const rows = () =>
    state()
      .db.prepare(
        "SELECT lease_id, owner_pid, owner_start_time, owner_boot_id FROM agent_database_leases ORDER BY opened_at",
      )
      .all() as LeaseRow[];
  return { env, agentPath, state, rows };
}

/**
 * Simulate a hardened Linux host (Android, hidepid=invisible, SELinux signull
 * denial, systemd ProtectProc=): the foreign PID exists, kill(pid, 0) fails
 * with EPERM instead of ESRCH, and /proc/<pid>/* is not readable at all.
 */
function hideForeignProcess(pid: number) {
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation(((
    target: number,
    signal?: string | number,
  ) => {
    if (target === pid) {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    return originalKill(target, signal as never);
  }) as typeof process.kill);
  const originalReadFileSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, options) => {
    if (String(filePath).startsWith(`/proc/${pid}/`)) {
      throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    }
    return originalReadFileSync(filePath as never, options as never) as never;
  });
  return { kill };
}

/** Rewrite a claimed lease to look like it belongs to a hidden foreign process. */
function rewriteOwner(
  owner: ReturnType<typeof createOwner>,
  leaseId: string,
  ownerBootId: string | null,
) {
  owner
    .state()
    .db.prepare(
      "UPDATE agent_database_leases SET owner_pid = ?, owner_start_time = NULL, owner_boot_id = ? WHERE lease_id = ?",
    )
    .run(process.ppid, ownerBootId, leaseId);
  return hideForeignProcess(process.ppid);
}

describe("agent database lease boot identity", () => {
  it("records the current boot id with each claimed lease", () => {
    const owner = createOwner();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });

    expect(owner.rows()).toEqual([
      {
        lease_id: leaseId,
        owner_pid: process.pid,
        owner_start_time: expect.anything(),
        owner_boot_id: bootId.current,
      },
    ]);
  });

  it("records a null boot id when the platform exposes none", () => {
    bootId.current = null;
    const owner = createOwner();
    claimOpenClawAgentDatabaseLease({ agentId: "main", path: owner.agentPath, env: owner.env });

    expect(owner.rows()).toEqual([expect.objectContaining({ owner_boot_id: null })]);
  });

  it("treats a lease from another boot as stale even when the PID probe is EPERM and /proc is hidden", () => {
    const owner = createOwner();
    const previous = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    const { kill } = rewriteOwner(owner, previous, OTHER_BOOT_ID);

    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).toEqual([]);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).not.toThrow();

    const next = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    expect(owner.rows()).toEqual([
      expect.objectContaining({ lease_id: next, owner_boot_id: bootId.current }),
    ]);
    // Two differing boot identities decide before any (unanswerable) PID probe.
    expect(kill).not.toHaveBeenCalledWith(process.ppid, 0);
  });

  it("drains a lease from another boot through maintenance", () => {
    const owner = createOwner();
    const previous = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    rewriteOwner(owner, previous, OTHER_BOOT_ID);

    expect(() => assertNoOpenClawAgentDatabaseLeases("main", { env: owner.env })).not.toThrow();
    expect(owner.rows()).toEqual([]);
  });

  it("keeps a hidden foreign lease from the same boot", () => {
    const owner = createOwner();
    const held = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    const { kill } = rewriteOwner(owner, held, bootId.current);

    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).toEqual([
      expect.objectContaining({ lease_id: held, owner_pid: process.ppid }),
    ]);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).toThrow(
      "database is still open in process",
    );
    expect(() => assertNoOpenClawAgentDatabaseLeases("main", { env: owner.env })).toThrow(
      "database is still open in another process",
    );
    expect(owner.rows()).toEqual([expect.objectContaining({ lease_id: held })]);
    // The same boot falls through to the PID probe, whose EPERM still means "exists".
    expect(kill).toHaveBeenCalledWith(process.ppid, 0);
  });

  it.each([
    { recorded: null, current: OTHER_BOOT_ID, label: "the lease predates boot identity" },
    { recorded: OTHER_BOOT_ID, current: null, label: "the current boot id is unavailable" },
    { recorded: null, current: null, label: "neither boot id is known" },
  ])("keeps a hidden foreign lease when $label", ({ recorded, current }) => {
    const owner = createOwner();
    const held = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    rewriteOwner(owner, held, recorded);
    bootId.current = current;

    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).toEqual([
      expect.objectContaining({ lease_id: held, owner_boot_id: recorded }),
    ]);
    expect(() => assertNoOpenClawAgentDatabaseLeases("main", { env: owner.env })).toThrow(
      "database is still open in another process",
    );
  });

  it("reads and upgrades a lease table that predates boot identity", () => {
    const owner = createOwner();
    const held = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: owner.agentPath,
      env: owner.env,
    });
    rewriteOwner(owner, held, null);
    owner.state().db.exec("ALTER TABLE agent_database_leases DROP COLUMN owner_boot_id");
    closeOpenClawStateDatabaseForTest();

    expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: owner.env })).toEqual([
      expect.objectContaining({ lease_id: held, owner_boot_id: null }),
    ]);

    // Observing never migrates; the next lease write adds the column.
    const columns = () =>
      (
        owner.state().db.prepare("PRAGMA table_info(agent_database_leases)").all() as {
          name: string;
        }[]
      ).map((column) => column.name);
    expect(columns()).not.toContain("owner_boot_id");
    const next = claimOpenClawAgentDatabaseLease({
      agentId: "other",
      path: path.join(owner.env.OPENCLAW_STATE_DIR!, "agents", "other", "agent.sqlite"),
      env: owner.env,
    });
    expect(columns()).toContain("owner_boot_id");
    expect(owner.rows()).toEqual([
      expect.objectContaining({ lease_id: held, owner_boot_id: null }),
      expect.objectContaining({ lease_id: next, owner_boot_id: bootId.current }),
    ]);
  });
});
