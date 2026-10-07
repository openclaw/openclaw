import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoSideDataOperations } from "../config/sessions/session-incognito-side-data-contract.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { recordMessageToolRunOutcome } from "../infra/message-tool-run-outcome-store.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { settleIncognitoTrajectoryRuntimeRetention } from "../trajectory/runtime-retention.js";
import { createSqliteTrajectoryRuntimeSink } from "../trajectory/runtime-store-writer.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
} from "../trajectory/runtime-store.sqlite.js";
import { createTrajectoryEvent } from "../trajectory/runtime-store.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

function key(name: string) {
  return `agent:main:dashboard:incognito-${name}`;
}

function create(name: string, category?: string) {
  return actor.sessions.create(authority, {
    sessionKey: key(name),
    entry: {
      sessionId: name,
      updatedAt: 10_000,
      createdAt: 10_000,
      lifecycleRevision: "initial",
      incognito: true,
      ...(category ? { category } : {}),
    },
  });
}

function interceptReply(afterReply: (command: PropertyKey) => void, hideCommit = false) {
  const original = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof original>[2],
        assertCurrent?: Parameters<typeof original>[3],
        createAdmission?: Parameters<typeof original>[4],
      ) =>
        original(
          target,
          (worker) =>
            operation({
              execute: async (command, options) => {
                const result = await worker.execute(command, options);
                afterReply(command.type);
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          hideCommit && createAdmission
            ? (retained) => {
                const admitted = createAdmission(retained);
                vi.spyOn(admitted.admission, "committed", "get").mockReturnValue(undefined);
                return admitted;
              }
            : createAdmission,
        ),
    );
}

beforeAll(async () => {
  const root = tempDirs.make("incognito-side-data-");
  const target = path.join(root, "state");
  const alias = path.join(root, "state-alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  env = { OPENCLAW_STATE_DIR: alias };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});

afterAll(async () => {
  await actor?.close();
});

it.each(["target", "marker-lost-reply"])(
  "persists bound trajectory batches without caller SQL or replay (%s)",
  async (mode) => {
    const name = `trajectory-${mode}`;
    await create(name);
    let appends = 0;
    const reply = interceptReply((command) => {
      if (
        command === "session.trajectory.append" &&
        ++appends === 1 &&
        mode === "marker-lost-reply"
      ) {
        throw new Error("Synthetic trajectory reply loss");
      }
    });
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        const target = {
          agentId: actor.agentId,
          sessionId: name,
          sessionKey: key(name),
          storePath: actor.path,
        };
        const sink = await createSqliteTrajectoryRuntimeSink({
          env,
          sessionId: name,
          maxRuntimeFileBytes: 1024 * 1024,
          ...(mode === "target"
            ? { sessionTarget: target }
            : { sessionFile: formatSqliteSessionFileMarker(target) }),
        });
        assert(sink);
        const event = {
          ...createTrajectoryEvent({ type: "trajectory-first", sessionId: name }),
          sessionKey: key(name),
        };
        sink.write(event, JSON.stringify(event));
        const flushed = sink.flush();
        if (mode === "marker-lost-reply") {
          await expect(flushed).rejects.toThrow("Synthetic trajectory reply loss");
        } else {
          await flushed;
        }
        expect(sink.describeFlushState()).toBeUndefined();
        await sink.flush();
        expect(appends).toBe(1);
        sink.write({ ...event, type: "trajectory-next" }, JSON.stringify(event));
        await sink.flush();
        expect(appends).toBe(2);
      });
      expect(sql.queries).toEqual([]);
      expect(fs.existsSync(actor.path)).toBe(false);
    } finally {
      reply.mockRestore();
      sql.restore();
    }
  },
);

it("never replays a trajectory batch after an unknown actor commit outcome", async () => {
  const uncertain = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "uncertain",
    env,
    authority,
  });
  assert(uncertain);
  const sessionKey = "agent:uncertain:dashboard:incognito-trajectory";
  const sessionId = "trajectory-uncertain";
  try {
    await uncertain.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, updatedAt: 10_000, incognito: true },
    });
    await withIncognitoSessionActor(uncertain, async () => {
      const sink = await createSqliteTrajectoryRuntimeSink({
        env,
        sessionId,
        maxRuntimeFileBytes: 1024 * 1024,
        sessionTarget: {
          agentId: uncertain.agentId,
          sessionId,
          sessionKey,
          storePath: uncertain.path,
        },
      });
      assert(sink);
      let appends = 0;
      const reply = interceptReply((command) => {
        if (command === "session.trajectory.append") {
          appends++;
          throw new Error("Synthetic unknown trajectory reply");
        }
      }, true);
      try {
        const event = createTrajectoryEvent({ type: "uncertain", sessionId });
        sink.write(event, JSON.stringify(event));
        await expect(sink.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
        await expect(sink.flush()).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(appends).toBe(1);
      } finally {
        reply.mockRestore();
      }
    });
  } finally {
    await uncertain.close();
  }
});

