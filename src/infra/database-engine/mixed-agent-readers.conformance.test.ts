import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectAuthProfileEnvSecretRefIds } from "../../agents/auth-profiles/env-secret-refs.js";
import { resolveSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { prepareFreshSharedAuthStoreWriteAsync } from "../../agents/auth-profiles/shared-store-bootstrap-async.js";
import { prepareAgentAuthProfileRowsRead } from "../../agents/auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  inspectPersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import {
  updateAuthProfileStoreWithLock,
  withAuthProfileStoreAtEffect,
} from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  clearGatewayRunConfigEnvironment,
  selectGatewayRunEnvironment,
} from "../../cli/gateway-cli/pre-bootstrap.js";
import { createConfigIO } from "../../config/io.factory.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionParticipantsReadOnly } from "../../config/sessions/session-accessor.sqlite-participant-read.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { clearMissingManagedServiceEnvKeys } from "../../daemon/service-managed-env.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createAgentSchemaInspectionWorker } from "../../state/openclaw-agent-schema-inspection-worker.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { withDatabaseEngineSelection } from "./context.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

// These are owner/transport tests: both physical stores are real, including their worker opens.
describe.skipIf(!mixedAgentConnection).each(mixedAgentPairs)(
  "state=$stateEngine agent=$agentEngine readers",
  ({ stateEngine, agentEngine }) => {
    const fixture = useMixedAgentPair(stateEngine, agentEngine);

    it("cold-opens each family and preserves retained identity across close/reopen", async () => {
      const options = { agentId: "main", env: process.env };
      const state = withEngineStoreAdmission(() => openOpenClawStateDatabase());
      expect(isPostgresSqlConnection(state.db)).toBe(stateEngine === "postgres");
      const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
      expect(isPostgresSqlConnection(database.db)).toBe(agentEngine === "postgres");
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const retained = retainOpenClawAgentDatabaseReadOnly(options);
      assert(retained.found);
      expect(retained.claim.identity).toBe(identity.identity);
      expect(retained.claim.isCurrent()).toBe(true);
      retained.claim.release();
      expect(retained.claim.isCurrent()).toBe(false);
      withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(database.path));
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      await closeOpenClawStateDatabaseByPathAsync(state.path);
      const reopenedState = withEngineStoreAdmission(() => openOpenClawStateDatabase());
      expect(isPostgresSqlConnection(reopenedState.db)).toBe(stateEngine === "postgres");
      const reopened = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
      expect(readOpenClawAgentDatabaseIdentity(reopened).identity).toBe(identity.identity);
      expect(readOpenClawAgentDatabaseIdentity(reopened).incarnation).not.toBe(
        identity.incarnation,
      );
    });

    it("reads explicit and shared-main auth with warm readers and cold schema inspection", async () => {
      withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          fixture: {
            type: "api_key",
            provider: "fixture",
            keyRef: { source: "env", provider: "default", id: "MIXED_AUTH_KEY" },
          },
        },
      };
      for (const options of [
        { agentId: "main" },
        {
          agentId: withEngineStoreAdmission(() =>
            resolveAuthProfileDatabaseOwnerId(path.join(fixture.root, "explicit")),
          ),
          path: path.join(fixture.root, "explicit", "openclaw-agent.sqlite"),
        },
      ]) {
        const database = withEngineStoreAdmission(() => openOpenClawAgentDatabase(options));
        const reader = prepareAgentAuthProfileRowsRead({
          databasePath: database.path,
          agentId: options.agentId,
          env: process.env,
        });
        try {
          // Prewarm before the write; a retained transport must observe the committed update.
          expect((await reader.read()).store.status).toBe("missing");
          await updateAuthProfileStoreWithLock({
            agentDir: path.dirname(database.path),
            stateDir: fixture.root,
            saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
            updater(current) {
              current.profiles = store.profiles;
              return true;
            },
          });
          expect((await reader.read()).store).toEqual({ status: "readable", raw: store });
          await withAuthProfileStoreAtEffect(
            path.dirname(database.path),
            { inheritedAuthDir: path.dirname(database.path), externalCli: { mode: "none" } },
            async (effect) => {
              expect((await effect.read()).profiles).toEqual(store.profiles);
              effect.assertCurrent();
            },
          );
          expect(
            withEngineStoreAdmission(() =>
              inspectPersistedAuthProfileStoreRaw(path.dirname(database.path)),
            ),
          ).toEqual({ status: "readable", raw: store });
        } finally {
          await reader.dispose();
        }
        const environment = { MIXED_AUTH_KEY: "synthetic-inherited", STALE_AUTH_KEY: "stale" };
        clearMissingManagedServiceEnvKeys({
          environment,
          managedKeys: ["MIXED_AUTH_KEY", "STALE_AUTH_KEY"],
          presentKeys: [],
          preserveKeys: withEngineStoreAdmission(() =>
            collectAuthProfileEnvSecretRefIds({
              agentDirs: [path.dirname(database.path)],
              env: process.env,
            }),
          ),
        });
        expect.soft(environment).toEqual({ MIXED_AUTH_KEY: "synthetic-inherited" });
        const snapshot = await createConfigIO({
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
        const config = {
          ...snapshot.sourceConfig,
          plugins: { enabled: false },
          agents: {
            ownership: "explicit",
            entries: { main: { agentDir: path.dirname(database.path) } },
          },
        };
        const configPath = process.env.OPENCLAW_CONFIG_PATH!;
        const configBefore = fs.readFileSync(configPath);
        await withEnvAsync(
          {
            OPENCLAW_HOME: fixture.root,
            INVOCATION_ID: "mixed-auth-fixture",
            MIXED_AUTH_KEY: "synthetic-inherited",
            STALE_AUTH_KEY: "stale",
            OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "MIXED_AUTH_KEY,STALE_AUTH_KEY",
          },
          async () => {
            try {
              fs.writeFileSync(configPath, JSON.stringify(config));
              const anchorBefore = fs.readFileSync(database.path);
              // Early selection precedes runtime engine installation and must ignore ambient selection.
              expect(
                await withDatabaseEngineSelection(
                  { effectiveEngines: resolveDatabaseFamilyEngines({}) },
                  () =>
                    selectGatewayRunEnvironment({ opts: {}, runtime: createNonExitingRuntime() }),
                ),
              ).toBe(true);
              expect(process.env.MIXED_AUTH_KEY).toBe("synthetic-inherited");
              expect(process.env.STALE_AUTH_KEY).toBeUndefined();
              expect(fs.readFileSync(database.path)).toEqual(anchorBefore);
            } finally {
              clearGatewayRunConfigEnvironment();
              fs.writeFileSync(configPath, configBefore);
            }
          },
        );
        withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(database.path));
        await closeOpenClawAgentDatabaseByPathAsync(database.path);
        retireSqliteDatabaseAdmissionForPath(database.path);
        await using inspector = createAgentSchemaInspectionWorker();
        expect(
          await inspector.inspect({
            pathname: database.path,
            env: process.env,
            supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
            verifyCurrentSchemaShape: true,
            inspectOwnership: true,
            requireStartupMigrationReadiness: true,
          }),
        ).toMatchObject({
          agentSchemaMeta: {
            agentId: options.agentId,
            role: "agent",
            schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        });
        const cold = prepareAgentAuthProfileRowsRead({
          databasePath: database.path,
          agentId: options.agentId,
          env: process.env,
        });
        try {
          expect((await cold.read()).store).toEqual({ status: "readable", raw: store });
        } finally {
          await cold.dispose();
        }
      }
      expect(
        await prepareFreshSharedAuthStoreWriteAsync({
          agentDir: undefined,
          allowExplicitMain: false,
          env: process.env,
        }),
      ).toBe(true);
      expect(resolveSharedAuthStoreOwnership(process.env)).toEqual({ location: "legacy-main" });
    });

    it("reuses prewarmed transcript readers and search after committed writes and reopen", async () => {
      const target = {
        agentId: "reader",
        sessionId: "mixed-transcript",
        sessionKey: "agent:reader:mixed-transcript",
        storePath: path.join(fixture.root, "agents", "reader", "sessions", "sessions.json"),
        env: process.env,
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const reader = prepareSessionTranscriptHydration(target);
      expect((await reader.read()).snapshot.events).toEqual([]);
      await appendTranscriptMessage(target, {
        eventId: "mixed-user",
        message: { role: "user", content: "turquoise mixed pair sentinel" },
      });
      const hydrated = await reader.read();
      expect(hydrated.snapshot.events).toEqual([
        expect.objectContaining({ type: "session", id: target.sessionId }),
        expect.objectContaining({
          id: "mixed-user",
          message: expect.objectContaining({ content: "turquoise mixed pair sentinel" }),
        }),
      ]);
      const search = { ...target, query: "turquoise", sessionKeys: [target.sessionKey] };
      expect((await searchSessionTranscripts(search)).hits).toEqual([
        expect.objectContaining({ messageId: "mixed-user", sessionId: target.sessionId }),
      ]);
      const pathname = path.join(
        fixture.root,
        "agents",
        "reader",
        "agent",
        "openclaw-agent.sqlite",
      );
      withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(pathname));
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      expect((await searchSessionTranscripts(search)).hits).toEqual([
        expect.objectContaining({ messageId: "mixed-user", sessionId: target.sessionId }),
      ]);
    });

    it("records the first participant through the worker and retains contributions after reopen", async () => {
      await captureRuntimeConfigAsyncReader()();
      const scope = {
        agentId: "participant",
        sessionKey: "agent:participant:mixed",
        env: process.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: "mixed-participant", updatedAt: 1 });
      const identity = { type: "agent", id: "teammate" } as const;
      expect(await recordSessionParticipantInWorker(scope, { identity, promptedAt: 20 })).toBe(
        "inserted",
      );
      expect(await recordSessionParticipantInWorker(scope, { identity, promptedAt: 30 })).toBe(
        "updated",
      );
      const expected = [
        { identity, contributionCount: 2, firstPromptedAt: 20, lastPromptedAt: 30 },
      ];
      const read = () =>
        withEngineStoreAdmission(() => listSessionParticipantsReadOnly(scope)).get(
          scope.sessionKey,
        );
      expect(read()).toEqual(expected);
      const pathname = path.join(
        fixture.root,
        "agents",
        scope.agentId,
        "agent",
        "openclaw-agent.sqlite",
      );
      withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(pathname));
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      expect(read()).toEqual(expected);
    });
  },
);
