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
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import {
  testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  resolveGenericCurrentConversationBindingAsync,
  touchGenericCurrentConversationBindingAsync,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import { inspectSessionBindingByConversation } from "./session-binding-service.js";
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

function replacePersistedBinding(record: SessionBindingRecord): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
    executeSqliteQuerySync(
      db,
      bindingDb
        .updateTable("current_conversation_bindings")
        .set({
          binding_id: record.bindingId,
          target_session_key: record.targetSessionKey,
          target_kind: record.targetKind,
          status: record.status,
          bound_at: record.boundAt,
          expires_at: record.expiresAt ?? null,
          metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
          record_json: JSON.stringify(record),
          updated_at: Date.now(),
        })
        .where("binding_key", "=", buildConversationKey(record.conversation)),
    );
  });
}

function readPersistedBinding(conversationId: string): SessionBindingRecord | null {
  const { db } = openOpenClawStateDatabase();
  const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
  const row = executeSqliteQuerySync(
    db,
    bindingDb
      .selectFrom("current_conversation_bindings")
      .select("record_json")
      .where("binding_key", "=", buildConversationKey(workspaceConversation(conversationId))),
  ).rows[0];
  return row ? (JSON.parse(row.record_json) as SessionBindingRecord) : null;
}

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry(
      ["workspace", "forum"].map((id) => ({
        pluginId: id,
        source: "test",
        plugin: {
          id,
          meta: { aliases: [] },
          conversationBindings: { supportsCurrentConversationBinding: true },
        },
      })),
    ),
  );
}

