import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveDatabasePathKey } from "../../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { retainConversationBindingFacts } from "./conversation-binding-facts.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { captureConversationBindingFacts } from "./conversation-registry.js";
import {
  conversationPublication,
  retainConversationWorkerPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import type { PreparedSessionSourceAuthority } from "./session-source-authority.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = createTempDirTracker();
function makeScope(prefix: string, sessionKey: string) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make(prefix) };
  return {
    agentId: "main",
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env }),
    env,
  };
}

function withoutHostIo(run: () => void) {
  const sql = observeMainThreadSql();
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  try {
    run();
    sql.expectIdle();
    expect(requests).not.toHaveBeenCalled();
  } finally {
    requests.mockRestore();
    sql.restore();
  }
}

function beginOtherAgentDeletion(env: { OPENCLAW_STATE_DIR: string }) {
  beginAgentDeletionJournal(
    {
      agentId: "other",
      operationId: "delete-other",
      agentDir: path.join(env.OPENCLAW_STATE_DIR, "agents", "other", "agent"),
      workspaceDir: path.join(env.OPENCLAW_STATE_DIR, "workspace-other"),
      sessionsDir: path.join(env.OPENCLAW_STATE_DIR, "agents", "other", "sessions"),
      deleteFiles: true,
    },
    { env },
  );
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
}

it.each<{ change: string; patch: Partial<InternalSessionEntry>; current: boolean }>([
  { change: "metadata", patch: { displayName: "Metadata changed" }, current: true },
  { change: "policy", patch: { execHost: "gateway" }, current: false },
  { change: "lifecycle", patch: { lifecycleRevision: "replacement" }, current: false },
])(
  "compares an initial snapshot with a concurrent $change publication",
  async ({ patch, current }) => {
    const scope = makeScope("entry-current-acquisition-", "agent:main:entry-current");
    const { env } = scope;
    const initial: InternalSessionEntry = { sessionId: "same", updatedAt: 1, execHost: "node" };
    replaceSessionEntrySync(scope, initial);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    let changed = false;
    // Delay delivery, not the read: the writer commits after the worker selected its snapshot.
    // oxlint-disable-next-line typescript/unbound-method -- forwarding preserves the worker receiver.
    const emit = Worker.prototype.emit;
    const spy = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event,
      ...args
    ) {
      const message: unknown = args[0];
      if (
        !changed &&
        event === "message" &&
        isRecord(message) &&
        isRecord(message.value) &&
        isRecord(message.value.value) &&
        message.value.value.kind === "session-entry-read"
      ) {
        changed = true;
        beginOtherAgentDeletion(env);
        replaceSessionEntrySync(scope, { ...initial, ...patch });
      }
      return emit.call(this, event, ...args);
    });
    try {
      const pending = captureSessionEntryCurrentCheckAsyncInternal({
        ...scope,
        fields: ["execHost", "execNode", "sandbox", "sandboxMode"],
      });
      if (current) {
        const check = await pending;
        try {
          await expect(check.assertCurrent()).resolves.toBeUndefined();
        } finally {
          check.release();
        }
      } else {
        await expect(pending).rejects.toThrow("selected session changed");
      }
      expect(changed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
);

beforeEach(() => {
  setRuntimeConfigSnapshot({ agents: { entries: { main: {}, other: {} } } });
});

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
});

