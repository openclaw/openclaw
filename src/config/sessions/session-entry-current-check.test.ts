import "../../test-utils/prepare-compiled-subprocesses.js";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import type { PreparedSessionSourceAuthority } from "./session-source-authority.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = createTempDirTracker();

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
});

it("keeps prepared entry authority current through native and worker writes without host SQL", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("entry-current-publication-") };
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:entry-current",
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
  const initial: InternalSessionEntry = {
    sessionId: "original",
    updatedAt: 1,
    execHost: "node",
    execNode: "original-node",
  };
  replaceSessionEntrySync(scope, initial);
  type Prepared = Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>;
  const prepared: Prepared[] = [];
  const sources = new Map<Prepared, PreparedSessionSourceAuthority>();
  const capture = async (fields?: ("execHost" | "execNode")[]) => {
    const check = await captureSessionEntryCurrentCheckAsyncInternal({ ...scope, fields });
    prepared.push(check);
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      sources.set(check, await check.source.prepareSessionSource());
      expect(requests).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
    }
    return check;
  };
  const expectCurrent = async (check: Prepared, current: boolean) => {
    const sql = observeHostDataSql();
    try {
      if (current) {
        expect(() => check.source()).not.toThrow();
        expect(() => sources.get(check)!.assertCurrent()).not.toThrow();
      } else {
        expect(() => check.source()).toThrow("selected session changed");
        expect(() => sources.get(check)!.assertCurrent()).toThrow("selected session changed");
      }
      await expect(check.isCurrent()).resolves.toBe(current);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  };
  try {
    const generation = await capture();
    const policy = await capture(["execHost", "execNode"]);
    policy.entry!.execNode = "caller-local-edit";
    await expectCurrent(policy, true);
    const released = await policy.source.prepareSessionSource();
    await released.release?.();
    // A mutation borrows the selected entry; finishing it does not revoke its caller.
    await expectCurrent(policy, true);

    replaceSessionEntrySync(scope, { ...initial, displayName: "Native metadata edit" });
    await expectCurrent(policy, true);
    await expectCurrent(generation, true);

    await patchSessionEntryCore(scope, () => ({ displayName: "Worker metadata edit" }), {
      skipMaintenance: true,
    });
    await expectCurrent(policy, true);
    await expectCurrent(generation, true);

    // Final effect guards must observe revocation after awaited owner work.
    await patchSessionEntryCore(scope, () => ({ execNode: "replacement-node" }), {
      skipMaintenance: true,
    });
    await expectCurrent(policy, false);
    await expectCurrent(generation, true);

    replaceSessionEntrySync(scope, { ...initial, sessionId: "replacement", updatedAt: 2 });
    await expectCurrent(generation, false);
    const replacement = await capture();
    await expectCurrent(replacement, true);
    await expect(
      deleteSessionEntryLifecycle({
        ...scope,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      }),
    ).resolves.toMatchObject({ deleted: true });
    await expectCurrent(replacement, false);

    const absent = await capture();
    expect(absent.entry).toBeUndefined();
    await expectCurrent(absent, true);
    await replaceSessionEntry(scope, { ...initial, sessionId: "created-again", updatedAt: 3 });
    await expectCurrent(absent, false);
    const latest = await capture();
    latest.release();
    await expectCurrent(latest, false);
  } finally {
    for (const check of prepared) {
      check.release();
      await sources.get(check)?.release?.();
    }
  }
});