it("refuses maintenance from a replaced source without replaying its committed trajectory append", async () => {
  const retained = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "trajectory-fence",
    env,
    authority,
  });
  assert(retained);
  const sessionKey = "agent:trajectory-fence:dashboard:incognito-source";
  const entry: SessionEntry = {
    sessionId: "trajectory-source",
    updatedAt: 10_000,
    lifecycleRevision: "initial",
    incognito: true,
  };
  const target = {
    agentId: retained.agentId,
    sessionKey,
    sessionId: entry.sessionId,
    storePath: retained.path,
  };
  try {
    await retained.sessions.create(authority, { sessionKey, entry });
    await withIncognitoSessionActor(retained, async () => {
      const sink = await createSqliteTrajectoryRuntimeSink({
        env,
        sessionId: entry.sessionId,
        sessionTarget: target,
        maxRuntimeFileBytes: 1024 * 1024,
      });
      assert(sink);
      let appended = 0;
      let deleted = 0;
      let maintenanceFailure: unknown;
      const sideData = retained.sessions.sideData;
      const observer = vi
        .spyOn(retained.sessions, "sideData")
        .mockImplementation(async (...args) => {
          const command = args[1];
          try {
            const value = await sideData(...args);
            if (command.type === "session.trajectory.append") {
              appended++;
              await replaceSessionEntry(
                { ...target, env },
                { ...entry, lifecycleRevision: "replacement" },
              );
            } else if (command.type === "session.trajectory.retention.delete") {
              deleted++;
            }
            return value;
          } catch (error) {
            if (command.type === "session.trajectory.retention.prepare") {
              maintenanceFailure = error;
            }
            throw error;
          }
        });
      try {
        const event = createTrajectoryEvent({
          type: "committed-before-replacement",
          sessionId: entry.sessionId,
        });
        sink.write(event, JSON.stringify(event));
        await sink.flush();
        expect(maintenanceFailure).toMatchObject({
          message: "Incognito trajectory source changed before persistence",
        });
        expect(deleted).toBe(0);
        expect(sink.describeFlushState()).toBeUndefined();
        await sink.flush();
        expect(appended).toBe(1);
        expect(retained.sessions.readSharing(sessionKey)?.entry?.lifecycleRevision).toBe(
          "replacement",
        );
      } finally {
        observer.mockRestore();
      }
    });
  } finally {
    await retained.close();
  }
});

