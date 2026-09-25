import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

describe("resumed Codex session binding migration", () => {
  async function migration() {
    const contract = await loadBundledPluginFacade<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
    const sidecars = contract.stateMigrations.find(
      (entry) => entry.id === "codex-app-server-sidecars-to-plugin-state",
    );
    if (!sidecars) {
      throw new Error("Codex sidecar migration is missing from its public Doctor contract");
    }
    return sidecars;
  }

  it.each(["before", "during"] as const)(
    "honors canonical deletion %s actual plugin migration after deferred import",
    async (timing) => {
      await withOpenClawTestState({ label: `codex-deferred-deletion-${timing}` }, async (state) => {
        const { cfg, scope, originals } = seedDeferredPluginSessionSource(
          state,
          "default",
          "codex",
        );
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const remove = () =>
          deleteSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        if (timing === "before") {
          expect((await remove()).deleted).toBe(true);
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        let deletedDuringMigration = false;
        const migrationContext: typeof context =
          timing === "before"
            ? context
            : {
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
                        expect((await remove()).deleted).toBe(true);
                      }
                      return registered;
                    },
                  };
                },
              };
        const params = {
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context: migrationContext,
        };
        const result = await (await migration()).migrateLegacyState(params);
        expect(result.warnings).toEqual([]);
        if (timing === "during") {
          expect(deletedDuringMigration).toBe(true);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.agentHarnessId,
        ).toBe("codex");
        const readBindings = context.readPluginStateEntriesInKeyRange;
        if (!readBindings) {
          throw new Error("Doctor context must provide read-only plugin state inspection");
        }
        const bindings = readBindings("app-server-thread-bindings", {
          prefix: "session",
          limit: 100,
        });
        expect(bindings).toContainEqual(
          expect.objectContaining({
            value: expect.objectContaining({ sessionId: "legacy-kept", state: "active" }),
          }),
        );
        expect(
          bindings.filter(
            (entry) =>
              isRecord(entry.value) &&
              entry.value.sessionId === "legacy-deleted" &&
              entry.value.state === "active",
          ),
        ).toEqual([]);
        for (const file of originals.keys()) {
          if (file.endsWith(".codex-app-server.json")) {
            expect(fs.existsSync(file)).toBe(false);
          }
        }
        expect(await (await migration()).detectLegacyState(params)).toBeNull();
      });
    },
  );

  it.each(["default", "legacy-root"] as const)(
    "does not resurrect an imported session because an unrelated %s source is unimported",
    async (layout) => {
      await withOpenClawTestState({ label: `codex-mixed-source-${layout}` }, async (state) => {
        const { cfg, scope } = seedDeferredPluginSessionSource(state, "external", "codex");
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const directory =
          layout === "default" ? state.sessionsDir("main") : state.statePath("sessions");
        fs.mkdirSync(directory, { recursive: true });
        const unrelatedStore = path.join(directory, "sessions.json");
        const unrelatedSource = JSON.stringify({
          "agent:main:not-imported": {
            sessionId: "not-imported",
            sessionFile: "not-imported.jsonl",
            updatedAt: 1,
          },
        });
        fs.writeFileSync(unrelatedStore, unrelatedSource);
        expect(
          (
            await deleteSessionEntryLifecycle({
              ...scope,
              target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
            })
          ).deleted,
        ).toBe(true);
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        const result = await (
          await migration()
        ).migrateLegacyState({
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context,
        });
        expect(result.warnings).toEqual([]);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          await context.readSessionIdentityEvidenceBatch?.([
            { agentId: "main", sessionId: "legacy-deleted" },
            { agentId: "main", sessionId: "not-imported" },
          ]),
        ).toEqual([
          { agentId: "main", sessionId: "legacy-deleted", state: "absent" },
          { agentId: "main", sessionId: "not-imported", state: "unknown" },
        ]);
        expect(fs.readFileSync(unrelatedStore, "utf8")).toBe(unrelatedSource);
      });
    },
  );

  it.each(["legacy-index", "explicit-sqlite"] as const)(
    "imports retained legacy Codex sidecars with an existing %s session store",
    async (locator) => {
      await withOpenClawTestState(
        { label: `codex-first-sidecar-import-${locator}` },
        async (state) => {
          const { cfg, scope, storePath, originals } = seedDeferredPluginSessionSource(
            state,
            "default",
            "codex",
          );
          await upsertSessionEntryCore(
            { ...scope, sessionKey: "agent:main:unrelated" },
            { sessionId: "unrelated", updatedAt: 1 },
          );
          const config =
            locator === "explicit-sqlite"
              ? { ...cfg, session: { store: path.join(state.agentDir(), "openclaw-agent.sqlite") } }
              : cfg;
          const configuredScope = { ...scope, storePath: config.session?.store ?? scope.storePath };
          expect(
            loadExactSessionEntry({ ...configuredScope, sessionKey: "agent:main:unrelated" })?.entry
              .sessionId,
          ).toBe("unrelated");
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            config,
            env: state.env,
          });
          const params = {
            config,
            env: state.env,
            stateDir: state.stateDir,
            oauthDir: state.statePath("oauth"),
            context,
          };
          const sidecars = await migration();
          const result = await sidecars.migrateLegacyState(params);
          expect(result.warnings).toEqual([]);
          const bindings = context.readPluginStateEntriesInKeyRange?.(
            "app-server-thread-bindings",
            {
              prefix: "session",
              limit: 100,
            },
          );
          for (const name of ["kept", "deleted"]) {
            expect(
              loadExactSessionEntry({ ...configuredScope, sessionKey: `agent:main:${name}` })?.entry
                .agentHarnessId,
            ).toBe("codex");
            expect(bindings).toContainEqual(
              expect.objectContaining({
                value: expect.objectContaining({
                  state: "active",
                  sessionId: `legacy-${name}`,
                  binding: expect.objectContaining({ threadId: name }),
                }),
              }),
            );
          }
          expect(
            loadExactSessionEntry({ ...configuredScope, sessionKey: "agent:main:unrelated" })?.entry
              .sessionId,
          ).toBe("unrelated");
          expect(fs.readFileSync(storePath)).toEqual(originals.get(storePath));
          for (const file of originals.keys()) {
            if (file.endsWith(".codex-app-server.json")) {
              expect(fs.existsSync(file)).toBe(false);
              expect(fs.readFileSync(`${file}.migrated`)).toEqual(originals.get(file));
            }
          }
          expect(await sidecars.detectLegacyState(params)).toBeNull();
          expect(await sidecars.migrateLegacyState(params)).toEqual({ changes: [], warnings: [] });
        },
      );
    },
  );
});
