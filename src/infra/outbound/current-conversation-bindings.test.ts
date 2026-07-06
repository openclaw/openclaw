// Verifies generic current-conversation binding persistence, TTL pruning,
// capability discovery, touch, list, and unbind behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as openClawStateDb from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import * as kyselySync from "../kysely-sync.js";
import {
  testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  resolveGenericCurrentConversationBinding,
  touchGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

function expectSessionBinding(bound: SessionBindingRecord | null): SessionBindingRecord {
  if (bound === null) {
    throw new Error("Expected current-conversation binding");
  }
  return bound;
}

function expectBindingFields(
  binding: SessionBindingRecord | null | undefined,
  expected: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  const record = expectSessionBinding(binding ?? null);
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key as keyof SessionBindingRecord]).toEqual(value);
  }
  return record;
}

function expectBindingMetadata(
  binding: SessionBindingRecord | null | undefined,
  expected: Record<string, unknown>,
): void {
  const metadata = expectSessionBinding(binding ?? null).metadata;
  for (const [key, value] of Object.entries(expected)) {
    expect(metadata?.[key]).toEqual(value);
  }
}

function buildConversationKey(ref: SessionBindingRecord["conversation"]): string {
  return [ref.channel, ref.accountId, ref.parentConversationId ?? "", ref.conversationId].join(
    "\u241f",
  );
}

function seedPersistedBinding(record: SessionBindingRecord): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
    executeSqliteQuerySync(
      db,
      bindingDb.insertInto("current_conversation_bindings").values({
        binding_key: buildConversationKey(record.conversation),
        binding_id: record.bindingId,
        target_agent_id: "codex",
        target_session_id: null,
        target_session_key: record.targetSessionKey,
        channel: record.conversation.channel,
        account_id: record.conversation.accountId,
        conversation_kind: "current",
        parent_conversation_id: record.conversation.parentConversationId ?? null,
        conversation_id: record.conversation.conversationId,
        target_kind: record.targetKind,
        status: record.status,
        bound_at: record.boundAt,
        expires_at: record.expiresAt ?? null,
        metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
        record_json: JSON.stringify(record),
        updated_at: record.boundAt,
      }),
    );
  });
}

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "workspace",
        source: "test",
        plugin: {
          id: "workspace",
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
          },
        },
      },
    ]),
  );
}

