import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.transcript.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  captureSessionUpstreamLinkReadSource,
  readCurrentSessionUpstreamLink,
} from "../../sessions/session-upstream-links-runtime.js";
import * as upstreamReads from "../../sessions/session-upstream-links-runtime.js";
import { deleteSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { upsertSessionUpstreamLinkInDatabase } from "../../sessions/session-upstream-links.kernel.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cfg,
  invokeMessageCut,
  readMutationStorage,
  seedMessageCutSource,
  useMessageCutStorageFixture,
  type SourceScope,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

function adoptUpstreamSource(
  database: DatabaseSync,
  scope: SourceScope,
  threadId = "late-upstream-thread",
): boolean {
  return upsertSessionUpstreamLinkInDatabase(
    database,
    {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      catalogId: "fixture",
      hostId: "gateway:local",
      threadId,
      upstreamKind: "codex-app-server",
      upstreamRef: { threadId },
      marker: null,
    },
    1,
  );
}

it.each(
  (["sessions.fork", "sessions.rewind"] as const).flatMap((method) =>
    (["transaction", "commit"] as const).map((boundary) => ({ method, boundary })),
  ),
)(
  "refuses $method when an upstream link appears at the $boundary boundary",
  async ({ method, boundary }) => {
    await withOpenClawTestState({ label: "message-cut-upstream-commit" }, async (testState) => {
      await testState.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
      const before = await readMutationStorage(scope);
      const shared = openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const foreign = new DatabaseSync(shared.path);
      try {
        const create = workerAdmission.createSqliteWorkerOperationAdmission;
        let linked = false;
        let stage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | "outside" = "outside";
        const guardCalls = { outside: 0, open: 0, prepare: 0, transaction: 0, commit: 0 };
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (callback, attachment) =>
            create((request, grant) => {
              if (
                !linked &&
                request.stage === boundary &&
                isRecord(request.facts) &&
                (boundary === "transaction"
                  ? request.facts.publication === undefined
                  : isRecord(request.facts.publication) &&
                    request.facts.publication.kind === "session-entry-patch-committed")
              ) {
                linked = adoptUpstreamSource(foreign, scope);
              }
              const previousStage = stage;
              stage = request.stage;
              try {
                callback(request, grant);
              } finally {
                stage = previousStage;
              }
            }, attachment),
        );
        const mutation = invokeMessageCut(method, scope, {
          sessionMutationCommitGuard: () => {
            guardCalls[stage] += 1;
          },
        });
        await mutation.error;

        expect(linked).toBe(true);
        const diagnostic = JSON.stringify({ method, guardCalls });
        expect.soft(await readMutationStorage(scope), diagnostic).toEqual(before);
        expect(mutation.respond, diagnostic).not.toHaveBeenCalledWith(
          true,
          expect.anything(),
          undefined,
        );
      } finally {
        foreign.close();
      }
    });
  },
);

it("refuses a local cut when the final upstream reader fails", async () => {
  await withOpenClawTestState({ label: "message-cut-upstream-unavailable" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    const before = await readMutationStorage(scope);
    vi.spyOn(upstreamReads, "readCurrentSessionUpstreamLink").mockImplementationOnce(() => {
      throw new Error("fixture upstream read unavailable");
    });
    const mutation = invokeMessageCut("sessions.rewind", scope);
    expect(await mutation.error).toBeUndefined();
    expect(await readMutationStorage(scope)).toEqual(before);
    expect(mutation.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
      }),
    );
  });
});

it.each(["preparation", "commit"] as const)(
  "fences incognito native context effects after upstream revocation during %s",
  async (phase) => {
    await withOpenClawTestState({ label: "message-cut-native-upstream" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource(true);
      const before = await readMutationStorage(scope);
      const shared = openOpenClawStateDatabase();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let bindingPresent = true;
      let linked = false;
      const effect = vi.fn();
      const rollback = vi.fn();
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "native-upstream-fixture" });
      registry.plugins.push(record);
      registry.agentHarnesses.push({
        pluginId: record.id,
        source: "runtime",
        harness: {
          id: "native-upstream-fixture",
          label: "Native source fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
          withSessionContextReset: async (params, run) => {
            if (phase === "preparation") {
              entered.resolve();
              await release.promise;
              params.assertCurrent();
              effect();
            }
            return run({
              commit() {
                params.assertCurrent();
                bindingPresent = false;
                effect();
              },
              rollback() {
                params.assertCurrent();
                bindingPresent = true;
                rollback();
              },
            });
          },
        },
      });
      setActivePluginRegistry(registry);
      if (phase === "commit") {
        const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
        database.db.function("fixture_adopt_upstream", () => {
          linked = adoptUpstreamSource(shared.db, scope);
          return Number(linked);
        });
        database.db.exec(
          "CREATE TEMP TRIGGER fixture_adopt_upstream AFTER UPDATE OF current_session_id ON session_nodes WHEN NEW.current_session_id != OLD.current_session_id BEGIN SELECT fixture_adopt_upstream(); END",
        );
      }
      const mutation = invokeMessageCut("sessions.rewind", scope);
      if (phase === "preparation") {
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            mutation.error,
            "native reset preparation",
          );
          linked = adoptUpstreamSource(shared.db, scope);
        } finally {
          release.resolve();
        }
      }
      expect(await mutation.error).toBeUndefined();
      expect(linked).toBe(true);
      expect(
        readCurrentSessionUpstreamLink(
          captureSessionUpstreamLinkReadSource(),
          scope.sessionKey,
          scope.agentId,
        ),
      ).toMatchObject({ threadId: "late-upstream-thread" });
      expect(await readMutationStorage(scope)).toEqual(before);
      expect(bindingPresent).toBe(true);
      expect(effect).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
      expect(rollback).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
      expect(mutation.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("external agent harness"),
        }),
      );
    });
  },
);
it("refuses a shared-state owner retired while rewind waits for the lifecycle lock", async () => {
  await withOpenClawTestState({ label: "message-cut-upstream-retirement" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    const before = await readMutationStorage(scope);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const holding = runExclusiveSessionLifecycleMutation("archive", {
      scope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
      identities: [scope.sessionId],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const mutation = invokeMessageCut("sessions.rewind", scope);
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      release.resolve();
      await holding;
    }
    expect(await mutation.error).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/state database read admission (?:changed|is closed)/),
      }),
    );
    expect(await readMutationStorage(scope)).toEqual(before);
    expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
  });
});

