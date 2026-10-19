import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import * as admission from "../sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../sqlite-worker-owner-probe.test-support.js";
import {
  testing,
  bindGenericCurrentConversation as bindGeneric,
  getGenericCurrentConversationBindingCapabilities as getCapabilities,
  listGenericCurrentConversationBindingsBySession as listBySession,
  resolveGenericCurrentConversationBinding as resolveGeneric,
  touchGenericCurrentConversationBinding as touchGeneric,
  unbindGenericCurrentConversationBindings as unbindGeneric,
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

function expectFields(
  binding: SessionBindingRecord | null | undefined,
  expected: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  const record = expectSessionBinding(binding ?? null);
  expect(record).toEqual(expect.objectContaining(expected));
  return record;
}

function expectMetadata(
  binding: SessionBindingRecord | null | undefined,
  expected: Record<string, unknown>,
): void {
  expect(expectSessionBinding(binding ?? null).metadata).toEqual(expect.objectContaining(expected));
}

function persistedFields(record: SessionBindingRecord) {
  return {
    binding_id: record.bindingId,
    target_session_key: record.targetSessionKey,
    target_kind: record.targetKind,
    status: record.status,
    bound_at: record.boundAt,
    expires_at: record.expiresAt ?? null,
    metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
    record_json: JSON.stringify(record),
  };
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
        ...persistedFields(record),
        channel: record.conversation.channel,
        account_id: record.conversation.accountId,
        conversation_kind: "current",
        parent_conversation_id: record.conversation.parentConversationId ?? null,
        conversation_id: record.conversation.conversationId,
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
          ...persistedFields(record),
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

function persistedRecord(
  conversation: SessionBindingRecord["conversation"],
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  return {
    bindingId: `generic:${buildConversationKey(conversation)}`,
    targetSessionKey: "agent:codex:acp:workspace-dm",
    targetKind: "session",
    conversation,
    status: "active",
    boundAt: 1234,
    ...overrides,
  };
}

const forumConversation = {
  channel: "forum",
  accountId: "default",
  conversationId: "6098642967",
};
function legacyForumRecord(overrides: Partial<SessionBindingRecord> = {}) {
  return persistedRecord(
    { ...forumConversation, parentConversationId: "6098642967" },
    {
      targetSessionKey: "agent:codex:acp:forum-dm",
      ...overrides,
    },
  );
}

async function bindWorkspaceConversation(
  conversationId: string,
  options: {
    targetSessionKey?: string;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<SessionBindingRecord | null> {
  return bindGeneric({
    targetSessionKey: options.targetSessionKey ?? "agent:codex:acp:workspace-dm",
    targetKind: "session",
    conversation: workspaceConversation(conversationId),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  });
}

function resolveWorkspaceConversation(conversationId: string): SessionBindingRecord | null {
  return resolveGeneric(workspaceConversation(conversationId));
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
    await closeStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(testStateDir, { recursive: true, force: true });
  });

  it("inspects expired ownership without deleting the durable row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const binding = await bindWorkspaceConversation("user:inspection", { ttlMs: 1_000 });
    expect(binding).not.toBeNull();
    vi.setSystemTime(new Date(1_002_000));
    expect(
      inspectSessionBindingByConversation({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:inspection",
      }),
    ).toMatchObject({ status: "available", binding: null });
    // Rewinding exposes whether inspection pruned the existing SQLite row.
    vi.setSystemTime(new Date(1_000_500));
    expect(resolveWorkspaceConversation("user:inspection")).not.toBeNull();
  });

  it("stores Control UI session-key conversations without a channel plugin", async () => {
    setActivePluginRegistry(createTestRegistry([]));
    const conversation = {
      channel: "webchat",
      accountId: "default",
      conversationId: "agent:main:adopted",
    };
    expect(getCapabilities(conversation)).toMatchObject({
      bindSupported: true,
      placements: ["current"],
    });
    const bound = await bindGeneric({
      targetSessionKey: "agent:main:adopted",
      targetKind: "session",
      conversation,
      metadata: { pluginBindingOwner: "plugin", pluginId: "codex", pluginRoot: "/codex" },
    });

    expectFields(bound, {
      targetSessionKey: "agent:main:adopted",
      conversation,
    });
    expectFields(resolveGeneric(conversation), { targetSessionKey: "agent:main:adopted" });
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
            touchGeneric(owned.bindingId, 1_000_500);
            break;
          case "expiry cleanup":
            vi.setSystemTime(new Date(1_002_000));
            expect(resolveWorkspaceConversation("user:expired")).toBeNull();
            break;
          case "unbind":
            await unbindGeneric({
              bindingId: owned.bindingId,
              reason: "owner cleanup",
            });
            break;
        }

        expectFields(readPersistedBinding("user:inserted"), {
          targetSessionKey: "agent:codex:acp:inserted-target",
        });
        expectFields(readPersistedBinding("user:updated"), {
          targetSessionKey: "agent:codex:acp:latest-target",
        });
        expectMetadata(readPersistedBinding("user:updated"), {
          version: "latest",
          opaque: { nested: true },
        });

        await closeStateDatabaseForTest();
        expect(resolveWorkspaceConversation("user:inserted")?.targetSessionKey).toBe(
          "agent:codex:acp:inserted-target",
        );
        expect(resolveWorkspaceConversation("user:updated")?.targetSessionKey).toBe(
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

      touchGeneric(initial.bindingId, 20);

      expectFields(readPersistedBinding("user:owner"), {
        targetSessionKey: "agent:codex:acp:latest-target",
      });
      expectMetadata(readPersistedBinding("user:owner"), {
        opaque: { nested: ["latest", { preserved: true }] },
        lastActivityAt: 20,
      });
      expect(resolveWorkspaceConversation("user:owner")?.targetSessionKey).toBe(
        "agent:codex:acp:latest-target",
      );
    });

    it.each(["rebind", "delete"] as const)(
      "never restores a stale row when another owner commits a %s during normalization",
      (mutation) => {
        const initial = persistedRecord(workspaceConversation("user:normalization-race"), {
          targetSessionKey: " agent:codex:acp:stale-target ",
          boundAt: 1_000,
          metadata: { version: "stale" },
        });
        seedPersistedBinding(initial);
        const latest: SessionBindingRecord = {
          ...initial,
          targetSessionKey: "agent:codex:acp:latest-target",
          metadata: { version: "latest", opaque: { preserved: true } },
        };
        const parseJson = JSON.parse;
        let committed = false;
        const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          const parsed = parseJson(text, reviver);
          if (!committed && text.includes("user:normalization-race")) {
            committed = true;
            if (mutation === "rebind") {
              replacePersistedBinding(latest);
            } else {
              runOpenClawStateWriteTransaction(({ db }) => {
                const bindingDb = getNodeSqliteKysely<CurrentConversationBindingDatabase>(db);
                executeSqliteQuerySync(
                  db,
                  bindingDb
                    .deleteFrom("current_conversation_bindings")
                    .where("binding_key", "=", buildConversationKey(initial.conversation)),
                );
              });
            }
          }
          return parsed;
        });

        try {
          const resolved = resolveWorkspaceConversation("user:normalization-race");
          if (mutation === "delete") {
            expect(resolved).toBeNull();
            expect(readPersistedBinding("user:normalization-race")).toBeNull();
            return;
          }
          expectFields(resolved, {
            targetSessionKey: "agent:codex:acp:latest-target",
          });
          expectMetadata(readPersistedBinding("user:normalization-race"), {
            version: "latest",
            opaque: { preserved: true },
          });
        } finally {
          parseSpy.mockRestore();
        }
      },
    );

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

      expect(resolveWorkspaceConversation("user:owner")?.targetSessionKey).toBe(
        owned.targetSessionKey,
      );
      expect(resolveWorkspaceConversation("user:external")?.targetSessionKey).toBe(
        "agent:codex:acp:external-target",
      );
      expectMetadata(readPersistedBinding("user:external"), {
        opaque: { survives: true },
      });
    });
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    seedPersistedBinding(
      legacyForumRecord({
        targetSessionKey: " agent:codex:acp:forum-dm ",
        metadata: { label: "forum-dm" },
      }),
    );

    const resolved = resolveGeneric(forumConversation);

    const resolvedRecord = expectFields(resolved, {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
      targetSessionKey: "agent:codex:acp:forum-dm",
    });
    expect(resolvedRecord.conversation).toEqual(forumConversation);
    expect(resolved?.conversation.parentConversationId).toBeUndefined();

    const unbound = await unbindGeneric({
      bindingId: resolved?.bindingId,
      reason: "test cleanup",
    });
    expect(unbound).toHaveLength(1);
    expectFields(unbound[0], {
      bindingId: "generic:forum\u241fdefault\u241f\u241f6098642967",
    });

    expect(resolveGeneric(forumConversation)).toBeNull();
  });

  it.each(["touch", "unbind"] as const)(
    "supports %s by the canonical id returned for an unrepaired legacy self-parent row",
    async (operation) => {
      const legacy = legacyForumRecord({
        metadata: { opaque: { preserved: true } },
      });
      seedPersistedBinding(legacy);

      const listed = expectSessionBinding(listBySession("agent:codex:acp:forum-dm")[0] ?? null);
      expect(listed.bindingId).toBe("generic:forum\u241fdefault\u241f\u241f6098642967");

      if (operation === "touch") {
        touchGeneric(listed.bindingId, 9_876);
        expectMetadata(resolveGeneric(legacy.conversation), {
          opaque: { preserved: true },
          lastActivityAt: 9_876,
        });
        return;
      }

      const removed = await unbindGeneric({
        bindingId: listed.bindingId,
        reason: "legacy owner cleanup",
      });
      expect(removed).toHaveLength(1);
      expect(listBySession("agent:codex:acp:forum-dm")).toEqual([]);
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

    const removed = await unbindGeneric({
      targetSessionKey,
      reason: "owner cleanup",
    });

    expect(removed).toEqual([bound]);
    expect(policy).not.toHaveBeenCalled();
    expect(readPersistedBinding("user:policy-owner")).toBeNull();
  });

  it("drops persisted bindings with invalid expiration timestamps", async () => {
    seedPersistedBinding(
      persistedRecord(workspaceConversation("user:U123"), {
        expiresAt: 8_640_000_000_000_001,
      }),
    );

    expect(resolveGeneric(workspaceConversation("user:U123"))).toBeNull();
  });

  it("does not bind generic current conversations when ttl expiry overflows", async () => {
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    await expect(
      bindGeneric({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        targetKind: "session",
        conversation: workspaceConversation("user:U123"),
        ttlMs: 1,
      }),
    ).resolves.toBeNull();
    expect(resolveGeneric(workspaceConversation("user:U123"))).toBeNull();
  });

  describe("SQLite write failures", () => {
    it("keeps committed activity unchanged when a touch write fails", async () => {
      const bound = expectSessionBinding(
        await bindWorkspaceConversation("user:U1", { metadata: { label: "workspace-dm" } }),
      );
      const originalActivity = bound.metadata?.lastActivityAt;

      await expect(
        withReadOnlyStateDatabase(() => touchGeneric(bound.bindingId, 9_999_999)),
      ).rejects.toThrow();

      expect(resolveWorkspaceConversation("user:U1")?.metadata?.lastActivityAt).toBe(
        originalActivity,
      );
    });

    it("keeps an expired binding when prune-on-resolve fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      await bindWorkspaceConversation("user:U1", { ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() => resolveWorkspaceConversation("user:U1")),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(resolveWorkspaceConversation("user:U1")).not.toBeNull();
    });

    it("keeps expired list entries when their cleanup write fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      const targetSessionKey = "agent:codex:acp:shared";
      await bindWorkspaceConversation("user:U1", { targetSessionKey });
      await bindWorkspaceConversation("user:U2", { targetSessionKey, ttlMs: 1_000 });

      vi.setSystemTime(new Date(1_002_000));
      await expect(
        withReadOnlyStateDatabase(() => listBySession(targetSessionKey)),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listBySession(targetSessionKey)).toHaveLength(2);
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
          unbindGeneric({
            targetSessionKey,
            reason: "test cleanup",
          }),
        ),
      ).rejects.toThrow();

      vi.setSystemTime(new Date(1_000_500));
      expect(listBySession(targetSessionKey)).toHaveLength(2);
    });
  });
});
