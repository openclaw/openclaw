/**
 * Delegated execution ownership is rehydrated by the real database preflight
 * that certifies Gateway startup and restart.
 *
 * These tests enter through the production Host seam the Gateway actually uses,
 * assertOpenClawDatabasesReady(), and never call the ownership subsystem as the
 * entry point. They are not a standalone "startup helper" test: the preflight
 * sequence, the canonical state database read, the rehydration step, and the
 * enforcement-floor guard are all exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DelegatedExecutionOwnershipDowngradeError,
  DelegatedExecutionOwnershipRehydrationError,
  prepareDelegatedExecutionOwnershipStartup,
} from "../delegation/delegated-execution-ownership-recovery.js";
import { listOwnershipEvents } from "../delegation/delegated-execution-ownership-store.js";
import { acquireDelegatedExecutionOwnership } from "../delegation/delegated-execution-ownership.js";
import { DELEGATED_EXECUTION_OWNERSHIP_TABLE } from "../delegation/delegated-execution-ownership.schema.js";
import { DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION } from "../delegation/delegated-execution-ownership.types.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

// Keep every production behavior and record that the real preflight reached it.
vi.mock("../delegation/delegated-execution-ownership-recovery.js", { spy: true });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-delegated-") };
});

afterEach(() => closeOpenClawStateDatabaseForTest());

const config = { agents: { list: [] } } as unknown as OpenClawConfig;

function seedLock(delegationRef: string): void {
  acquireDelegatedExecutionOwnership({
    delegationRef,
    ownerKind: "plugin",
    ownerId: "delegate-plugin",
    taskScopeRef: "task:" + delegationRef,
    lineageRef: "lineage:" + delegationRef,
    options: { env },
  });
}

/** Mutate the canonical state database exactly as a corrupt artifact would. */
function mutateLiveRow(delegationRef: string, sql: string, ...params: unknown[]): void {
  const opened = openOpenClawStateDatabase({ env });
  try {
    opened.db.exec("PRAGMA ignore_check_constraints = ON;");
    opened.db.prepare(sql).run(...(params as never[]));
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function readLiveRow(
  delegationRef: string,
): { state: string; revision: number; released_at: number | null } | undefined {
  const opened = openOpenClawStateDatabase({ env });
  try {
    return opened.db
      .prepare(
        "SELECT state, revision, released_at FROM " +
          DELEGATED_EXECUTION_OWNERSHIP_TABLE +
          " WHERE delegation_ref = ?",
      )
      .get(delegationRef) as
      | { state: string; revision: number; released_at: number | null }
      | undefined;
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function ready(operation: "gateway-startup" | "gateway-restart") {
  return assertOpenClawDatabasesReady({ env, config, operation });
}

describe("database preflight — delegated execution ownership rehydration", () => {
  it("TEST 1: certifies startup only after rehydration and keeps the live lock", async () => {
    seedLock("delegation:preflight-1");
    closeOpenClawStateDatabaseForTest();
    vi.clearAllMocks();

    await expect(ready("gateway-startup")).resolves.toBeUndefined();

    // The real preflight reached the Host rehydration primitive before it
    // certified readiness, and the retained reservation is still DELEGATED_LOCKED.
    expect(prepareDelegatedExecutionOwnershipStartup).toHaveBeenCalledTimes(1);
    expect(readLiveRow("delegation:preflight-1")).toEqual({
      state: "DELEGATED_LOCKED",
      revision: 1,
      released_at: null,
    });
  });

  it("TEST 2: rejects startup when a live delegated ownership row is corrupt", async () => {
    seedLock("delegation:preflight-2");
    // revision >= 1 is a canonical constraint; a real corrupt artifact violates it.
    mutateLiveRow(
      "delegation:preflight-2",
      "UPDATE " +
        DELEGATED_EXECUTION_OWNERSHIP_TABLE +
        " SET revision = 0 WHERE delegation_ref = ?",
      "delegation:preflight-2",
    );

    await expect(ready("gateway-startup")).rejects.toBeInstanceOf(
      DelegatedExecutionOwnershipRehydrationError,
    );
    await expect(ready("gateway-restart")).rejects.toThrow(/corrupt/);
  });

  it("TEST 3: rejects startup when the enforcement floor is newer than this Host", async () => {
    seedLock("delegation:preflight-3");
    mutateLiveRow(
      "delegation:preflight-3",
      "UPDATE " +
        DELEGATED_EXECUTION_OWNERSHIP_TABLE +
        " SET enforcement_floor = ? WHERE delegation_ref = ?",
      DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION + 1,
      "delegation:preflight-3",
    );

    await expect(ready("gateway-startup")).rejects.toBeInstanceOf(
      DelegatedExecutionOwnershipDowngradeError,
    );
    await expect(ready("gateway-startup")).rejects.toThrow(/requires enforcement version/);
  });

  it("TEST 4: restart keeps a valid live lock and produces no release", async () => {
    seedLock("delegation:preflight-4");
    closeOpenClawStateDatabaseForTest();

    await expect(ready("gateway-restart")).resolves.toBeUndefined();

    expect(readLiveRow("delegation:preflight-4")).toEqual({
      state: "DELEGATED_LOCKED",
      revision: 1,
      released_at: null,
    });
    const events = listOwnershipEvents(
      openOpenClawStateDatabase({ env }).db,
      "delegation:preflight-4",
    );
    expect(events.map((event) => event.event)).toEqual(["DELEGATION_ESTABLISHED"]);
    expect(events.some((event) => event.to_state === "RELEASED")).toBe(false);
    closeOpenClawStateDatabaseForTest();
  });

  it("fails closed when the published schema lost the delegated ownership registry", async () => {
    seedLock("delegation:preflight-5");
    const opened = openOpenClawStateDatabase({ env });
    opened.db.exec("DROP TABLE " + DELEGATED_EXECUTION_OWNERSHIP_TABLE + ";");
    opened.db.exec("DROP TABLE delegated_execution_ownership_events;");
    closeOpenClawStateDatabaseForTest();

    await expect(ready("gateway-startup")).rejects.toThrow();
  });
});