it("keeps prepared entry authority current through native and worker writes without host SQL", async () => {
  const scope = makeScope("entry-current-publication-", "agent:main:entry-current");
  const { env } = scope;
  const initial: InternalSessionEntry = {
    sessionId: "original",
    updatedAt: 1,
    execHost: "node",
    execNode: "original-node",
  };
  replaceSessionEntrySync(scope, initial);
  type Prepared = Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>;
  const prepared: Prepared[] = [];
  const sources = new Map<Prepared, PreparedSessionSourceAuthority>();
  const capture = async (fields?: ("execHost" | "execNode")[]) => {
    const check = await captureSessionEntryCurrentCheckAsyncInternal({ ...scope, fields });
    prepared.push(check);
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      sources.set(check, await check.source.prepareSessionSource());
      expect(requests).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
    }
    return check;
  };
  const expectCurrent = async (check: Prepared, current: boolean) => {
    const sql = observeHostDataSql();
    try {
      if (current) {
        expect(() => check.source()).not.toThrow();
        expect(() => sources.get(check)!.assertCurrent()).not.toThrow();
      } else {
        expect(() => check.source()).toThrow("selected session changed");
        expect(() => sources.get(check)!.assertCurrent()).toThrow("selected session changed");
      }
      await expect(check.isCurrent()).resolves.toBe(current);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  };
  try {
    const generation = await capture();
    const policy = await capture(["execHost", "execNode"]);
    beginOtherAgentDeletion(env);
    await expectCurrent(generation, true);
    await expectCurrent(policy, true);
    // Borrowed snapshots may be frozen; caller edits cannot change retained policy either way.
    Reflect.set(policy.entry!, "execNode", "caller-local-edit");
    await expectCurrent(policy, true);
    const released = await policy.source.prepareSessionSource();
    await released.release?.();
    // A mutation borrows the selected entry; finishing it does not revoke its caller.
    await expectCurrent(policy, true);

    replaceSessionEntrySync(scope, { ...initial, displayName: "Native metadata edit" });
    await expectCurrent(policy, true);
    await expectCurrent(generation, true);

    await patchSessionEntryCore(scope, () => ({ displayName: "Worker metadata edit" }), {
      skipMaintenance: true,
    });
    await expectCurrent(policy, true);
    await expectCurrent(generation, true);

    // Final effect guards must observe revocation after awaited owner work.
    await patchSessionEntryCore(scope, () => ({ execNode: "replacement-node" }), {
      skipMaintenance: true,
    });
    await expectCurrent(policy, false);
    await expectCurrent(generation, true);

    replaceSessionEntrySync(scope, { ...initial, sessionId: "replacement", updatedAt: 2 });
    await expectCurrent(generation, false);
    const replacement = await capture();
    await expectCurrent(replacement, true);
    await expect(
      deleteSessionEntryLifecycle({
        ...scope,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      }),
    ).resolves.toMatchObject({ deleted: true });
    await expectCurrent(replacement, false);

    const absent = await capture();
    expect(absent.entry).toBeUndefined();
    await expectCurrent(absent, true);
    await replaceSessionEntry(scope, { ...initial, sessionId: "created-again", updatedAt: 3 });
    await expectCurrent(absent, false);
    const lifecycle = await capture();
    await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "next-generation" }), {
      skipMaintenance: true,
    });
    await expectCurrent(lifecycle, false);
    const unreadable = await capture();
    const moved = `${scope.storePath}.unavailable`;
    fs.renameSync(scope.storePath, moved);
    try {
      await expectCurrent(unreadable, false);
    } finally {
      fs.renameSync(moved, scope.storePath);
    }
    const latest = await capture();
    latest.release();
    await expectCurrent(latest, false);
  } finally {
    for (const check of prepared) {
      check.release();
      await sources.get(check)?.release?.();
    }
  }
});

it("revokes absent entry authority when a managed write creates its missing database", async () => {
  const scope = makeScope("entry-current-missing-database-", "agent:main:entry-current");
  expect(fs.existsSync(scope.storePath)).toBe(false);
  const check = await captureSessionEntryCurrentCheckAsyncInternal({
    ...scope,
    fields: ["execHost"],
  });
  try {
    expect(check.entry).toBeUndefined();
    expect(fs.existsSync(scope.storePath)).toBe(false);
    expect(() => check.source()).not.toThrow();
    await expect(check.isCurrent()).resolves.toBe(true);
    const source = await check.source.prepareSessionSource();

    await replaceSessionEntry(scope, { sessionId: "created", updatedAt: 1, execHost: "node" });

    const sql = observeMainThreadSql();
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      expect(() => check.source()).toThrow("selected session changed");
      expect(() => source.assertCurrent()).toThrow("selected session changed");
      await expect(check.isCurrent()).resolves.toBe(false);
      sql.expectIdle();
      expect(requests).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
      sql.restore();
    }
  } finally {
    check.release();
  }
});

