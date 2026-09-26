import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as workerContext from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import { loadConfiguredHostedOfficialExternalPluginCatalogEntries } from "./official-external-plugin-catalog.js";

it("captures Windows environment semantics and explicit state-directory overrides per operation", async () => {
  const captureContext = workerContext.captureOpenClawStateWorkerContext;
  const captured: Array<{
    context: ReturnType<typeof captureContext>;
    env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const stopped = new Error("stop after the actual producer captures its context");
  const capture = vi
    .spyOn(workerContext, "captureOpenClawStateWorkerContext")
    .mockImplementation((options = {}) => {
      captured.push({ context: captureContext(options), env: options.env });
      throw stopped;
    });
  try {
    await withMockedWindowsPlatform(async () => {
      const initialRoot = path.resolve("synthetic-initial-state");
      const firstRoot = path.resolve("synthetic-first-state");
      const laterRoot = path.resolve("synthetic-later-state");
      const env = {
        openclaw_state_dir: initialRoot,
        openclaw_supervisor_mode: "external",
      };
      const options = {
        env,
        stateDir: firstRoot,
        stateDatabasePath: path.resolve("synthetic-catalog.sqlite"),
      };
      const store = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);
      const snapshot = {
        body: "{}",
        metadata: { url: "https://catalog.example.test/feed", status: 200, checksum: "fixture" },
        savedAt: "2026-09-16T00:00:00.000Z",
      };
      await expect(store.write(snapshot)).rejects.toBe(stopped);
      expect(captured[0]?.context.environment).toEqual({
        OPENCLAW_STATE_DIR: firstRoot,
        OPENCLAW_SUPERVISOR_MODE: "external",
      });
      expect(
        Object.keys(captured[0]?.env ?? {}).filter(
          (key) => key.toUpperCase() === "OPENCLAW_STATE_DIR",
        ),
      ).toHaveLength(1);
      expect(env.openclaw_state_dir).toBe(initialRoot);

      options.stateDir = laterRoot;
      env.openclaw_supervisor_mode = "internal";
      await expect(store.write(snapshot)).rejects.toBe(stopped);
      expect(captured[1]?.context.environment).toEqual({ OPENCLAW_STATE_DIR: laterRoot });
      expect(captured[0]?.context.environment.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    });
  } finally {
    capture.mockRestore();
  }
});

it("persists captured snapshots and serves the offline catalog without parent SQL", async () => {
  await withOpenClawTestState({ label: "hosted-catalog-worker" }, async (state) => {
    const options = { env: { ...state.env } };
    const store = createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(options);
    const url = "https://catalog.example.test/feed";
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "catalog-worker-proof",
      generatedAt: "2026-09-16T00:00:00.000Z",
      sequence: 1,
      entries: [
        {
          name: "@fixture/catalog-worker",
          openclaw: {
            plugin: { id: "catalog-worker" },
            install: { sourceRef: "fixture", npmSpec: "@fixture/catalog-worker" },
          },
        },
      ],
    });
    const snapshot = {
      body,
      metadata: {
        url,
        status: 200,
        checksum: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      },
      savedAt: "2026-09-16T00:00:00.000Z",
    };
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();

      await expect(store.read(url)).resolves.toBeNull();
      expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
      const pending = store.write(snapshot);
      snapshot.body = "changed after admission";
      snapshot.metadata.url = "https://catalog.example.test/changed";
      options.env.OPENCLAW_STATE_DIR = state.path("later-state");
      await pending;

      const loaded = await loadConfiguredHostedOfficialExternalPluginCatalogEntries({
        env: state.env,
        offline: true,
        feedProfile: "fixture",
        catalogConfig: {
          feeds: { fixture: { url, feedId: "catalog-worker-proof" } },
          sources: { fixture: { type: "npm", registry: "https://catalog.example.test/npm" } },
        },
      });
      expect(loaded).toMatchObject({
        source: "hosted-snapshot",
        entries: [{ name: "@fixture/catalog-worker" }],
        snapshot: { body, metadata: { url } },
      });
      await expect(store.read(url)).resolves.toBeNull();
      expect(existsSync(resolveOpenClawStateSqlitePath(options.env))).toBe(false);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});
