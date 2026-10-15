import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSqliteMutationWorkerLifetime } from "../config/sessions/session-accessor.sqlite-worker-request.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createCronStoreHarness, writeCronStoreSnapshot } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-harness-" });
let previousStorePath: string | undefined;

function testJob() {
  return {
    id: "job-1",
    name: "Test job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every" as const, everyMs: 60_000 },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    payload: { kind: "systemEvent" as const, text: "tick" },
    state: {},
  };
}

describe("createCronStoreHarness", () => {
  it("tracks stores that callers do not explicitly clean", async () => {
    const store = await makeStorePath();
    previousStorePath = store.storePath;
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });
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
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [testJob()] });
    const dir = path.dirname(path.dirname(store.storePath));
    const siblingDir = path.dirname(path.dirname(sibling.storePath));
    const sessionStorePath = path.join(dir, "cron", "sessions", "sessions.json");
    const mainOptions = {
      agentId: "main",
      path: path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite"),
    };
    const databaseOptions = [
      mainOptions,
      {
        agentId: "worker",
        path: path.join(path.dirname(sessionStorePath), "openclaw-agent.worker.sqlite"),
      },
    ];
    for (const { agentId } of databaseOptions) {
      await replaceSessionEntry(
        { agentId, storePath: sessionStorePath, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-harness`, updatedAt: Date.now() },
      );
    }
    const databases = databaseOptions.map((options) => openOpenClawAgentDatabase(options));
    const siblingOptions = { agentId: "main", path: path.join(siblingDir, "sibling.sqlite") };
    const siblingScope = {
      agentId: "main",
      storePath: siblingOptions.path,
      sessionKey: "agent:main:sibling",
    };
    await replaceSessionEntry(siblingScope, { sessionId: "sibling", updatedAt: Date.now() });
    const siblingDatabase = openOpenClawAgentDatabase(siblingOptions);
    const entered = createDeferredCore();
    const revoked = createDeferredCore();
    const release = createDeferredCore();
    const retained = withSqliteMutationWorkerLifetime(
      { ...mainOptions, path: await fs.realpath(mainOptions.path) },
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
      expect(databases.map(({ db }) => db.isOpen)).toEqual([false, false]);
      await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(siblingDatabase.db.isOpen).toBe(true);
      expect(loadSessionEntry(siblingScope)?.sessionId).toBe("sibling");
    } finally {
      release.resolve();
      await Promise.all([retained, cleanup]);
      await closeOpenClawAgentDatabasesAsync(dir);
      await closeOpenClawAgentDatabasesAsync(siblingDir);
    }
  });
});