it("preserves native incognito trajectory age and global-budget retention", async () => {
  const retained = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "retention",
    env,
    authority,
  });
  assert(retained);
  const native = {
    agentId: "retention-native",
    env,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "retention-native", env }),
  };
  const sessionKey = (name: string) => `agent:retention:dashboard:incognito-${name}`;
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 2 * hour);
  const names = ["current", "expired", "recent"];
  try {
    for (const name of names) {
      const entry: SessionEntry = { sessionId: name, updatedAt: now, incognito: true };
      await retained.sessions.create(authority, { sessionKey: sessionKey(name), entry });
      replaceSessionEntrySync(
        { ...native, sessionKey: `agent:retention-native:dashboard:incognito-${name}` },
        entry,
      );
      const event = createTrajectoryEvent({
        type: name,
        sessionId: name,
        ts: new Date(name === "expired" ? now - 15 * 24 * hour : now).toISOString(),
      });
      await retained.sessions.sideData(authority, {
        type: "session.trajectory.append",
        input: { sessionKey: sessionKey(name), sessionId: name, events: [event] },
      });
      appendSqliteTrajectoryRuntimeEvents({ ...native, sessionId: name }, [event]);
    }
    for (const [index, maxGlobalRuntimeBytes] of [undefined, 1].entries()) {
      clock.mockReturnValue(now + index * 2 * hour);
      const event = createTrajectoryEvent({
        type: `sweep-${index}`,
        sessionId: "current",
        ts: new Date(Date.now()).toISOString(),
      });
      appendSqliteTrajectoryRuntimeEvents(
        { ...native, sessionId: "current", maxGlobalRuntimeBytes },
        [event],
      );
      if (index === 0) {
        await withIncognitoSessionActor(retained, async () => {
          const sink = await createSqliteTrajectoryRuntimeSink({
            env,
            sessionId: "current",
            maxRuntimeFileBytes: 1024 * 1024,
            sessionTarget: {
              agentId: retained.agentId,
              storePath: retained.path,
              sessionKey: sessionKey("current"),
              sessionId: "current",
            },
          });
          assert(sink);
          sink.write(event, JSON.stringify(event));
          await sink.flush();
        });
      } else {
        await retained.sessions.sideData(authority, {
          type: "session.trajectory.append",
          input: { sessionKey: sessionKey("current"), sessionId: "current", events: [event] },
        });
        await settleIncognitoTrajectoryRuntimeRetention({
          actor: retained,
          authority,
          input: { sessionKey: sessionKey("current"), sessionId: "current", maxGlobalRuntimeBytes },
        });
      }
      const lease = new SharedArrayBuffer(4);
      Atomics.store(new Int32Array(lease), 0, 1);
      try {
        const inspected: IncognitoSideDataOperations["session.trajectory.retention.prepare"]["output"] =
          await retained.sessions.sideData(
            authority,
            {
              type: "session.trajectory.retention.prepare",
              input: {
                sessionKey: sessionKey("current"),
                sessionId: "current",
                now: Date.now() + hour,
              },
            },
            undefined,
            undefined,
            undefined,
            { trajectoryRetentionLease: lease },
          );
        assert(inspected);
        const actorRuns = inspected.snapshot.runs
          .map(({ sessionId, events }) => ({ sessionId, events }))
          .toSorted((a, b) => a.sessionId.localeCompare(b.sessionId));
        const nativeRuns = [];
        for (const sessionId of names) {
          const events = await loadSqliteTrajectoryRuntimeEvents({ ...native, sessionId });
          if (events.length) {
            nativeRuns.push({ sessionId, events: events.length });
          }
        }
        expect(actorRuns).toEqual(
          nativeRuns.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId)),
        );
        expect(actorRuns.map((run) => run.sessionId)).toEqual(
          index === 0 ? ["current", "recent"] : ["current"],
        );
      } finally {
        Atomics.store(new Int32Array(lease), 0, 0);
      }
    }
  } finally {
    clock.mockRestore();
    await retained.close();
    await closeOpenClawAgentDatabaseByPathAsync(native.storePath);
  }
});

