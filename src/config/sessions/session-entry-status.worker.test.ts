import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  hasSessionEntriesByStatusReadOnly,
  listSessionEntriesByStatus,
} from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { historyLane } from "./session-transcript-worker-resources.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  for (const status of ["running", "interrupted", "failed", "done"] as const) {
    writeSessionEntry(database, `agent:main:${status}`, {
      sessionId: `session-${status}`,
      status,
      updatedAt: 10,
    });
  }
  await closeOpenClawAgentDatabasesAsync();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => state.cleanup());

it("selects canonical lifecycle states in the worker without conflating interrupted and failed", async () => {
  const observer = observeParentSqlite();
  const scope = { agentId: "main", env: state.env };
  try {
    for (const status of ["interrupted", "failed", "running", "done"] as const) {
      expect(await hasSessionEntriesByStatusReadOnly(scope, [status])).toBe(true);
      expect(await listSessionEntriesByStatus(scope, [status])).toEqual([
        { sessionKey: `agent:main:${status}`, entry: expect.objectContaining({ status }) },
      ]);
    }
    expect(await hasSessionEntriesByStatusReadOnly(scope, ["killed", "timeout"])).toBe(false);
    expect(await hasSessionEntriesByStatusReadOnly(scope, [])).toBe(false);
    expect(await listSessionEntriesByStatus(scope, ["failed", "interrupted"])).toHaveLength(2);
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});

it("does not create or register missing stores and recognizes non-session state", async () => {
  const scope = { agentId: "missing", env: state.env };
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  const registered = listOpenClawRegisteredAgentDatabases({ env: state.env });
  expect(await hasSessionEntriesByStatusReadOnly(scope, ["running"])).toBe(false);
  expect(await listSessionEntriesByStatus(scope, ["running"])).toEqual([]);
  await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(listOpenClawRegisteredAgentDatabases({ env: state.env })).toEqual(registered);
  const database = openOpenClawAgentDatabase(scope);
  expect(database.db.prepare("SELECT count(*) AS total FROM session_nodes").get()).toMatchObject({
    total: 0,
  });
  await closeOpenClawAgentDatabasesAsync();
  const observer = observeParentSqlite();
  try {
    expect(await hasSessionEntriesByStatusReadOnly(scope, ["running"])).toBe(false);
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});

it("keeps unknown schemas eligible for recovery without treating them as empty", async () => {
  const scope = { agentId: "old-schema", env: state.env };
  const database = openOpenClawAgentDatabase(scope);
  database.db.exec("DROP TABLE schema_meta");
  await closeOpenClawAgentDatabasesAsync();
  expect(await hasSessionEntriesByStatusReadOnly(scope, ["running"])).toBe(true);
  await expect(listSessionEntriesByStatus(scope, ["running"])).rejects.toThrow();
});

it("keeps process-held incognito status reads on their native owner", async () => {
  const scope = { agentId: "main", env: state.env };
  const storePath = resolveIncognitoOpenClawAgentSqlitePath(scope);
  const database = openOpenClawAgentDatabase({ ...scope, path: storePath });
  const sessionKey = "agent:main:incognito:status";
  writeSessionEntry(database, sessionKey, {
    sessionId: "private",
    updatedAt: 1,
    status: "running",
    incognito: true,
  });
  expect(await hasSessionEntriesByStatusReadOnly({ ...scope, storePath }, ["running"])).toBe(true);
  expect(await listSessionEntriesByStatus({ ...scope, storePath }, ["running"])).toMatchObject([
    { sessionKey, entry: { sessionId: "private", incognito: true } },
  ]);
});

it("propagates worker rejection without falling back to host SQLite", async () => {
  const failure = new Error("status worker refused");
  vi.spyOn(historyLane.pool, "run").mockRejectedValueOnce(failure);
  const observer = observeParentSqlite();
  try {
    await expect(
      listSessionEntriesByStatus({ agentId: "main", env: state.env }, ["running"]),
    ).rejects.toBe(failure);
    expect(observer.counts).toEqual(emptySqliteCounts());
  } finally {
    observer.restore();
  }
});

it("rejects a delayed status result when the captured database is replaced", async () => {
  const storePath = state.statePath("delayed", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyLane.pool.run.bind(historyLane.pool);
  vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    if (
      reply.ok &&
      typeof reply.value === "object" &&
      !Array.isArray(reply.value) &&
      "kind" in reply.value &&
      reply.value.kind === "session-exact-entries"
    ) {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  const pending = hasSessionEntriesByStatusReadOnly(
    { agentId: "main", env: state.env, storePath },
    ["running"],
  );
  const outcome = pending.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Status read was not dispatched");
    await fs.writeFile(storePath, "replacement source");
    release.resolve();
    await expect(pending).rejects.toThrow(/identity|changed|replaced/i);
  } finally {
    release.resolve();
    await outcome;
    await fs.unlink(storePath).catch(() => {});
  }
});

it("refuses status listings when admission is revoked during their worker read", async () => {
  const scope = { agentId: "main", env: state.env };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyLane.pool.run.bind(historyLane.pool);
  vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    if (
      reply.ok &&
      typeof reply.value === "object" &&
      !Array.isArray(reply.value) &&
      "kind" in reply.value &&
      reply.value.kind === "session-exact-entries"
    ) {
      entered.resolve();
      await release.promise;
    }
    return reply;
  });
  const pending = listSessionEntriesByStatus(scope, ["running"]);
  const outcome = pending.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Status read was not dispatched");
    recordAgentDatabaseAdmissions(
      [
        createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: [resolveOpenClawAgentSqlitePath(scope)],
          reason: "recovery admission revoked",
        }),
      ],
      { env: state.env },
    );
    release.resolve();
    await expect(pending).rejects.toThrow("recovery admission revoked");
    await expect(listSessionEntriesByStatus(scope, ["running"])).rejects.toThrow(
      "recovery admission revoked",
    );
  } finally {
    release.resolve();
    await outcome;
    recordAgentDatabaseAdmissions([], { env: state.env });
  }
});