async function bindWorkspaceConversation(
  conversationId: string,
  overrides?: { targetSessionKey?: string; ttlMs?: number; metadata?: Record<string, unknown> },
): Promise<SessionBindingRecord | null> {
  return bindGenericCurrentConversation({
    targetSessionKey: overrides?.targetSessionKey ?? "agent:codex:acp:workspace-dm",
    targetKind: "session",
    conversation: { channel: "workspace", accountId: "default", conversationId },
    ...(overrides?.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
    ...(overrides?.metadata ? { metadata: overrides.metadata } : {}),
  });
}

function resolveWorkspaceConversation(conversationId: string): SessionBindingRecord | null {
  return resolveGenericCurrentConversationBinding({
    channel: "workspace",
    accountId: "default",
    conversationId,
  });
}

function throwOnNextStateWrite(): void {
  vi.spyOn(openClawStateDb, "runOpenClawStateWriteTransaction").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("advertises support only for channels that opt into current-conversation binds", () => {
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "workspace",
        accountId: "default",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "definitely-not-a-channel",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("requires an active channel plugin registration", () => {
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "workspace",
        accountId: "default",
      }),
    ).toBeNull();
  });

  it("reloads persisted bindings after the in-memory cache is cleared", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "workspace-dm",
      },
    });

    expectBindingFields(bound, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });

    testing.resetCurrentConversationBindingsForTests();

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
  });

  it("normalizes persisted target session keys on reload", async () => {
    seedPersistedBinding({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: " agent:codex:acp:workspace-dm ",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1234,
      metadata: {
        label: "workspace-dm",
      },
    });

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });

    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
    const bindings = listGenericCurrentConversationBindingsBySession(
      "agent:codex:acp:workspace-dm",
    );
    expect(bindings).toHaveLength(1);
    expectBindingFields(bindings[0], {
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
  });

  it("drops self-parent conversation refs when storing generic current bindings", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:forum-dm",
      targetKind: "session",
      conversation: {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      },
    });

    const boundRecord = expectBindingFields(bound, {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
    });
    expect(boundRecord.conversation).toEqual({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });
    expect(bound?.conversation.parentConversationId).toBeUndefined();
    expectBindingFields(
      resolveGenericCurrentConversationBinding({
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
      }),
      {
        bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
        targetSessionKey: "agent:codex:acp:forum-dm",
      },
    );
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    seedPersistedBinding({
      bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
      targetSessionKey: "agent:codex:acp:forum-dm",
      targetKind: "session",
      conversation: {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      },
      status: "active",
      boundAt: 1234,
      metadata: {
        label: "forum-dm",
      },
    });

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });

    const resolvedRecord = expectBindingFields(resolved, {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
      targetSessionKey: "agent:codex:acp:forum-dm",
    });
    expect(resolvedRecord.conversation).toEqual({
      channel: "forum",
      accountId: "default",
      conversationId: "6098642967",
    });
    expect(resolved?.conversation.parentConversationId).toBeUndefined();

    const unbound = await unbindGenericCurrentConversationBindings({
      bindingId: resolved?.bindingId,
      reason: "test cleanup",
    });
    expect(unbound).toHaveLength(1);
    expectBindingFields(unbound[0], {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
    });

    testing.resetCurrentConversationBindingsForTests();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
      }),
    ).toBeNull();
  });

  it("removes persisted bindings on unbind", async () => {
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      targetKind: "session",
      conversation: {
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      },
    });

    await unbindGenericCurrentConversationBindings({
      targetSessionKey: "agent:codex:acp:googlechat-room",
      reason: "test cleanup",
    });

    testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      }),
    ).toBeNull();
  });

  it("drops persisted bindings with invalid expiration timestamps", async () => {
    seedPersistedBinding({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1234,
      expiresAt: 8_640_000_000_000_001,
    });

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("does not bind generic current conversations when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    await expect(
      bindGenericCurrentConversation({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        targetKind: "session",
        conversation: {
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        },
        ttlMs: 1,
      }),
    ).resolves.toBeNull();
    expect(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("persists touched activity across reloads", async () => {
    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      metadata: {
        label: "workspace-dm",
      },
    });

    expectSessionBinding(bound);

    touchGenericCurrentConversationBinding(
      "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      1_234_567_890,
    );

    testing.resetCurrentConversationBindingsForTests();

    expectBindingMetadata(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
      {
        label: "workspace-dm",
        lastActivityAt: 1_234_567_890,
      },
    );
  });

  // A failed durable write must not leave the process-wide map ahead of disk:
  // bindingsLoaded is one-time, so a runtime-ahead map would be served until
  // restart. Mirrors the cron rollback proof in src/cron/service/ops.test.ts
  // ("cron service ops persist rollback", #99960).
  describe("persist rollback on durable write failure", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("restores the in-memory map when persisting a new bind fails", async () => {
      await bindWorkspaceConversation("user:U1");

      throwOnNextStateWrite();
      await expect(
        bindWorkspaceConversation("user:U2", { targetSessionKey: "agent:codex:acp:other-dm" }),
      ).rejects.toThrow("disk full");

      // Failed bind is absent from the live map; the prior bind still resolves.
      expect(resolveWorkspaceConversation("user:U2")).toBeNull();
      expectBindingFields(resolveWorkspaceConversation("user:U1"), {
        targetSessionKey: "agent:codex:acp:workspace-dm",
      });

      // Disk never received the failed bind either.
      testing.resetCurrentConversationBindingsForTests();
      expect(resolveWorkspaceConversation("user:U2")).toBeNull();
    });

    it("restores the in-memory map when persisting a touch fails", async () => {
      const bound = await bindWorkspaceConversation("user:U1", {
        metadata: { label: "workspace-dm" },
      });
      const boundRecord = expectSessionBinding(bound);
      const originalActivity = boundRecord.metadata?.lastActivityAt;

      throwOnNextStateWrite();
      expect(() =>
        touchGenericCurrentConversationBinding(boundRecord.bindingId, 9_999_999),
      ).toThrow("disk full");

      // The unpersisted lastActivityAt bump is rolled back in the live map.
      expectBindingMetadata(resolveWorkspaceConversation("user:U1"), {
        lastActivityAt: originalActivity,
      });
    });

    it("restores the in-memory map when persisting an unbind by binding id fails", async () => {
      const bound = await bindWorkspaceConversation("user:U1");

      throwOnNextStateWrite();
      await expect(
        unbindGenericCurrentConversationBindings({
          bindingId: expectSessionBinding(bound).bindingId,
          reason: "test cleanup",
        }),
      ).rejects.toThrow("disk full");

      // The binding is still served from memory and still on disk.
      expectBindingFields(resolveWorkspaceConversation("user:U1"), {
        targetSessionKey: "agent:codex:acp:workspace-dm",
      });
      testing.resetCurrentConversationBindingsForTests();
      expectBindingFields(resolveWorkspaceConversation("user:U1"), {
        targetSessionKey: "agent:codex:acp:workspace-dm",
      });
    });

    it("restores the in-memory map when persisting an unbind by session key fails", async () => {
      await bindWorkspaceConversation("user:U1", { targetSessionKey: "agent:codex:acp:shared" });
      await bindWorkspaceConversation("user:U2", { targetSessionKey: "agent:codex:acp:shared" });

      throwOnNextStateWrite();
      await expect(
        unbindGenericCurrentConversationBindings({
          targetSessionKey: "agent:codex:acp:shared",
          reason: "test cleanup",
        }),
      ).rejects.toThrow("disk full");

      // Every removed binding is restored to the live map.
      expect(
        listGenericCurrentConversationBindingsBySession("agent:codex:acp:shared"),
      ).toHaveLength(2);
    });

    it("does not resurrect a mid-scan pruned binding when an unbind by session batch fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      // One permanent and one expiring binding share the target session key.
      await bindWorkspaceConversation("user:U1", { targetSessionKey: "agent:codex:acp:shared" });
      await bindWorkspaceConversation("user:U2", {
        targetSessionKey: "agent:codex:acp:shared",
        ttlMs: 1000,
      });

      // Expire U2 so the by-session scan prunes (and persists) it before the
      // final batch delete of U1. Let that prune write succeed and fail only the
      // batch write, so the rollback must not reintroduce the pruned U2.
      vi.setSystemTime(new Date(1_002_000));
      const realWrite = openClawStateDb.runOpenClawStateWriteTransaction;
      let writes = 0;
      vi.spyOn(openClawStateDb, "runOpenClawStateWriteTransaction").mockImplementation(((
        operation,
        options,
      ) => {
        writes += 1;
        if (writes >= 2) {
          throw new Error("disk full");
        }
        return realWrite(operation, options);
      }) as typeof openClawStateDb.runOpenClawStateWriteTransaction);

      await expect(
        unbindGenericCurrentConversationBindings({
          targetSessionKey: "agent:codex:acp:shared",
          reason: "test cleanup",
        }),
      ).rejects.toThrow("disk full");

      // Roll time back so nothing reads as expired, then confirm the live binding
      // U1 is restored while the already-pruned U2 stays gone (map and disk
      // agree). Reload from disk to prove the same on the persisted side.
      vi.setSystemTime(new Date(1_000_500));
      vi.restoreAllMocks();
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
      expect(resolveWorkspaceConversation("user:U2")).toBeNull();
      testing.resetCurrentConversationBindingsForTests();
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
      expect(resolveWorkspaceConversation("user:U2")).toBeNull();
    });

    it("restores the in-memory map when persisting an expired prune-on-read fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      await bindWorkspaceConversation("user:U1", { ttlMs: 1000 });

      // Expire the binding after it is loaded so resolve triggers prune-on-read.
      vi.setSystemTime(new Date(1_002_000));
      throwOnNextStateWrite();
      expect(() => resolveWorkspaceConversation("user:U1")).toThrow("disk full");

      // The expired binding was restored (not dropped from the map ahead of disk).
      // Roll time back before expiry and confirm it is still served.
      vi.setSystemTime(new Date(1_000_500));
      expectBindingFields(resolveWorkspaceConversation("user:U1"), {
        targetSessionKey: "agent:codex:acp:workspace-dm",
      });
    });

    it("does not poison the one-time cache when the initial load fails", async () => {
      await bindWorkspaceConversation("user:U1");
      // Drop the in-memory cache but keep the row on disk so the next access reloads.
      testing.resetCurrentConversationBindingsForTests();

      vi.spyOn(kyselySync, "executeSqliteQuerySync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      // The first access triggers the load; it must throw before marking the
      // cache loaded, so the failure is not latched until restart.
      expect(() => resolveWorkspaceConversation("user:U1")).toThrow("disk full");

      // A subsequent access reloads from disk and serves the binding.
      expectBindingFields(resolveWorkspaceConversation("user:U1"), {
        targetSessionKey: "agent:codex:acp:workspace-dm",
      });
    });
  });
});
