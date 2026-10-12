import "../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { afterEach, expect, expectTypeOf, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  openIncognitoTestActor,
  useIncognitoActorProbe,
} from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureSessionEntryCurrentCheck } from "./session-binding-runtime.js";
import {
  patchSessionEntry,
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
  getSessionEntryAsync,
  getSessionEntryByIdAsync,
  listSessionEntriesAsync,
  readAmbientTranscriptWatermarkAsync,
  resolveAmbientTranscriptWatermarkKey,
  upsertSessionEntry,
} from "./session-store-runtime.js";

const tempDirs = createTempDirTracker();
const probe = useIncognitoActorProbe();
const authority = { assertCurrent() {} };
afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
});

const completeEntry: InternalSessionEntry = {
  sessionId: "selected",
  updatedAt: 1,
  createdAt: 1,
  category: "Synthetic",
  execCwd: "/synthetic/workspace",
  skillsSnapshot: { prompt: "Complete saved prompt", skills: [] },
  pluginExtensions: { synthetic: { enabled: true } },
  pendingProjectGitUrl: "https://example.test/private-owner",
  cliHistoryBoundary: {
    version: 1,
    sessionId: "selected",
    state: "known",
    authFingerprint: "1".repeat(64),
    generation: "synthetic-generation",
    maxSeq: 7,
    writerRunId: "synthetic-writer",
  },
};

