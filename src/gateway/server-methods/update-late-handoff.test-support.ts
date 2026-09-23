import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import * as handoffLease from "../../infra/update-managed-service-handoff-lease.js";
import * as statePaths from "../../state/openclaw-state-db.paths.js";
import { drainSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

// These RPC tests mock helper execution, but use real state-ledger and report readers.
// The shared harness owns the private state home and drains/closes its SQLite handles.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const resolveStatePath = statePaths.resolveOpenClawStateSqlitePath;
let restorePaths: (() => void) | undefined;
beforeEach(async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-late-handoff-"));
  const handoff = path.join(root, "handoffs.sqlite");
  // Harness setup follows this hook. Assert isolation at each actual state access,
  // retaining the canonical path/parent contract instead of returning an unrelated DB.
  const stateResolver = vi
    .spyOn(statePaths, "resolveOpenClawStateSqlitePath")
    .mockImplementation((env = process.env) => {
      const stateDir = expectDefined(env.OPENCLAW_STATE_DIR, "private RPC state directory");
      const physicalRoot = resolvePathViaExistingAncestorSync(stateDir);
      expect(physicalRoot).toContain("openclaw-update-rpc-");
      const state = resolveStatePath(env);
      expect(resolvePathViaExistingAncestorSync(state)).toBe(
        path.join(physicalRoot, "state", "openclaw.sqlite"),
      );
      return state;
    });
  const handoffResolver = vi
    .spyOn(handoffLease, "resolveManagedUpdateLeaseDatabasePath")
    .mockReturnValue(handoff);
  restorePaths = () => {
    stateResolver.mockRestore();
    handoffResolver.mockRestore();
  };
  expect(
    resolvePathViaExistingAncestorSync(handoffLease.resolveManagedUpdateLeaseDatabasePath()),
  ).toBe(handoff);
  const sharedRoots = [path.join(os.tmpdir(), "openclaw")];
  if (process.platform !== "win32") {
    sharedRoots.push("/tmp/openclaw");
  }
  for (const shared of sharedRoots) {
    expect(handoff).not.toBe(
      resolvePathViaExistingAncestorSync(path.join(shared, "managed-update-handoffs.sqlite")),
    );
  }
});
afterEach(async () => {
  try {
    await drainSessionStateForTest();
  } finally {
    restorePaths?.();
    restorePaths = undefined;
  }
});