it("retains ID-selected policy and absence without revoking unrelated publications", async () => {
  const scope = makeScope("entry-current-id-", "agent:main:selected");
  const { env } = scope;
  const initial: InternalSessionEntry = { sessionId: "selected", updatedAt: 1, execHost: "node" };
  replaceSessionEntrySync(scope, initial);
  const selected = await captureSessionEntryCurrentCheckAsyncInternal({
    ...scope,
    sessionKey: "agent:main:ignored-key",
    sessionId: "selected",
    fields: ["execHost"],
  });
  const absent = await captureSessionEntryCurrentCheckAsyncInternal({
    agentId: scope.agentId,
    storePath: scope.storePath,
    env,
    sessionId: "missing",
  });
  try {
    expect(selected.entry?.execHost).toBe("node");
    expect(absent.entry).toBeUndefined();
    const selectedSource = await selected.source.prepareSessionSource();
    const absentSource = await absent.source.prepareSessionSource();
    replaceSessionEntrySync(scope, { ...initial, displayName: "Metadata edit" });
    await replaceSessionEntry(
      { ...scope, sessionKey: "agent:main:unrelated" },
      { sessionId: "unrelated", updatedAt: 2 },
    );
    const sql = observeHostDataSql();
    try {
      expect(() => selectedSource.assertCurrent()).not.toThrow();
      expect(() => absentSource.assertCurrent()).not.toThrow();
      await expect(selected.isCurrent()).resolves.toBe(true);
      await expect(absent.isCurrent()).resolves.toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    await patchSessionEntryCore(scope, () => ({ execHost: "gateway" }), {
      skipMaintenance: true,
    });
    expect(() => selectedSource.assertCurrent()).toThrow("selected session changed");
    await expect(selected.assertCurrent()).rejects.toThrow("selected session changed");
    absent.release();
    expect(() => absentSource.assertCurrent()).toThrow("selected session changed");
  } finally {
    selected.release();
    absent.release();
  }
});

const conversationAddress = {
  channel: "slack",
  accountId: "default",
  kind: "channel" as const,
  peerId: "channel:C_SYNTHETIC",
};

function conversationEntry(sessionId: string, updatedAt: number): InternalSessionEntry {
  return {
    sessionId,
    updatedAt,
    chatType: "channel" as const,
    delivery: normalizeSessionDeliveryState({
      context: {
        channel: conversationAddress.channel,
        accountId: conversationAddress.accountId,
        to: conversationAddress.peerId,
      },
    }),
  };
}

type CurrentCheck = Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>;

function expectConversationCurrentWithoutSql(check: CurrentCheck, current: boolean) {
  withoutHostIo(() => {
    if (current) {
      expect(() => check.source()).not.toThrow();
    } else {
      expect(() => check.source()).toThrow("selected session changed");
    }
  });
}

it.each([true, false])(
  "publishes current conversation ownership through worker writes (matchGeneration=%s)",
  async (matchGeneration) => {
    const scope = makeScope("conversation-current-worker-", "agent:main:chosen");
    const competitor = { ...scope, sessionKey: "agent:main:competitor" };
    await replaceSessionEntry(scope, conversationEntry("chosen", 10));
    const check = await captureSessionEntryCurrentCheckAsyncInternal({
      ...scope,
      matchGeneration,
      alternatives: [{ conversations: [{ ...conversationAddress, sessionKey: scope.sessionKey }] }],
    });
    try {
      expectConversationCurrentWithoutSql(check, true);
      await replaceSessionEntry(
        { ...scope, sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 50 },
      );
      expectConversationCurrentWithoutSql(check, true);

      // Another node can win the route while the selected entry stays byte-identical.
      await replaceSessionEntry(competitor, conversationEntry("competitor", 20));
      expectConversationCurrentWithoutSql(check, false);
      await expect(check.isCurrent()).resolves.toBe(false);
      await deleteSessionEntryLifecycle({
        ...competitor,
        target: { canonicalKey: competitor.sessionKey, storeKeys: [competitor.sessionKey] },
        archiveTranscript: false,
      });
      // Deleting the winner exposes the older candidate; retaining only the winner loses it.
      expectConversationCurrentWithoutSql(check, true);

      await replaceSessionEntry(scope, conversationEntry("replacement", 30));
      expectConversationCurrentWithoutSql(check, !matchGeneration);
      await expect(check.isCurrent()).resolves.toBe(!matchGeneration);
    } finally {
      check.release();
    }
  },
);

it("keeps tentative conversation authority local to native commit and rollback", async () => {
  const scope = makeScope("conversation-current-rollback-", "agent:main:chosen");
  const { env } = scope;
  const competitor = { ...scope, sessionKey: "agent:main:competitor" };
  await replaceSessionEntry(scope, conversationEntry("chosen", 10));
  const check = await captureSessionEntryCurrentCheckAsyncInternal({
    ...scope,
    matchGeneration: false,
    alternatives: [{ conversations: [{ ...conversationAddress, sessionKey: scope.sessionKey }] }],
  });
  try {
    expectConversationCurrentWithoutSql(check, true);
    const rollback = new Error("Roll back the synthetic route");
    expect(() =>
      runOpenClawAgentWriteTransaction(
        () => {
          replaceSessionEntrySync(competitor, conversationEntry("competitor", 20));
          expectConversationCurrentWithoutSql(check, false);
          throw rollback;
        },
        { agentId: scope.agentId, path: scope.storePath, env },
      ),
    ).toThrow(rollback);
    expectConversationCurrentWithoutSql(check, true);
    replaceSessionEntrySync(competitor, conversationEntry("competitor", 20));
    expectConversationCurrentWithoutSql(check, false);
  } finally {
    check.release();
  }
});

it("revokes cold conversation authority when its database reader is retired", async () => {
  const scope = makeScope("conversation-current-retirement-", "agent:main:chosen");
  await replaceSessionEntry(scope, conversationEntry("chosen", 10));
  await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
  const check = await captureSessionEntryCurrentCheckAsyncInternal({
    ...scope,
    matchGeneration: false,
    alternatives: [{ conversations: [{ ...conversationAddress, sessionKey: scope.sessionKey }] }],
  });
  try {
    expectConversationCurrentWithoutSql(check, true);
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    expectConversationCurrentWithoutSql(check, false);
  } finally {
    check.release();
  }
});

it.each([
  { existing: false, native: false },
  { existing: true, native: false },
  { existing: false, native: true },
])(
  "isolates foreign conversation absence (existing store=$existing, native=$native)",
  async ({ existing, native }) => {
    const scope = makeScope("conversation-current-stores-", "agent:main:chosen");
    const { env } = scope;
    const foreign = {
      agentId: "other",
      sessionKey: "agent:other:foreign",
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "other", env }),
      env,
    };
    await replaceSessionEntry(scope, conversationEntry("chosen", 10));
    if (existing) {
      await replaceSessionEntry(foreign, { sessionId: "foreign", updatedAt: 10 });
    } else {
      expect(fs.existsSync(foreign.storePath)).toBe(false);
    }
    const check = await captureSessionEntryCurrentCheckAsyncInternal({
      ...scope,
      alternatives: [
        {
          conversations: [
            { ...conversationAddress, sessionKey: scope.sessionKey },
            {
              ...conversationAddress,
              agentId: foreign.agentId,
              storePath: foreign.storePath,
              sessionKey: null,
            },
          ],
        },
      ],
    });
    const { conversationRef } = buildConversationIdentity({
      ...conversationAddress,
      deliveryTarget: conversationAddress.peerId,
    })!;
    const binding = await captureConversationBindingFacts(foreign, [conversationRef]);
    const assertBinding = (expected: string | null) => {
      const sql = observeMainThreadSql();
      try {
        expect(binding.currentSessionKey(conversationRef)).toBe(expected);
        expect(sql.count()).toBe(0);
      } finally {
        sql.restore();
      }
    };
    try {
      assertBinding(null);
      expectConversationCurrentWithoutSql(check, true);
      await replaceSessionEntry(scope, {
        ...conversationEntry("chosen", 20),
        displayName: "Updated",
      });
      assertBinding(null);
      expectConversationCurrentWithoutSql(check, true);
      if (native) {
        const rollback = new Error("roll back first foreign conversation");
        expect(() =>
          runOpenClawAgentWriteTransaction(
            () => {
              replaceSessionEntrySync(foreign, conversationEntry("foreign", 30));
              assertBinding(foreign.sessionKey);
              throw rollback;
            },
            { agentId: foreign.agentId, path: foreign.storePath, env },
          ),
        ).toThrow(rollback);
        assertBinding(null);
        replaceSessionEntrySync(foreign, conversationEntry("foreign", 30));
      } else {
        await replaceSessionEntry(foreign, conversationEntry("foreign", 30));
      }
      // Exercise the publication owner directly, without platform path-currentness guards.
      assertBinding(foreign.sessionKey);
      expectConversationCurrentWithoutSql(check, false);
      await expect(check.isCurrent()).resolves.toBe(false);
    } finally {
      binding.release();
      check.release();
    }
  },
);