it("lists current public metadata off the host after an owner write without creating absent stores", async () => {
  expectTypeOf<
    PluginRuntime["agent"]["session"]["listSessionEntriesAsync"]
  >().parameters.toEqualTypeOf<Parameters<typeof listSessionEntriesAsync>>();
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-list-") };
  const scope = { agentId: "main", env };
  const sessionKey = "agent:main:listed";
  await expect(listSessionEntriesAsync(scope)).resolves.toEqual([]);
  expect(existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);

  replaceSessionEntrySync(
    { ...scope, sessionKey },
    {
      ...completeEntry,
      initializationPending: true,
    },
  );
  const read = async () => {
    const sql = observeHostDataSql();
    try {
      const entries = await listSessionEntriesAsync(scope);
      expect(sql.queries).toEqual([]);
      return entries;
    } finally {
      sql.restore();
    }
  };
  const before = await read();
  expect(before).toEqual([
    {
      sessionKey,
      entry: expect.objectContaining({
        sessionId: "selected",
        initializationPending: true,
        pluginExtensions: completeEntry.pluginExtensions,
      }),
    },
  ]);
  expect(before[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");
  expect(before[0]?.entry).not.toHaveProperty("skillsSnapshot");

  await upsertSessionEntry({
    ...scope,
    sessionKey,
    entry: { sessionId: "replacement", updatedAt: 2, displayName: "Replacement" },
  });
  expect(await read()).toEqual([
    {
      sessionKey,
      entry: expect.objectContaining({ sessionId: "replacement", displayName: "Replacement" }),
    },
  ]);
  expect(before[0]?.entry.sessionId).toBe("selected");
});

it("reads committed watermark updates off the host and ignores a reset predecessor", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-watermark-") };
  const scope = { agentId: "main", env, sessionKey: "agent:main:telegram:group:room" };
  const key = resolveAmbientTranscriptWatermarkKey({
    channel: "telegram",
    accountId: "default",
    conversationId: "room",
  });
  let entry = {
    sessionId: "before-reset",
    updatedAt: 1,
    ambientTranscriptWatermarks: {
      [key]: { sessionId: "before-reset", messageId: "11", updatedAt: 1 },
    },
  };
  const read = async () => {
    const sql = observeHostDataSql();
    try {
      const watermark = await readAmbientTranscriptWatermarkAsync({ ...scope, key });
      expect(sql.queries).toEqual([]);
      return watermark;
    } finally {
      sql.restore();
    }
  };
  await upsertSessionEntry({ ...scope, entry });
  expect(await read()).toMatchObject({ messageId: "11" });

  entry = {
    ...entry,
    ambientTranscriptWatermarks: {
      [key]: { sessionId: "before-reset", messageId: "12", updatedAt: 2 },
    },
  };
  await upsertSessionEntry({ ...scope, entry });
  expect(await read()).toMatchObject({ messageId: "12" });

  await upsertSessionEntry({ ...scope, entry: { ...entry, sessionId: "after-reset" } });
  expect(await read()).toBeUndefined();
});

it.each(["durable", "incognito"] as const)(
  "selects the most recently updated duplicate ID only when requested in %s sessions",
  async (mode) => {
    expectTypeOf<
      PluginRuntime["agent"]["session"]["getSessionEntryByIdAsync"]
    >().parameters.toEqualTypeOf<Parameters<typeof getSessionEntryByIdAsync>>();
    const env = { OPENCLAW_STATE_DIR: tempDirs.make(`sdk-id-order-${mode}-`) };
    const scope = { agentId: "main", env };
    const actor = mode === "incognito" ? await openIncognitoTestActor(env, authority) : undefined;
    const prefix = actor ? "agent:main:dashboard:incognito-" : "agent:main:";
    try {
      for (const [suffix, sessionId, updatedAt] of [
        ["a-old", "duplicate", 1],
        ["z-new", "duplicate", 20],
        ["m-tied", "duplicate", 20],
        ["n-trimmed", "\t legacy \n", 30],
        ["b-exact", "legacy", 1],
      ] as const) {
        const sessionKey = `${prefix}${suffix}`;
        const entry: InternalSessionEntry = {
          sessionId,
          updatedAt,
          ...(actor ? { incognito: true } : {}),
        };
        if (actor) {
          await actor.sessions.create(authority, { sessionKey, entry });
        } else {
          replaceSessionEntrySync({ ...scope, sessionKey }, entry);
        }
      }
      const verify = async () => {
        await expect(
          getSessionEntryByIdAsync({ ...scope, sessionId: "duplicate" }),
        ).resolves.toMatchObject({ sessionKey: `${prefix}a-old` });
        await expect(
          getSessionEntryByIdAsync({ ...scope, sessionId: "duplicate", orderBy: "updatedAt" }),
        ).resolves.toMatchObject({ sessionKey: `${prefix}m-tied` });
        await expect(
          getSessionEntryByIdAsync({ ...scope, sessionId: "legacy" }),
        ).resolves.toMatchObject({ sessionKey: `${prefix}b-exact` });
        await expect(
          getSessionEntryByIdAsync({ ...scope, sessionId: "legacy", orderBy: "updatedAt" }),
        ).resolves.toMatchObject({ sessionKey: `${prefix}n-trimmed` });
      };
      if (actor) {
        await withIncognitoSessionActor(actor, verify);
      } else {
        await verify();
      }
    } finally {
      await actor?.close();
    }
  },
);

it("keeps the complete public projection for durable and explicitly bound actor entry reads", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-entry-") };
  const durable = { agentId: "main", env, sessionKey: "agent:main:durable" };
  await expect(
    getSessionEntryByIdAsync({ ...durable, sessionId: "missing" }),
  ).resolves.toBeUndefined();
  expect(existsSync(resolveOpenClawAgentSqlitePath(durable))).toBe(false);
  replaceSessionEntrySync(durable, completeEntry);
  const publicEntry = getSessionEntry(durable);
  expect(publicEntry).toMatchObject({
    skillsSnapshot: completeEntry.skillsSnapshot,
    pluginExtensions: completeEntry.pluginExtensions,
    execCwd: completeEntry.execCwd,
  });
  expect(publicEntry).not.toHaveProperty("pendingProjectGitUrl");
  expect(publicEntry).not.toHaveProperty("cliHistoryBoundary");
  expect(publicEntry).not.toBeInstanceOf(Promise);
  await expect(getSessionEntryAsync(durable)).resolves.toEqual(publicEntry);
  await expect(getSessionEntryByIdAsync({ ...durable, sessionId: "selected" })).resolves.toEqual({
    sessionKey: durable.sessionKey,
    entry: publicEntry,
  });
  await expect(
    getSessionEntryByIdAsync({ ...durable, sessionId: "missing" }),
  ).resolves.toBeUndefined();
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-selected";
  try {
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { ...completeEntry, incognito: true },
    });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeHostDataSql();
      try {
        const entry = await getSessionEntryAsync({ agentId: "main", env, sessionKey });
        expect(entry).toEqual({ ...publicEntry, incognito: true });
        await expect(
          getSessionEntryByIdAsync({ agentId: "main", sessionId: "selected" }),
        ).resolves.toEqual({
          sessionKey,
          entry,
        });
        await expect(
          getSessionEntryByIdAsync({ agentId: "main", sessionId: "missing" }),
        ).resolves.toBeUndefined();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      await expect(
        getSessionEntryByIdAsync({
          ...durable,
          storePath: resolveOpenClawAgentSqlitePath(durable),
          sessionId: "selected",
        }),
      ).resolves.toEqual({ sessionKey: durable.sessionKey, entry: publicEntry });
    });
  } finally {
    await actor.close();
  }
});

