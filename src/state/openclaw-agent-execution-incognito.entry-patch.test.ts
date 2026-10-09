import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  patchSessionEntryCore,
  patchSessionEntryTarget,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { SqliteSessionMutationConflictError } from "../config/sessions/session-mutation-conflict-error.js";
import type { PreparedSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
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

it.each(["transaction", "commit"] as const)(
  "rechecks host permission at %s and never publishes a refused write",
  async (stage) => {
    const scope = await create(`revoked-${stage}`);
    let grants = 0;
    let publications = 0;
    await expect(
      withIncognitoSessionActor(actor, () =>
        patchSessionEntryCore(scope, () => ({ label: "forbidden" }), {
          assertCommitAllowed() {
            grants += 1;
            if (grants === (stage === "transaction" ? 1 : 2)) {
              throw new Error("permission revoked");
            }
          },
          onCommitted() {
            publications += 1;
          },
        }),
      ),
    ).rejects.toThrow("permission revoked");
    expect(publications).toBe(0);
    expect(
      (await actor.sessions.read(authority, { sessionKey: scope.sessionKey })).entry?.label,
    ).toBeUndefined();
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