it.each([false, true])(
  "records shared-bound message-tool outcomes without native SQL or replay (reply lost=%s)",
  async (loseReply) => {
    const name = loseReply ? "outcome-reply-loss" : "outcome";
    const sessionKey = key(name);
    await create(name);
    const snapshot = actor.sessions.captureSnapshot(sessionKey);
    let executed = 0;
    const reply = interceptReply((command) => {
      if (command === "session.messageToolOutcome.record") {
        executed++;
        if (loseReply) {
          throw new Error("Synthetic outcome reply loss");
        }
      }
    });
    const sql = observeHostDataSql();
    try {
      const recording = withIncognitoSessionActor(actor, () =>
        recordMessageToolRunOutcome({
          agentId: actor.agentId,
          sessionKey,
          runId: name,
          provider: "synthetic",
          model: "synthetic",
          outcome: "tool_delivered",
          runStatus: "completed",
          occurredAt: 10_001,
          env,
        }),
      );
      if (loseReply) {
        await expect(recording).rejects.toThrow("Synthetic outcome reply loss");
      } else {
        await expect(recording).resolves.toBeUndefined();
      }
      expect(executed).toBe(1);
      expect(() => snapshot.assertCurrent()).toThrow("snapshot changed");
      expect(actor.sessions.readSharing(sessionKey)?.entry?.sessionId).toBe(name);
      expect(
        getOpenClawAgentDatabaseIfOpen({ agentId: actor.agentId, path: actor.path, env }),
      ).toBeUndefined();
      expect(fs.existsSync(actor.path)).toBe(false);
      expect(sql.queries).toEqual([]);
    } finally {
      reply.mockRestore();
      sql.restore();
    }
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses message-tool outcome authority revoked at %s without publishing a new revision",
  async (phase) => {
    const name = `outcome-revoked-${phase}`;
    const sessionKey = key(name);
    await create(name);
    const snapshot = actor.sessions.captureSnapshot(sessionKey);
    let revoked = false;
    await expect(
      actor.sessions.sideData(
        {
          assertCurrent() {
            if (revoked) {
              throw new Error("Outcome authority revoked");
            }
          },
          authorize(stage) {
            if (stage === phase) {
              revoked = true;
            }
          },
        },
        {
          type: "session.messageToolOutcome.record",
          input: {
            run_id: name,
            session_key: sessionKey,
            agent_id: actor.agentId,
            provider: "synthetic",
            model: "synthetic",
            outcome: "mute",
            run_status: "completed",
            occurred_at: 10_001,
          },
        },
      ),
    ).rejects.toThrow("Outcome authority revoked");
    expect(revoked).toBe(true);
    expect(() => snapshot.assertCurrent()).not.toThrow();
  },
);

it("keeps readers usable after refusing a foreign sharing key", async () => {
  const sessionKey = key("foreign-key");
  await create("foreign-key");
  await expect(
    actor.sessions.sideData(authority, {
      type: "session.sharing.add",
      input: {
        sessionKey: "agent:sibling:dashboard:incognito-foreign",
        params: { identityId: "viewer", addedBy: "owner", addedAt: 12_000 },
      },
    }),
  ).rejects.toThrow("refusing non-canonical session key");
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey },
    }),
  ).toEqual([]);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.progressCard.get",
      input: { sessionKey },
    }),
  ).toBeNull();
});

it("fences every category target during grants and rolls the whole batch back before commit", async () => {
  const names = ["batch-a", "batch-b"];
  const keys = names.map(key);
  await Promise.all(names.map((name) => create(name, "batch-category")));
  let allowed = true;
  const admitted: string[] = [];
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("category authority revoked");
      }
    },
    authorize(stage, facts) {
      for (const sessionKey of keys) {
        expect(() => actor.sessions.readSharing(sessionKey)).toThrow("pending or unavailable");
      }
      if (stage === "transaction") {
        admitted.push(facts.sessionKey);
      } else {
        allowed = false;
      }
    },
  };
  await expect(
    actor.sessions.sideData(source, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).rejects.toThrow("category authority revoked");
  expect(admitted).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual(keys);
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.apply",
      input: { from: "batch-category" },
    }),
  ).toEqual(names.map((sessionId) => ({ sessionKey: key(sessionId), sessionId })));
  expect(
    await actor.sessions.sideData(authority, {
      type: "session.category.keys",
      input: { name: "batch-category" },
    }),
  ).toEqual([]);
});

it("refuses stale disclosure after read authority is revoked", async () => {
  const names = ["revoked-read-a", "revoked-read-b"];
  const keys = names.map(key);
  await Promise.all(names.map((name) => create(name, "revoked-read")));
  let allowed = true;
  let executed = 0;
  const source: IncognitoSessionAuthority = {
    assertCurrent() {
      if (!allowed) {
        throw new Error("read authority revoked");
      }
    },
  };
  const observer = interceptReply(() => {
    executed++;
    allowed = false;
  });
  try {
    await expect(
      actor.sessions.sideData(source, {
        type: "session.catalog.read",
        input: { sessionKeys: keys },
      }),
    ).rejects.toThrow("read authority revoked");
    expect(executed).toBe(1);
  } finally {
    observer.mockRestore();
  }
  const catalog = await actor.sessions.sideData(authority, {
    type: "session.catalog.read",
    input: { sessionKeys: keys },
  });
  expect(catalog.map((row) => row[1])).toEqual(["revoked-read", "revoked-read"]);
  for (const sessionKey of keys) {
    expect(actor.sessions.readSharing(sessionKey)?.entry).toBeDefined();
  }
});