it.each(["replace", "delete"] as const)(
  "refuses a native fork effect after the synchronous owner %ss its source link",
  async (change) => {
    await withOpenClawTestState({ label: "message-cut-upstream-replacement" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      const shared = openOpenClawStateDatabase();
      expect(adoptUpstreamSource(shared.db, scope)).toBe(true);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const nativeEffect = vi.fn();
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "fixture",
        source: "runtime",
        harness: {
          id: "upstream-fixture",
          label: "Upstream source fixture",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("not used");
          },
          sessionForkV2: {
            upstreamKinds: ["codex-app-server"],
            fork: async ({ assertCurrent }) => {
              entered.resolve();
              await release.promise;
              assertCurrent();
              nativeEffect();
              return { status: "created", key: "agent:main:dashboard:forked" };
            },
          },
        },
      });
      setActivePluginRegistry(registry);
      const mutation = invokeMessageCut("sessions.fork", scope);
      try {
        await awaitGateBeforeSettlement(entered.promise, mutation.error, "upstream fork dispatch");
        if (change === "replace") {
          expect(adoptUpstreamSource(shared.db, scope, "replacement-thread")).toBe(true);
        } else {
          expect(deleteSessionUpstreamLink(scope.sessionKey, scope.agentId)).toBe("deleted");
        }
      } finally {
        release.resolve();
      }
      expect(await mutation.error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("changed during fork"),
        }),
      );
      expect(nativeEffect).not.toHaveBeenCalled();
    });
  },
);

it.each(["preparation", "commit"] as const)(
  "refuses incognito fork when a missing upstream database appears during %s",
  async (phase) => {
    await withOpenClawTestState({ label: "message-cut-upstream-appearance" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource(true);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const sessionKeys = () =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_nodes")
            .select("session_key")
            .orderBy("session_key"),
        ).rows;
      const before = {
        entry: loadSessionEntry(scope),
        history: await loadTranscriptEvents(scope),
        sessionKeys: sessionKeys(),
      };
      const source = captureSessionUpstreamLinkReadSource();
      expect(source.present).toBe(false);
      let appeared = false;
      const createUpstream = () => {
        const shared = openOpenClawStateDatabase();
        expect(shared.path).toBe(source.context.admission.databasePath);
        appeared = adoptUpstreamSource(shared.db, scope);
        return Number(appeared);
      };
      if (phase === "preparation") {
        const prepare = upstreamReads.prepareSessionUpstreamLink;
        vi.spyOn(upstreamReads, "prepareSessionUpstreamLink").mockImplementationOnce(
          async (...args) => {
            const prepared = await prepare(...args);
            expect(prepared).toBeUndefined();
            createUpstream();
            return prepared;
          },
        );
      } else {
        database.db.function("fixture_create_upstream_database", createUpstream);
        database.db.exec(
          "CREATE TEMP TRIGGER fixture_create_upstream_database AFTER INSERT ON session_nodes WHEN NEW.session_key != 'agent:main:dashboard:incognito-source' BEGIN SELECT fixture_create_upstream_database(); END",
        );
      }
      const mutation = invokeMessageCut("sessions.fork", scope);
      const failure = await mutation.error;
      expect(appeared).toBe(true);
      expect(() => source.assertCurrent()).toThrow("database path identity changed");
      if (phase === "preparation") {
        expect(failure).toEqual(
          expect.objectContaining({
            message: expect.stringContaining("database path identity changed"),
          }),
        );
      } else {
        expect(failure).toBeUndefined();
        expect(mutation.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
        );
      }
      expect(loadSessionEntry(scope)).toEqual(before.entry);
      expect(await loadTranscriptEvents(scope)).toEqual(before.history);
      expect(sessionKeys()).toEqual(before.sessionKeys);
      expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
    });
  },
);
