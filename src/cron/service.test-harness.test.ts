import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSqliteMutationWorkerLifetime } from "../config/sessions/session-accessor.sqlite-worker-request.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import { createCronStoreHarness, writeCronStoreSnapshot } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-harness-" });
const jobs = [cronTestJob({ id: "job-1" })];
let previousStorePath: string | undefined;

async function openSession(storePath: string, agentId: string, sessionId = agentId) {
  const scope = { agentId, storePath, sessionKey: `agent:${agentId}:main` };
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  const target = await prepareSqliteTargetFromSessionStorePath(storePath, { agentId });
  const options = { agentId, path: target.path };
  return { scope, options, ...agentDb.openOpenClawAgentDatabase(options) };
}

it("tracks stores that callers do not explicitly clean", async () => {
  const store = await makeStorePath();
  previousStorePath = store.storePath;
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  expect((await loadCronStore(store.storePath)).jobs).toHaveLength(1);
});

it("clears tracked SQLite rows after each test", async () => {
  if (!previousStorePath) {
    throw new Error("expected previous test store path");
  }
  expect((await loadCronStore(previousStorePath)).jobs).toEqual([]);
});

it("settles case-owned session work before removing its directory and preserves sibling stores", async () => {
  const store = await makeStorePath();
  const sibling = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  const dir = path.dirname(path.dirname(store.storePath));
  const siblingDir = path.dirname(path.dirname(sibling.storePath));
  const sessionStorePath = path.join(dir, "cron", "sessions", "sessions.json");
  const main = await openSession(sessionStorePath, "main");
  const worker = await openSession(sessionStorePath, "worker");
  const siblingPath = path.join(siblingDir, "sibling.sqlite");
  const siblingSession = await openSession(siblingPath, "main", "sibling");
  const entered = createDeferredCore();
  const revoked = createDeferredCore();
  const release = createDeferredCore();
  const retained = withSqliteMutationWorkerLifetime(
    { ...main.options, path: await fs.realpath(main.options.path) },
    async ({ signal }) => {
      signal.addEventListener("abort", () => revoked.resolve(), { once: true });
      entered.resolve();
      await release.promise;
    },
  );
  await entered.promise;
  let removed = false;
  const cleanup = store.cleanup().then(() => {
    removed = true;
  });
  try {
    expect(
      await Promise.race([revoked.promise.then(() => "revoked"), cleanup.then(() => "removed")]),
    ).toBe("revoked");
    expect(removed).toBe(false);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    release.resolve();
    await retained;
    await cleanup;
    await store.cleanup();
    expect((await loadCronStore(store.storePath)).jobs).toEqual([]);
    expect([main.db.isOpen, worker.db.isOpen]).toEqual([false, false]);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(siblingSession.db.isOpen).toBe(true);
    expect(loadSessionEntry(siblingSession.scope)?.sessionId).toBe("sibling");
  } finally {
    release.resolve();
    await Promise.all([retained, cleanup]);
    await agentDb.closeOpenClawAgentDatabasesAsync(dir);
    await agentDb.closeOpenClawAgentDatabasesAsync(siblingDir);
  }
});