it("matches an absent conversation capture key to the writer receipt canonicalPath", async () => {
  const scope = makeScope("conversation-canonical-capture-", "agent:main:canonical-capture");
  const { conversationRef } = buildConversationIdentity({
    ...conversationAddress,
    deliveryTarget: conversationAddress.peerId,
  })!;
  const capturePath = path.relative(process.cwd(), scope.storePath);
  const captureKey = resolveDatabasePathKey(capturePath);
  expect(capturePath).not.toBe(captureKey);
  expect(fs.existsSync(scope.storePath)).toBe(false);
  const binding = retainConversationBindingFacts([conversationRef], capturePath);
  binding.acknowledge({ catalogues: [], associations: [], windows: [], nodes: [] });
  const receiptPaths: string[] = [];
  const unsubscribe = conversationPublication.subscribe((receipt) => {
    receiptPaths.push(receipt.source.canonicalPath);
  });
  try {
    expect(binding.currentSessionKey(conversationRef)).toBeNull();
    await replaceSessionEntry(scope, conversationEntry("canonical-capture", 10));
    expect(receiptPaths).toContain(captureKey);
    withoutHostIo(() => {
      expect(binding.currentSessionKey(conversationRef)).toBe(scope.sessionKey);
    });
  } finally {
    unsubscribe();
    binding.release();
  }
});

it("refuses an absent-store capture during receipt-less publication through a directory alias", () => {
  const root = tempDirs.make("conversation-pending-alias-");
  const directory = path.join(root, "store");
  const alias = path.join(root, "alias");
  fs.mkdirSync(directory);
  fs.symlinkSync(directory, alias, "junction");
  const databasePath = path.join(alias, "agent.sqlite");
  const canonicalPath = resolveDatabasePathKey(databasePath);
  expect(databasePath).not.toBe(canonicalPath);
  expect(fs.existsSync(databasePath)).toBe(false);
  const publication = retainConversationWorkerPublication("file:1:2", databasePath);
  publication.begin();
  const binding = retainConversationBindingFacts(["pending-conversation"], canonicalPath);
  binding.acknowledge({ catalogues: [], associations: [], windows: [], nodes: [] });
  const sql = observeMainThreadSql();
  try {
    expect(() => binding.currentSessionKey("pending-conversation")).toThrow(
      "Conversation binding publication is unavailable",
    );
    publication.settle([], true);
    expect(() => binding.currentSessionKey("pending-conversation")).toThrow(
      "Conversation binding publication is unavailable",
    );
    sql.expectIdle();
  } finally {
    publication.settle();
    binding.release();
    sql.restore();
  }
});
