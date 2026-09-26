import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const processIdentity = vi.hoisted(() => ({
  startedAt: 200 as number | null,
  dead: false,
  real: false,
}));

vi.mock("../shared/pid-alive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/pid-alive.js")>();
  return {
    ...actual,
    getFileLockProcessStartTime: (pid: number) =>
      processIdentity.real ? actual.getFileLockProcessStartTime(pid) : processIdentity.startedAt,
    isPidDefinitelyDead: (pid: number) =>
      processIdentity.real ? actual.isPidDefinitelyDead(pid) : processIdentity.dead,
  };
});

const tempDirs: string[] = [];
const isWindows = process.platform === "win32";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

function createLease(
  openedAt: number,
  recordedStartTime: number | null = null,
): {
  env: NodeJS.ProcessEnv;
  leaseId: string;
} {
  const stateDir = makeTempDir(tempDirs, "agent-db-lease-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const leaseId = claimOpenClawAgentDatabaseLease({
    agentId: "worker-1",
    path: path.join(stateDir, "worker-1.sqlite"),
    env,
  });
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          "UPDATE agent_database_leases SET owner_start_time = ?, opened_at = ? WHERE lease_id = ?",
        )
        .run(recordedStartTime, openedAt, leaseId),
    { env },
  );
  return { env, leaseId };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  processIdentity.startedAt = 200;
  processIdentity.dead = false;
  processIdentity.real = false;
  vi.restoreAllMocks();
});

describe("agent database lease recovery", () => {
  it("preserves a live legacy owner when the wall clock moved backwards before opening", () => {
    const { env, leaseId } = createLease(100);

    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
        .get(leaseId),
    ).toBeDefined();
  });

  it("keeps a legacy lease when the live PID could still own it", () => {
    const { env, leaseId } = createLease(300);

    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );

    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });

  it.each([100, 300])("reclaims a proven replacement independently of opened_at=%i", (openedAt) => {
    const { env, leaseId } = createLease(openedAt, 150);

    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
        .get(leaseId),
    ).toBeUndefined();
  });

  it("preserves a matching identity despite backward wall-clock ordering", () => {
    const { env, leaseId } = createLease(100, 200);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
  });

  it.each([null, 150])(
    "preserves recorded identity %s when the current identity is unavailable",
    (recorded) => {
      const { env, leaseId } = createLease(100, recorded);
      processIdentity.startedAt = null;
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    },
  );

  it("reclaims a legacy lease after its owner is definitely dead", () => {
    const { env, leaseId } = createLease(100);
    processIdentity.dead = true;
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
        .get(leaseId),
    ).toBeUndefined();
  });

  it.skipIf(!isWindows)(
    "keeps a real Windows owner across a rollback and permits explicit release",
    () => {
      processIdentity.real = true;
      const startTime = getFileLockProcessStartTime(process.pid);
      expect(startTime).not.toBeNull();
      if (startTime === null) {
        throw new Error("Real Windows process identity is unavailable");
      }
      // Fault only the lease-opening clock, never the OS process identity or host clock.
      const clock = vi.spyOn(Date, "now").mockReturnValue(startTime - 60_000);
      let lease: ReturnType<typeof createLease>;
      try {
        lease = createLease(Date.now());
      } finally {
        clock.mockRestore();
      }
      const { env, leaseId } = lease;
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
          .get(leaseId),
      ).toBeDefined();
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    },
  );
});