async function withReadOnlyStateDatabase<T>(run: () => T | Promise<T>): Promise<T> {
  const { db } = openOpenClawStateDatabase();
  db.exec("PRAGMA query_only = ON");
  try {
    return await run();
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
}

async function withRejectedBindingCommit<T>(run: () => Promise<T>): Promise<T> {
  const injected = probe.admission(admission, (request, grant, admit) => {
    if (request.stage === "commit") {
      throw new Error("Injected binding commit failure");
    }
    admit(request, grant);
  });
  try {
    return await run();
  } finally {
    injected.mockRestore();
  }
}

function workspaceConversation(conversationId: string) {
  return {
    channel: "workspace",
    accountId: "default",
    conversationId,
  };
}

async function bindWorkspaceConversation(
  conversationId: string,
  options: {
    targetSessionKey?: string;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<SessionBindingRecord | null> {
  return bindGenericCurrentConversation({
    targetSessionKey: options.targetSessionKey ?? "agent:codex:acp:workspace-dm",
    targetKind: "session",
    conversation: workspaceConversation(conversationId),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
}

function resolveWorkspaceConversation(
  conversationId: string,
): Promise<SessionBindingRecord | null> {
  return resolveGenericCurrentConversationBindingAsync(workspaceConversation(conversationId));
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    testing.clearPersistedCurrentConversationBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    testing.clearPersistedCurrentConversationBindingsForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("inspects expired ownership without deleting the durable row", async () => {
    const binding = expectSessionBinding(await bindWorkspaceConversation("user:inspection"));
    const expired = { ...binding, expiresAt: 1 };
    replacePersistedBinding(expired);
    expect(
      inspectSessionBindingByConversation(workspaceConversation("user:inspection")),
    ).toMatchObject({ status: "available", binding: null });
    expect(readPersistedBinding("user:inspection")).toEqual(expired);
  });

  it("stores Control UI session-key conversations without a channel plugin", async () => {
    setActivePluginRegistry(createTestRegistry([]));
    expect(
      getGenericCurrentConversationBindingCapabilities({
        channel: "webchat",
        accountId: "default",
      }),
    ).toMatchObject({ bindSupported: true, placements: ["current"] });

    const bound = await bindGenericCurrentConversation({
      targetSessionKey: "agent:main:adopted",
      targetKind: "session",
      conversation: {
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      },
      metadata: { pluginBindingOwner: "plugin", pluginId: "codex", pluginRoot: "/codex" },
    });

    expectBindingFields(bound, {
      targetSessionKey: "agent:main:adopted",
      conversation: {
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      },
    });
    expectBindingFields(
      await resolveGenericCurrentConversationBindingAsync({
        channel: "webchat",
        accountId: "default",
        conversationId: "agent:main:adopted",
      }),
      { targetSessionKey: "agent:main:adopted" },
    );
  });

  describe("independent SQLite owners", () => {
    it.each(["bind", "touch", "expiry cleanup", "unbind"] as const)(
      "preserves independently inserted and updated rows during %s",
      async (mutation) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
        const owned = expectSessionBinding(await bindWorkspaceConversation("user:owner"));
        const previousExternal = expectSessionBinding(
          await bindWorkspaceConversation("user:updated", {
            targetSessionKey: "agent:codex:acp:old-target",
            metadata: { version: "before" },
          }),
        );
        await bindWorkspaceConversation("user:expired", { ttlMs: 1_000 });

        const latestExternal: SessionBindingRecord = {
          ...previousExternal,
          targetSessionKey: "agent:codex:acp:latest-target",
          metadata: { version: "latest", opaque: { nested: true } },
        };
        replacePersistedBinding(latestExternal);
        seedPersistedBinding({
          ...owned,
          bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:inserted",
          targetSessionKey: "agent:codex:acp:inserted-target",
          conversation: workspaceConversation("user:inserted"),
          metadata: { opaque: "external owner" },
        });

        switch (mutation) {
          case "bind":
            await bindWorkspaceConversation("user:replacement");
            break;
          case "touch":
            await touchGenericCurrentConversationBindingAsync(owned.bindingId, 1_000_500);
            break;
          case "expiry cleanup":
            vi.setSystemTime(new Date(1_002_000));
            expect(await resolveWorkspaceConversation("user:expired")).toBeNull();
            break;
          case "unbind":
            await unbindGenericCurrentConversationBindings({
              bindingId: owned.bindingId,
              reason: "owner cleanup",
            });
            break;
        }

        expectBindingFields(readPersistedBinding("user:inserted"), {
          targetSessionKey: "agent:codex:acp:inserted-target",
        });
        expectBindingFields(readPersistedBinding("user:updated"), {
          targetSessionKey: "agent:codex:acp:latest-target",
        });
        expectBindingMetadata(readPersistedBinding("user:updated"), {
          version: "latest",
          opaque: { nested: true },
        });

        closeOpenClawStateDatabaseForTest();
        expect((await resolveWorkspaceConversation("user:inserted"))?.targetSessionKey).toBe(
          "agent:codex:acp:inserted-target",
        );
        expect((await resolveWorkspaceConversation("user:updated"))?.targetSessionKey).toBe(
          "agent:codex:acp:latest-target",
        );
      },
    );

    it("touches the latest committed target and complete opaque metadata", async () => {
      const initial = expectSessionBinding(
        await bindWorkspaceConversation("user:owner", {
          targetSessionKey: "agent:codex:acp:old-target",
          metadata: { stale: true },
        }),
      );
      replacePersistedBinding({
        ...initial,
        targetSessionKey: "agent:codex:acp:latest-target",
        metadata: {
          opaque: { nested: ["latest", { preserved: true }] },
          lastActivityAt: 10,
        },
      });

      await touchGenericCurrentConversationBindingAsync(initial.bindingId, 20);

      expectBindingFields(readPersistedBinding("user:owner"), {
        targetSessionKey: "agent:codex:acp:latest-target",
      });
      expectBindingMetadata(readPersistedBinding("user:owner"), {
        opaque: { nested: ["latest", { preserved: true }] },
        lastActivityAt: 20,
      });
      expect((await resolveWorkspaceConversation("user:owner"))?.targetSessionKey).toBe(
        "agent:codex:acp:latest-target",
      );
    });

    it("does not hide another owner's committed row after a failed write", async () => {
      const owned = expectSessionBinding(await bindWorkspaceConversation("user:owner"));
      seedPersistedBinding({
        ...owned,
        bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:external",
        targetSessionKey: "agent:codex:acp:external-target",
        conversation: workspaceConversation("user:external"),
        metadata: { opaque: { survives: true } },
      });

      await expect(
        withRejectedBindingCommit(() =>
          bindWorkspaceConversation("user:owner", {
            targetSessionKey: "agent:codex:acp:failed-target",
          }),
        ),
      ).rejects.toThrow();

      expect((await resolveWorkspaceConversation("user:owner"))?.targetSessionKey).toBe(
        owned.targetSessionKey,
      );
      expect((await resolveWorkspaceConversation("user:external"))?.targetSessionKey).toBe(
        "agent:codex:acp:external-target",
      );
      expectBindingMetadata(readPersistedBinding("user:external"), {
        opaque: { survives: true },
      });
    });
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    seedPersistedBinding({
      bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
      targetSessionKey: " agent:codex:acp:forum-dm ",
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

    const resolved = await resolveGenericCurrentConversationBindingAsync({
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

    expect(
      await resolveGenericCurrentConversationBindingAsync({
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
      }),
    ).toBeNull();
  });

  it.each(["touch", "unbind"] as const)(
    "supports %s by the canonical id returned for an unrepaired legacy self-parent row",
    async (operation) => {
      const conversation = {
        channel: "forum",
        accountId: "default",
        conversationId: "6098642967",
        parentConversationId: "6098642967",
      };
      seedPersistedBinding({
        bindingId: "generic:forum\u241fdefault\u241f6098642967\u241f6098642967",
        targetSessionKey: "agent:codex:acp:forum-dm",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1_234,
        metadata: { opaque: { preserved: true } },
      });

      const listed = expectSessionBinding(
        listGenericCurrentConversationBindingsBySession("agent:codex:acp:forum-dm")[0] ?? null,
      );
      expect(listed.bindingId).toBe("generic:forum\u241fdefault\u241f\u241f6098642967");

      if (operation === "touch") {
        await touchGenericCurrentConversationBindingAsync(listed.bindingId, 9_876);
        expectBindingMetadata(await resolveGenericCurrentConversationBindingAsync(conversation), {
          opaque: { preserved: true },
          lastActivityAt: 9_876,
        });
        return;
      }

      const removed = await unbindGenericCurrentConversationBindings({
        bindingId: listed.bindingId,
        reason: "legacy owner cleanup",
      });
      expect(removed).toHaveLength(1);
      expect(listGenericCurrentConversationBindingsBySession("agent:codex:acp:forum-dm")).toEqual(
        [],
      );
    },
  );

  it("unbinds durable generic rows without invoking reentrant plugin policy in a write transaction", async () => {
    const targetSessionKey = "agent:codex:acp:workspace-dm";
    const bound = expectSessionBinding(await bindWorkspaceConversation("user:policy-owner"));
    const policy = vi.fn(() => {
      runOpenClawStateWriteTransaction(() => undefined);
      return true;
    });
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
              isCurrentConversationBindingSupported: policy,
            },
          },
        },
      ]),
    );

    const removed = await unbindGenericCurrentConversationBindings({
      targetSessionKey,
      reason: "owner cleanup",
    });

    expect(removed).toEqual([bound]);
    expect(policy).not.toHaveBeenCalled();
    expect(readPersistedBinding("user:policy-owner")).toBeNull();
  });

  it("drops persisted bindings with invalid expiration timestamps", async () => {
    seedPersistedBinding({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: workspaceConversation("user:U123"),
      status: "active",
      boundAt: 1234,
      expiresAt: 8_640_000_000_000_001,
    });

    expect(
      await resolveGenericCurrentConversationBindingAsync(workspaceConversation("user:U123")),
    ).toBeNull();
  });

  it("does not bind generic current conversations when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    await expect(
      bindGenericCurrentConversation({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        targetKind: "session",
        conversation: workspaceConversation("user:U123"),
        ttlMs: 1,
      }),
    ).resolves.toBeNull();
    expect(
      await resolveGenericCurrentConversationBindingAsync(workspaceConversation("user:U123")),
    ).toBeNull();
  });

  describe("SQLite write failures", () => {
    it("keeps committed activity unchanged when a touch write fails", async () => {
      const bound = expectSessionBinding(
        await bindWorkspaceConversation("user:U1", { metadata: { label: "workspace-dm" } }),
      );
      const originalActivity = bound.metadata?.lastActivityAt;

      await expect(
        withRejectedBindingCommit(() =>
          touchGenericCurrentConversationBindingAsync(bound.bindingId, 9_999_999),
        ),
      ).rejects.toThrow();

      expect((await resolveWorkspaceConversation("user:U1"))?.metadata?.lastActivityAt).toBe(
        originalActivity,
      );
    });

    it("keeps an expired binding when prune-on-resolve fails", async () => {
      const binding = expectSessionBinding(await bindWorkspaceConversation("user:U1"));
      const expired = { ...binding, expiresAt: 1 };
      replacePersistedBinding(expired);
      await expect(
        withRejectedBindingCommit(() => resolveWorkspaceConversation("user:U1")),
      ).rejects.toThrow();
      expect(readPersistedBinding("user:U1")).toEqual(expired);
    });

    it("keeps expired list entries when their cleanup write fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey, ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() =>
          listGenericCurrentConversationBindingsBySession(targetSessionKey),
        ),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
    });

    it("does not partially prune an unbind-by-session batch", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey, ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withRejectedBindingCommit(() =>
          unbindGenericCurrentConversationBindings({
            targetSessionKey,
            reason: "test cleanup",
          }),
        ),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listGenericCurrentConversationBindingsBySession(targetSessionKey)).toHaveLength(2);
    });
  });
});
