import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  patchSessionEntryCore,
  patchSessionEntryTarget,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { withTranscriptWriteSequence } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  resolveSessionKeyBySessionIdAsync,
  resolveSessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.transcript-target.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { SqliteSessionMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import * as maintenanceRuntime from "../config/sessions/store-maintenance-runtime.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { patchSessionEntry as patchSdkSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "./openclaw-agent-execution-incognito.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
let durableSource: CapturedSessionEntryReadSource;
const target = (name: string) => ({
  agentId: "main",
  env,
  sessionKey: `agent:main:dashboard:incognito-entry-${name}`,
  storePath: actor.path,
});

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-entry-patch-") };
  const durable = openOpenClawAgentDatabase({ agentId: "main", env });
  const physical = readOpenClawAgentDatabaseIdentity(durable);
  durableSource = {
    agentId: durable.agentId,
    path: durable.path,
    databaseIdentity: physical.identity,
    databaseBirthtime: physical.birthtime,
  };
  actor = await openIncognitoTestActor(env, authority);
});
useIncognitoNoHostSql();
afterAll(async () => {
  await actor?.close();
  await closeOpenClawStateDatabaseAsync();
});

async function create(name: string) {
  const scope = target(name);
  await actor.sessions.create(authority, {
    sessionKey: scope.sessionKey,
    entry: { sessionId: name, updatedAt: 100, createdAt: 100, incognito: true },
  });
  return scope;
}

it("rejects a prepared patch when another actor write rewrites its entry", async () => {
  const scope = await create("rewrite");
  const prepared = createDeferredCore();
  const continuePatch = createDeferredCore();
  const patch = withIncognitoSessionActor(actor, () =>
    patchSessionEntryCore(scope, async () => {
      prepared.resolve();
      await continuePatch.promise;
      return { label: "stale" };
    }),
  );
  const rejected = expect(patch).rejects.toBeInstanceOf(SqliteSessionMutationConflictError);
  await prepared.promise;
  await withIncognitoSessionActor(actor, () =>
    patchSessionEntryCore(scope, () => ({ label: "winner" })),
  );
  continuePatch.resolve();
  await rejected;
  expect(
    (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
  ).toBe("winner");
});

it("resolves persisted actor windows by ID and preserves missing IDs", async () => {
  const scope = await create("by-id");
  await withIncognitoSessionActor(actor, async () => {
    const previousRoot = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = `${env.OPENCLAW_STATE_DIR}-foreign`;
    try {
      expect(
        await withTranscriptWriteSequence(
          { agentId: actor.agentId, sessionKey: scope.sessionKey, sessionId: "by-id" },
          (write) => write.readEvents(),
        ),
      ).toMatchObject([{ type: "session", id: "by-id" }]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousRoot;
      }
    }
    expect(
      await resolveSessionKeyBySessionIdAsync({
        agentId: "main",
        storePath: actor.path,
        sessionId: "by-id",
      }),
    ).toBe(scope.sessionKey);
    expect(
      await resolveSessionKeyBySessionIdAsync({
        agentId: "main",
        storePath: actor.path,
        sessionId: "absent-id",
      }),
    ).toBeUndefined();
    expect(
      await resolveSessionTranscriptRuntimeTarget({
        ...scope,
        sessionId: "by-id",
        sessionKey: target("stale-key").sessionKey,
      }),
    ).toMatchObject({ sessionKey: scope.sessionKey, sessionId: "by-id", storePath: actor.path });
  });
});

it("compares identityless replacement snapshots and retains cancellation through publication", async () => {
  const scope = await create("batch-cas");
  const controller = new AbortController();
  const cancelled = new Error("Replacement admission closed");
  const nested = vi.fn(() => ({ label: "must not persist" }));
  let afterCommitted = false;
  await withIncognitoSessionActor(
    actor,
    async () => {
      await expect(
        applySessionEntryExactReplacements({
          storePath: actor.path,
          async update(entries) {
            await patchSessionEntryCore(scope, () => ({ label: "winner" }));
            return {
              result: undefined,
              replacements: entries
                .filter(({ sessionKey }) => sessionKey === scope.sessionKey)
                .map(({ sessionKey, entry }) => ({
                  sessionKey,
                  entry: { ...entry, label: "stale" },
                })),
            };
          },
        }),
      ).rejects.toThrow("changed before replacement");
      let observed: string | undefined;
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          observed = actor.sessions.readSharing(scope.sessionKey)?.entry?.sessionId;
        }
      });
      try {
        await applySessionEntryCanonicalReplacements({
          storePath: actor.path,
          async update(entries) {
            controller.abort(cancelled);
            await expect(patchSessionEntryCore(scope, nested)).rejects.toBe(cancelled);
            return {
              result: undefined,
              replacements: entries
                .filter(({ sessionKey }) => sessionKey === scope.sessionKey)
                .map(({ sessionKey, entry }) => ({
                  sessionKey,
                  previousSessionKeys: [],
                  entry: { ...entry, sessionId: "batch-cas-new" },
                })),
            };
          },
          async afterCommitted(_result, context) {
            context.assertCurrent();
            await expect(patchSessionEntryCore(scope, nested)).rejects.toBe(cancelled);
            afterCommitted = true;
          },
        });
        expect(observed).toBe("batch-cas-new");
        expect(afterCommitted).toBe(true);
        expect(nested).not.toHaveBeenCalled();
      } finally {
        stop();
      }
      expect(
        (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry,
      ).toMatchObject({ label: "winner", sessionId: "batch-cas-new" });
    },
    controller.signal,
  );
});