it.each(["bound", "native"] as const)(
  "cleans a %s private recall helper selected through its configured durable path",
  async (mode) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make(`sdk-cleanup-${mode}-`) };
    const scope = { agentId: "main", env };
    const storePath = resolveOpenClawAgentSqlitePath(scope);
    const sessionKey = "agent:main:subagent:incognito-helper";
    const durableKey = "agent:main:durable-helper";
    const entry = { sessionId: "helper", updatedAt: 1, pluginOwnerId: "active-memory" };
    replaceSessionEntrySync({ ...scope, sessionKey: durableKey }, entry);
    const actor = mode === "bound" ? await openIncognitoTestActor(env, authority) : undefined;
    const privateEntry: InternalSessionEntry = { ...entry, incognito: true };
    if (actor) {
      await actor.sessions.create(authority, { sessionKey, entry: privateEntry });
    } else {
      replaceSessionEntrySync({ ...scope, sessionKey }, privateEntry);
    }
    const cleanup = async () => {
      const sql = actor ? observeHostDataSql() : undefined;
      try {
        await expect(
          cleanupSessionLifecycleArtifacts({
            ...scope,
            storePath,
            sessionKeySegmentPrefix: "subagent:incognito-helper",
            transcriptContentMarker: '"runId":"helper"',
            archiveRemovedEntryTranscripts: false,
            orphanTranscriptMinAgeMs: 0,
            nowMs: Date.now(),
          }),
        ).resolves.toEqual({ removedEntries: 1, archivedTranscriptArtifacts: 0 });
        await expect(getSessionEntryAsync({ ...scope, sessionKey })).resolves.toBeUndefined();
        if (sql) {
          expect(sql.queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }
    };
    try {
      if (actor) {
        await withIncognitoSessionActor(actor, cleanup);
      } else {
        await cleanup();
        expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
      }
      expect(getSessionEntry({ ...scope, sessionKey: durableKey })).toMatchObject(entry);
    } finally {
      await actor?.close();
    }
  },
);

it("keeps unbound incognito host-owned and distinguishes selected absence from an ended actor", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-native-incognito-") };
  const scope = { agentId: "main", env, sessionKey: "agent:main:dashboard:incognito-native" };
  replaceSessionEntrySync(scope, { sessionId: "native", updatedAt: 1, incognito: true });
  const sync = getSessionEntry(scope);
  expect(sync).toMatchObject({ sessionId: "native", incognito: true });
  expect(sync).not.toBeInstanceOf(Promise);
  await expect(getSessionEntryAsync(scope)).resolves.toEqual(sync);
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);

  const absentEnv = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-absent-") };
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "main", env: absentEnv, authority },
    async () => {
      await expect(getSessionEntryAsync({ ...scope, env: absentEnv })).resolves.toBeUndefined();
      const absent = await captureSessionEntryCurrentCheck({ ...scope, env: absentEnv });
      expect(absent.entry).toBeUndefined();
      expect(absent.isCurrent()).toBe(true);
      await expect(
        getSessionEntryByIdAsync({ agentId: "main", sessionId: "missing" }),
      ).resolves.toBeUndefined();
    },
  );
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(absentEnv)).toEqual([]);
});

it("does not disclose an actor entry after its owner ends during worker preparation", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-async-ended-") };
  const actor = await openIncognitoTestActor(env, authority);
  const sessionKey = "agent:main:dashboard:incognito-ending";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "ending", incognito: true, updatedAt: 1 },
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const stop = probe.observe(async (type) => {
    if (type === "session.entry.readById") {
      stop();
      entered.resolve();
      await release.promise;
    }
  });
  const reading = withIncognitoSessionActor(actor, () =>
    getSessionEntryByIdAsync({ agentId: "main", sessionId: "ending" }),
  );
  const rejected = expect(reading).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
  await entered.promise;
  const closing = actor.close();
  release.resolve();
  await Promise.all([rejected, closing]);
  await expect(
    withIncognitoSessionBinding({ actor }, () => getSessionEntryAsync({ env, sessionKey })),
  ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
});

it("keeps exact actor policy guards current without treating unrelated metadata as revocation", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("sdk-policy-current-") };
  const actor = await openIncognitoTestActor(env, authority);
  const target = {
    agentId: "main",
    storePath: actor.path,
    sessionKey: "agent:main:dashboard:incognito-policy",
  };
  try {
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: { ...completeEntry, incognito: true, execHost: "node", execNode: "original-node" },
    });
    await withIncognitoSessionActor(actor, async () => {
      const sql = observeHostDataSql();
      try {
        const prepared = await captureSessionEntryCurrentCheck({
          ...target,
          fields: ["execHost", "execNode"],
        });
        expect(prepared.isCurrent()).toBe(true);
        expect(prepared.entry).toMatchObject({ execHost: "node", execNode: "original-node" });
        expect(prepared.entry).not.toHaveProperty("cliHistoryBoundary");
        expect(prepared.entry).not.toHaveProperty("pendingProjectGitUrl");
        // Returned metadata is caller-owned, not the retained authorization predicate.
        prepared.entry!.execNode = "edited-return-value";
        expect(prepared.isCurrent()).toBe(true);
        await patchSessionEntry({ ...target, update: () => ({ displayName: "unrelated" }) });
        expect(prepared.isCurrent()).toBe(true);
        await patchSessionEntry({ ...target, update: () => ({ execNode: "replacement-node" }) });
        expect(prepared.isCurrent()).toBe(false);
        expect(prepared.assertCurrent).toThrow("selected session changed");
        await expect(
          captureSessionEntryCurrentCheck({
            ...target,
            fields: ["execNode"],
            expected: { sessionId: "selected", execNode: "original-node" },
          }),
        ).rejects.toThrow("selected session changed");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    });
  } finally {
    await actor.close();
  }
});
