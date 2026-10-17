import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import {
  readDeferredPluginSessionImport,
  hasDeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  DoctorSessionSqliteMode,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { containsObjects } from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  canonicalTestPath,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

export async function importManifest(store: TestStore) {
  const imported = await importLegacyStore(store);
  const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
  const manifest = readMigrationManifest(manifestPath);
  const target = expectDefined(manifest.targets[0], "migration target");
  return { imported, manifestPath, manifest, target };
}

export function migrationManifest(report: DoctorSessionSqliteReport) {
  const file = expectDefined(report.migrationRun?.manifestPath, "migration manifest path");
  return expectDefined(readSessionSqliteMigrationManifest(file), "readable migration manifest");
}

export function archivedSource(report: DoctorSessionSqliteReport, sourcePath: string) {
  // The source has moved, but its directory still resolves temporary-root aliases.
  const canonicalSource = path.join(
    canonicalTestPath(path.dirname(sourcePath)),
    path.basename(sourcePath),
  );
  return expectDefined(
    migrationManifest(report)
      .targets.flatMap((target) => target.completedMoves)
      .find((move) => move.sourcePath === canonicalSource),
    "archived source",
  );
}

export function expectPresent(...files: string[]) {
  for (const file of files) {
    expect(fs.existsSync(file)).toBe(true);
  }
}

export function expectIssue(report: DoctorSessionSqliteReport, shape: Record<string, unknown>) {
  containsObjects(
    report.targets.flatMap((target) => target.issues),
    shape,
  );
}

export function messageEvent(
  id: string,
  role: string,
  content: string,
  parentId: string | null = null,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

export function writePrivateFile(file: string, contents: string | Uint8Array) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

export function writeJson(file: string, value: unknown, space?: number) {
  writePrivateFile(file, JSON.stringify(value, null, space));
}

export function jsonl(...events: unknown[]) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function sessionScope(store: TestStore, agentId = "main") {
  return {
    agentId,
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: store.storePath,
    env: store.env,
  };
}

export function runStoreDoctor(store: TestStore, mode: DoctorSessionSqliteMode) {
  return runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode });
}

export async function seedRetainedSource(
  state: OpenClawTestState,
  layout: "default" | "external" = "default",
  pluginId = "fixture-plugin",
) {
  const fixture = await seedDeferredPluginSessionSource(state, layout, pluginId);
  const options = { cfg: fixture.cfg, env: state.env, allAgents: true };
  const receiptParams = (target: DoctorSessionSqliteTargetReport) => ({
    cfg: fixture.cfg,
    env: state.env,
    target,
    sqlitePath: target.sqlitePath,
  });
  return {
    ...fixture,
    file: (name: string) => path.join(path.dirname(fixture.storePath), name),
    assertReady: () => assertSessionStoreMigrationComplete({ cfg: fixture.cfg, env: state.env }),
    run: (mode: DoctorSessionSqliteMode = "import") => runDoctorSessionSqlite({ ...options, mode }),
    readEntry: (sessionKey: string) => loadExactSessionEntry({ ...fixture.scope, sessionKey }),
    writeEntry: (sessionKey: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
      upsertSessionEntryCore({ ...fixture.scope, sessionKey }, entry),
    readEvents: (sessionId: string) => loadTranscriptEventsSync({ ...fixture.scope, sessionId }),
    readReceipt: (target: DoctorSessionSqliteTargetReport) =>
      readDeferredPluginSessionImport(receiptParams(target)),
    hasReceipt: (target: DoctorSessionSqliteTargetReport) =>
      hasDeferredPluginSessionImport(receiptParams(target)),
  };
}

export function withRetainedSource(
  run: (
    fixture: Awaited<ReturnType<typeof seedRetainedSource>> & { state: OpenClawTestState },
  ) => Promise<void>,
  layout: "default" | "external" = "default",
  pluginId = "fixture-plugin",
) {
  return withOpenClawTestState({ label: "doctor-retained-source" }, async (state) =>
    run({ ...(await seedRetainedSource(state, layout, pluginId)), state }),
  );
}
