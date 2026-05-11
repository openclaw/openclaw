import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  __testing,
  bindGenericCurrentConversation,
  getGenericCurrentConversationBindingCapabilities,
  listGenericCurrentConversationBindingsBySession,
  resolveGenericCurrentConversationBinding,
  touchGenericCurrentConversationBinding,
  unbindGenericCurrentConversationBindings,
} from "./current-conversation-bindings.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

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

type CurrentConversationBindingsTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

function getCurrentConversationBindingsTestDb(): {
  database: OpenClawStateDatabase;
  db: ReturnType<typeof getNodeSqliteKysely<CurrentConversationBindingsTestDatabase>>;
} {
  const database = openOpenClawStateDatabase();
  return {
    database,
    db: getNodeSqliteKysely<CurrentConversationBindingsTestDatabase>(database.db),
  };
}

describe("generic current-conversation bindings", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-bindings-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    setMinimalCurrentConversationRegistry();
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
  });

  afterEach(async () => {
    __testing.resetCurrentConversationBindingsForTests({
      deletePersistedFile: true,
    });
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
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });

    __testing.resetCurrentConversationBindingsForTests();

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
  });

  it("normalizes persisted target session keys on reload", async () => {
    __testing.persistBindingForTests({
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
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
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
    const bindings = listGenericCurrentConversationBindingsBySession(
      "agent:codex:acp:workspace-dm",
    );
    expect(bindings).toHaveLength(1);
    expectBindingFields(bindings[0], {
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
  });

  it("persists bindings as typed columns without an opaque record copy", async () => {
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
        conversationKind: "direct",
      },
      metadata: {
        label: "workspace-dm",
        targetSessionId: "workspace-session",
      },
    });
    const { database, db } = getCurrentConversationBindingsTestDb();
    const before = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("current_conversation_bindings")
        .select([
          "target_agent_id",
          "target_session_id",
          "target_session_key",
          "conversation_kind",
          "conversation_id",
          "metadata_json",
        ]),
    ).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      target_agent_id: "codex",
      target_session_id: "workspace-session",
      target_session_key: "agent:codex:acp:workspace-dm",
      conversation_kind: "direct",
      conversation_id: "user:U123",
    });
    expect(JSON.parse(before[0]?.metadata_json ?? "{}")).toMatchObject({
      label: "workspace-dm",
      targetSessionId: "workspace-session",
    });
    const columns = database.db.prepare("PRAGMA table_info(current_conversation_bindings)").all();
    expect(columns.map((column) => (column as { name: string }).name)).not.toContain("record_json");

    __testing.resetCurrentConversationBindingsForTests();

    const resolved = resolveGenericCurrentConversationBinding({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expectBindingFields(resolved, {
      bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      status: "active",
    });
    expectBindingMetadata(resolved, { label: "workspace-dm" });
  });

  it("rejects invalid persisted generic binding enum values", () => {
    const { database, db } = getCurrentConversationBindingsTestDb();

    expect(() =>
      executeSqliteQuerySync(
        database.db,
        db.insertInto("current_conversation_bindings").values({
          binding_key: "invalid",
          binding_id: "invalid",
          target_agent_id: "codex",
          target_session_key: "agent:codex:session",
          channel: "workspace",
          account_id: "default",
          conversation_kind: "file",
          conversation_id: "user:U123",
          target_kind: "locator",
          status: "active",
          bound_at: 1,
          updated_at: 1,
        }),
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("keeps conversation kinds as part of the binding identity", async () => {
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:direct-session",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "room-1",
        conversationKind: "direct",
      },
    });
    await bindGenericCurrentConversation({
      targetSessionKey: "agent:codex:group-session",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "room-1",
        conversationKind: "group",
      },
    });

    expectBindingFields(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "room-1",
        conversationKind: "direct",
      }),
      {
        bindingId: "generic:workspace\u241fdefault\u241fdirect\u241f\u241froom-1",
        targetSessionKey: "agent:codex:direct-session",
      },
    );
    expectBindingFields(
      resolveGenericCurrentConversationBinding({
        channel: "workspace",
        accountId: "default",
        conversationId: "room-1",
        conversationKind: "group",
      }),
      {
        bindingId: "generic:workspace\u241fdefault\u241fgroup\u241f\u241froom-1",
        targetSessionKey: "agent:codex:group-session",
      },
    );
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
      bindingId: "generic:forum\u241fdefault\u241fdirect\u241f\u241f6098642967",
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
        bindingId: "generic:forum\u241fdefault\u241fdirect\u241f\u241f6098642967",
        targetSessionKey: "agent:codex:acp:forum-dm",
      },
    );
  });

  it("migrates persisted legacy self-parent binding ids on load", async () => {
    __testing.persistBindingForTests({
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
      bindingId: "generic:forum\u241fdefault\u241fdirect\u241f\u241f6098642967",
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
      bindingId: "generic:forum\u241fdefault\u241fdirect\u241f\u241f6098642967",
    });

    __testing.resetCurrentConversationBindingsForTests();
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

    __testing.resetCurrentConversationBindingsForTests();

    expect(
      resolveGenericCurrentConversationBinding({
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
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
      "generic:workspace\u241fdefault\u241fdirect\u241f\u241fuser:U123",
      1_234_567_890,
    );

    __testing.resetCurrentConversationBindingsForTests();

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
});