it.each(["lost reply", "lost receipt"] as const)(
  "settles actor replacement without replay after %s",
  async (fault) => {
    const scope = await create(`replacement-${fault.replaceAll(" ", "-")}`);
    const original = workerStore.runSqliteWorkerStoreOperation;
    let receiptFault: { mockRestore(): void } | undefined;
    let executed = 0;
    const observer = vi
      .spyOn(workerStore, "runSqliteWorkerStoreOperation")
      .mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          owner: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof original>[2],
          assertCurrent?: Parameters<typeof original>[3],
          createAdmission?: Parameters<typeof original>[4],
        ) => {
          let native: SqliteWorkerOperationAdmission | undefined;
          return original(
            owner,
            (worker) =>
              operation({
                execute: async (command, options) => {
                  const result = await worker.execute(command, options);
                  if (command.type !== "session.entry.replacements.commit") {
                    return result;
                  }
                  executed++;
                  expect(native?.committed).toMatchObject({
                    facts: { kind: "session-entry-patch-committed" },
                  });
                  expect(native?.settlement?.kind).toBe("completed");
                  if (fault === "lost receipt") {
                    assert(native);
                    receiptFault = vi.spyOn(native, "committed", "get").mockReturnValue(undefined);
                  }
                  throw new Error("reply delivery failed");
                },
              }),
            stateContext,
            assertCurrent,
            createAdmission &&
              ((retained) => {
                const admitted = createAdmission(retained);
                native = admitted.admission;
                return admitted;
              }),
          );
        },
      );
    try {
      const pending = withIncognitoSessionActor(actor, () =>
        applySessionEntryExactReplacements({
          storePath: actor.path,
          sessionKeys: [scope.sessionKey],
          update: (entries) => ({
            result: "committed",
            replacements: entries.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: { ...entry, label: "committed once" },
            })),
          }),
        }),
      );
      if (fault === "lost reply") {
        await expect(pending).resolves.toBe("committed");
      } else {
        await expect(pending).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(() => actor.sessions.readSharing(scope.sessionKey)).toThrow(
          "pending or unavailable",
        );
      }
      expect(executed).toBe(1);
    } finally {
      receiptFault?.mockRestore();
      observer.mockRestore();
    }
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
    ).toBe("committed once");
  },
);

it("refuses changed CLI history before adopting its writer", async () => {
  const sessionId = "cli-history-changed";
  const scope = await create(sessionId);
  const append = async (text: string) => {
    const result = await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey: scope.sessionKey,
        sessionId,
        fence: {},
        message: { role: "user", content: text, timestamp: 100 },
      },
    });
    assert(result.ok && result.value.append);
  };
  await append("Prepared CLI history");
  const { watermark } = await actor.sessions.history(authority, {
    type: "session.history.watermark",
    input: { sessionKey: scope.sessionKey, sessionId },
  });
  await append("History changed while CLI planning yielded");
  let published = false;
  const patch = withIncognitoSessionActor(actor, () =>
    patchSessionEntryCore(scope, () => ({ activeWriterRunId: "synthetic-cli-writer" }), {
      workerGuard: { cliHistory: { sessionId, watermark } },
      onCommitted() {
        published = true;
      },
    }),
  );
  await expect(patch).rejects.toThrow("CLI history changed before preparation");
  expect(published).toBe(false);
  const persisted = (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry;
  expect(persisted).not.toHaveProperty("activeWriterRunId");
});

