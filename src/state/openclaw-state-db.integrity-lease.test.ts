import { copyFileSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseCleanClose,
  readSqliteDatabaseIntegrityVerification,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import * as integrity from "../infra/sqlite-integrity.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import * as provenance from "./openclaw-agent-db-lease-provenance.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it.each([
  { name: "a live peer", scans: 0 },
  { name: "no lease", scans: 1 },
  { name: "a dead peer", scans: 1 },
  { name: "a changed start time", scans: 1 },
  { name: "a different inode", scans: 1 },
  { name: "this process", scans: 1 },
  { name: "missing provenance", scans: 1 },
  { name: "unavailable provenance", scans: 1 },
])("admits shared state with $name", ({ name, scans }) => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("state-integrity-peer-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  renameSync(pathname, `${pathname}.seed`);
  copyFileSync(`${pathname}.seed`, pathname);
  // Exercise Linux's provenance contract on every host without a subprocess fixture.
  const fileProvenance = `fixture:${statSync(pathname).ino}`;
  vi.spyOn(provenance, "readAgentDatabaseLeaseProvenance").mockReturnValue(
    name === "unavailable provenance" ? null : fileProvenance,
  );
  const pid = name === "this process" ? process.pid : process.ppid;
  const startedAt = getFileLockProcessStartTime(pid);
  expect(startedAt).not.toBeNull();
  if (name !== "no lease") {
    using db = openNodeSqliteDatabase(pathname);
    db.prepare(
      `INSERT INTO state_leases
       (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
       VALUES ('gateway-owner', 'global', 'peer', 1, 1, ?, 1, 1)`,
    ).run(
      JSON.stringify({
        owner: {
          pid: name === "a dead peer" ? 2_147_483_647 : pid,
          host: hostname(),
          processNamespace: readGatewayLockProcessNamespace(),
          startedAt: name === "a changed start time" ? Number(startedAt) + 1 : startedAt,
        },
        port: 19483,
        mode: "foreground",
        supervisor: null,
        ...(name === "missing provenance"
          ? {}
          : {
              stateDatabaseProvenance:
                name === "a different inode" ? `${fileProvenance}:replaced` : fileProvenance,
            }),
      }),
    );
  }
  // Remove this process's seed admission and seal, as in a separate cold opener.
  revokeSqliteDatabaseAdmissionsForPath(pathname);
  const check = vi.spyOn(integrity, "assertSqliteIntegrity");

  const database = openOpenClawStateDatabase({ env });

  expect(check.mock.calls.filter(([, label]) => label === pathname)).toHaveLength(scans);
  expect(readSqliteDatabaseIntegrityVerification(requireNativeSqliteDatabase(database.db))).toEqual(
    scans ? { verifiedAt: expect.any(Number) } : undefined,
  );
  database.db.exec("INSERT INTO config_machine_state VALUES ('peer-borrow', '{}', 1)");
  closeOpenClawStateDatabaseForTest();
  if (scans === 0) {
    expect(readSqliteDatabaseCleanClose(pathname)).toBe(false);
  }
});
