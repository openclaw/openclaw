import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withRetainedSource,
  type seedRetainedSource,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectMissing,
  expectFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";

async function migration() {
  const { stateMigrations } = await loadBundledPluginFacade<{
    stateMigrations: PluginDoctorStateMigration[];
  }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
  return expectDefined(
    stateMigrations.find(({ id }) => id === "codex-app-server-sidecars-to-plugin-state"),
    "Codex sidecar migration",
  );
}

function migrationParams(
  state: OpenClawTestState,
  config: Parameters<typeof createPluginDoctorStateMigrationContext>[0]["config"],
  context = createPluginDoctorStateMigrationContext({ pluginId: "codex", config, env: state.env }),
) {
  return {
    config,
    env: state.env,
    stateDir: state.stateDir,
    oauthDir: state.statePath("oauth"),
    context,
  };
}

function deleteImportedSession(scope: Awaited<ReturnType<typeof seedRetainedSource>>["scope"]) {
  return deleteSessionEntryLifecycle({
    ...scope,
    target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
  });
}

const withCodex = (run: Parameters<typeof withRetainedSource>[0]) =>
  withRetainedSource(run, "default", "codex");

function readBindings(context: ReturnType<typeof createPluginDoctorStateMigrationContext>) {
  return expectDefined(context.readPluginStateEntriesInKeyRange, "plugin state reader")(
    "app-server-thread-bindings",
    { prefix: "session", limit: 100 },
  );
}

function expectSidecarsArchived(originals: Map<string, Buffer>, checkBackup = false) {
  for (const [file, bytes] of originals) {
    if (file.endsWith(".codex-app-server.json")) {
      expectMissing(file);
      if (checkBackup) {
        expectFiles(bytes, `${file}.migrated`);
      }
    }
  }
}

it("honors canonical deletion during plugin migration after deferred import", () =>
  withCodex(async ({ state, cfg, scope, originals, run, readEntry }) => {
    await run("import");
    const { context } = migrationParams(state, cfg);
    let deletedDuringMigration = false;
    const migrationContext: typeof context = {
      ...context,
      openPluginStateKeyedStore<T>(
        options: Parameters<typeof context.openPluginStateKeyedStore>[0],
      ) {
        const store = context.openPluginStateKeyedStore<T>(options);
        return {
          ...store,
          async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
            const registered = await store.registerIfAbsent(...args);
            const binding = args[1];
            if (
              !deletedDuringMigration &&
              isRecord(binding) &&
              binding.sessionId === "legacy-deleted"
            ) {
              deletedDuringMigration = true;
              expect((await deleteImportedSession(scope)).deleted).toBe(true);
            }
            return registered;
          },
        };
      },
    };
    const params = migrationParams(state, cfg, migrationContext);
    const result = await (await migration()).migrateLegacyState(params);
    expect(result.warnings).toEqual([]);
    expect(deletedDuringMigration).toBe(true);
    expect(readEntry("agent:main:deleted")).toBeUndefined();
    expect(readEntry("agent:main:kept")?.entry.agentHarnessId).toBe("codex");
    const bindings = readBindings(context);
    containsObjects(bindings, {
      value: expect.objectContaining({ sessionId: "legacy-kept", state: "active" }),
    });
    expect(
      bindings.some(
        ({ value }) =>
          isRecord(value) && value.sessionId === "legacy-deleted" && value.state === "active",
      ),
    ).toBe(false);
    expectSidecarsArchived(originals);
    expect(await (await migration()).detectLegacyState(params)).toBeNull();
  }));

it("does not resurrect an imported session because an unrelated configured source is unimported", () =>
  withCodex(async ({ state, cfg, scope, readEntry }) => {
    cfg.session = { store: state.path("configured-sessions/{agentId}/sessions.json") };
    await runDoctorSessionSqlite({
      cfg,
      env: state.env,
      store: scope.storePath,
      agent: "main",
      mode: "import",
    });
    const unrelatedStore = state.path("configured-sessions/main/sessions.json");
    fs.mkdirSync(path.dirname(unrelatedStore), { recursive: true });
    const unrelatedSource =
      '{"agent:main:not-imported":{"sessionId":"not-imported","sessionFile":"not-imported.jsonl","updatedAt":1}}';
    fs.writeFileSync(unrelatedStore, unrelatedSource);
    expect((await deleteImportedSession(scope)).deleted).toBe(true);
    const params = migrationParams(state, cfg);
    const result = await (await migration()).migrateLegacyState(params);
    expect(result.warnings).toEqual([]);
    expect(readEntry("agent:main:deleted")).toBeUndefined();
    expect(
      await params.context.readSessionIdentityEvidenceBatch?.([
        { agentId: "main", sessionId: "legacy-deleted" },
        { agentId: "main", sessionId: "not-imported" },
      ]),
    ).toEqual([
      { agentId: "main", sessionId: "legacy-deleted", state: "absent" },
      { agentId: "main", sessionId: "not-imported", state: "unknown" },
    ]);
    expectFiles(unrelatedSource, unrelatedStore);
  }));

it("imports retained legacy Codex sidecars with an existing explicit SQLite session store", () =>
  withCodex(async ({ state, cfg, scope, storePath, originals, writeEntry }) => {
    await writeEntry("agent:main:unrelated", { sessionId: "unrelated", updatedAt: 1 });
    const config = {
      ...cfg,
      session: { store: path.join(state.agentDir(), "openclaw-agent.sqlite") },
    };
    const configuredScope = { ...scope, storePath: config.session.store };
    const entry = (name: string) =>
      loadExactSessionEntry({ ...configuredScope, sessionKey: `agent:main:${name}` })?.entry;
    expect(entry("unrelated")?.sessionId).toBe("unrelated");
    const params = migrationParams(state, config);
    const sidecars = await migration();
    const result = await sidecars.migrateLegacyState(params);
    expect(result.warnings).toEqual([]);
    const bindings = readBindings(params.context);
    for (const name of ["kept", "deleted"]) {
      expect(entry(name)?.agentHarnessId).toBe("codex");
      containsObjects(bindings, {
        value: expect.objectContaining({
          state: "active",
          sessionId: `legacy-${name}`,
          binding: expect.objectContaining({ threadId: name }),
        }),
      });
    }
    expect(entry("unrelated")?.sessionId).toBe("unrelated");
    expectFiles(originals.get(storePath), storePath);
    expectSidecarsArchived(originals, true);
    expect(await sidecars.detectLegacyState(params)).toBeNull();
    expect(await sidecars.migrateLegacyState(params)).toEqual({ changes: [], warnings: [] });
  }));