it.each(["host", "SQL"] as const)(
  "settles a false %s predicate before CAS after awaiting a winning actor rewrite",
  async (predicate) => {
    const name = `false-predicate-rewrite-${predicate.toLowerCase()}`;
    const scope = await create(name);
    await withIncognitoSessionActor(actor, async () => {
      await expect(
        patchSessionEntryCore(
          scope,
          async () => {
            await patchSessionEntryCore(scope, () => ({ label: "winner" }));
            return null;
          },
          {
            ...(predicate === "host"
              ? { shouldCommit: () => false }
              : {
                  workerGuard: {
                    shouldCommitIf: {
                      kind: "transcript" as const,
                      sessionId: name,
                      generation: "obsolete",
                      leafEntryId: null,
                    },
                  },
                }),
            assertCommitAllowed() {
              throw new Error("A false predicate must precede the throwing guard");
            },
          },
        ),
      ).resolves.toBeNull();
    });
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
    ).toBe("winner");
  },
);

it("rejects a valid captured durable source before reading outside its actor", async () => {
  const scope = target("durable-source");
  await expect(
    withIncognitoSessionActor(actor, () =>
      patchSessionEntryTarget(
        {
          ...scope,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          readSource: durableSource,
        },
        () => ({ label: "foreign source" }),
      ),
    ),
  ).rejects.toThrow("Captured session database changed");
});

it.each(
  (["core", "SDK", "runtime", "composed SDK"] as const).flatMap((boundary) =>
    (["transaction", "commit", "allowed"] as const).map((stage) => ({ boundary, stage })),
  ),
)(
  "rechecks $boundary host permission at $stage and persists only allowed writes",
  async ({ boundary, stage }) => {
    const name = `permission-${boundary}-${stage}`.toLowerCase().replaceAll(" ", "-");
    const scope = await create(name);
    let grants = 0;
    const assertCommitAllowed = () => {
      grants += 1;
      if (stage !== "allowed" && grants === (stage === "transaction" ? 1 : 2)) {
        throw new Error("permission revoked");
      }
    };
    const update = () => ({ label: "allowed" });
    const guard =
      boundary === "composed SDK"
        ? composeSessionSourceAssertion([
            captureSessionEntrySourceAssertion({
              scope,
              expected: { sessionId: name },
              fields: ["sessionId"],
              assertCurrent: assertCommitAllowed,
              refuse() {
                throw new Error("permission revoked");
              },
            }),
          ])
        : assertCommitAllowed;
    const patch = withIncognitoSessionActor(actor, () =>
      boundary === "core"
        ? patchSessionEntryCore(scope, update, { assertCommitAllowed })
        : (boundary === "runtime"
            ? createRuntimeAgent().session.patchSessionEntry
            : patchSdkSessionEntry)({
            ...scope,
            update,
            assertCommitAllowed: guard,
          }),
    );
    if (stage === "allowed") {
      await expect(patch).resolves.toMatchObject({ label: "allowed" });
    } else {
      await expect(patch).rejects.toThrow("permission revoked");
    }
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
    ).toBe(stage === "allowed" ? "allowed" : undefined);
  },
);

it("rejects bindings and selections for another physical store or session", async () => {
  const scope = await create("mismatched");
  await withIncognitoSessionActor(actor, async () => {
    await expect(
      patchSessionEntryCore(
        { ...scope, env: { OPENCLAW_STATE_DIR: tempDirs.make("foreign-incognito-") } },
        () => ({ label: "foreign" }),
      ),
    ).rejects.toThrow("Explicit incognito database target does not match its agent and state root");
    await expect(
      patchSessionEntryTarget(
        {
          ...scope,
          target: { canonicalKey: scope.sessionKey, storeKeys: [target("other").sessionKey] },
        },
        () => ({ label: "foreign selection" }),
      ),
    ).rejects.toThrow("another session");
    await expect(
      patchSessionEntryTarget(
        {
          ...scope,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          readSource: {
            agentId: actor.agentId,
            path: actor.path,
            databaseIdentity: Symbol("native"),
          },
        },
        () => ({ label: "foreign identity" }),
      ),
    ).rejects.toThrow("Captured session database changed");
  });
  expect(
    (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
  ).toBeUndefined();
});

it("preserves source authority through transaction and commit grants", async () => {
  const scope = await create("source-authority");
  let grants = 0;
  await expect(
    withIncognitoSessionActor(actor, () =>
      patchSessionEntryCore(scope, () => ({ label: "forbidden" }), {
        workerGuard: {
          source() {
            if (++grants === 2) {
              throw new Error("source authority revoked");
            }
          },
        },
      }),
    ),
  ).rejects.toThrow("source authority revoked");
  expect(grants).toBe(2);
  expect(
    (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
  ).toBeUndefined();
});

it.each([false, true])(
  "retains prepared source custody and rechecks its worker rows (changed=%s)",
  async (changed) => {
    const scope = await create(`source-target-${changed}`);
    const sourceScope = await create(`source-row-${changed}`);
    let released = false;
    const source = Object.assign(
      () => {
        throw new Error("Prepared sources must not use the native callback");
      },
      {
        async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
          const observed = await actor.sessions.read(authority, {
            sessionKey: sourceScope.sessionKey,
          });
          return {
            assertCurrent() {
              expect(released).toBe(false);
            },
            checks: [
              {
                predicate: {
                  source: {
                    agentId: actor.agentId,
                    path: actor.path,
                    databaseIdentity: actor.identity.incarnation,
                  },
                  sessionKey: sourceScope.sessionKey,
                  fields: ["label"],
                  expected: observed.entry,
                },
                refuse(facts) {
                  expect(facts.entry?.label).toBe("changed");
                  throw new Error("prepared source changed");
                },
              },
            ],
            release() {
              released = true;
            },
          };
        },
      },
    );
    const work = withIncognitoSessionActor(actor, () =>
      patchSessionEntryCore(
        scope,
        async () => {
          if (changed) {
            await patchSessionEntryCore(sourceScope, () => ({ label: "changed" }));
          }
          return { label: "accepted" };
        },
        {
          workerGuard: { source },
          onCommitted() {
            expect(released).toBe(false);
          },
        },
      ),
    );
    if (changed) {
      await expect(work).rejects.toThrow("prepared source changed");
    } else {
      await expect(work).resolves.toMatchObject({ label: "accepted" });
    }
    expect(released).toBe(true);
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
    ).toBe(changed ? undefined : "accepted");
  },
);

it("refuses native-only source authority before invoking its storage callback", async () => {
  const scope = await create("native-source");
  await expect(
    withIncognitoSessionActor(actor, () =>
      patchSessionEntryCore(scope, () => ({ label: "forbidden" }), {
        workerGuard: {
          source: Object.assign(
            () => {
              throw new Error("Native callback must not run");
            },
            { nativeSource: true },
          ),
        },
      }),
    ),
  ).rejects.toThrow("source authority prepared for the same actor");
});

it("retains private archive metadata and prunes private runtime rows through actor maintenance", async () => {
  const active = await create("maintenance-active");
  const stale = await create("maintenance-stale");
  const synthetic = "agent:main:subagent:incognito-maintenance-stale";
  await actor.sessions.create(authority, {
    sessionKey: synthetic,
    entry: { sessionId: "maintenance-subagent", updatedAt: 100, incognito: true },
  });
  const policy = maintenanceRuntime.resolveMaintenanceConfig();
  const configured = vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue({
    ...policy,
    mode: "enforce",
    pruneAfterMs: 1,
    archiveDashboardAfterMs: null,
    preserveRecentMs: null,
    maxEntries: 10_000,
  });
  try {
    await withIncognitoSessionActor(actor, () =>
      applySessionEntryExactReplacements({
        storePath: actor.path,
        sessionKeys: [active.sessionKey],
        activeSessionKey: active.sessionKey,
        skipMaintenance: false,
        update: (entries) => ({
          result: undefined,
          replacements: entries.map(({ sessionKey, entry }) => ({
            sessionKey,
            entry: { ...entry, label: "maintained" },
          })),
        }),
      }),
    );
    expect(
      (await actor.sessions.read(authority, { sessionKey: stale.sessionKey })).entry,
    ).toMatchObject({ archivedAt: expect.any(Number) });
    expect(actor.sessions.readSharing(stale.sessionKey)?.entry?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect((await actor.sessions.read(authority, { sessionKey: synthetic })).entry).toBeUndefined();
    expect(
      (await actor.sessions.read(authority, { sessionKey: active.sessionKey })).entry,
    ).toMatchObject({ label: "maintained" });
  } finally {
    configured.mockRestore();
  }
});
