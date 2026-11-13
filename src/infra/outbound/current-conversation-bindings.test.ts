import { aroundEach, assert, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
import { recordPublications } from "./current-conversation-bindings.test-support.js";
import { inspectSessionBindingByConversation } from "./session-binding-service.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

type CurrentConversationBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

function expectSessionBinding(
  bound: SessionBindingRecord | null | undefined,
): SessionBindingRecord {
  assert(bound, "Expected current-conversation binding");
  return bound;
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

function seedPersisted(record: SessionBindingRecord): void {
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

function replacePersisted(record: SessionBindingRecord): void {
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

function readPersisted(conversationId: string): SessionBindingRecord | null {
  const json = openOpenClawStateDatabase()
    .db.prepare("SELECT record_json FROM current_conversation_bindings WHERE binding_key = ?")
    .get(buildConversationKey(workspaceConversation(conversationId)))?.record_json;
  return typeof json === "string" ? (JSON.parse(json) as SessionBindingRecord) : null;
}

function setBindingRegistry(ids = ["workspace", "forum"], policy?: () => boolean): void {
  setActivePluginRegistry(
    createTestRegistry(
      ids.map((id) => ({
        pluginId: id,
        source: "test",
        plugin: {
          id,
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            isCurrentConversationBindingSupported: policy,
          },
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

const workspaceConversation = (conversationId: string) => ({
  channel: "workspace",
  accountId: "default",
  conversationId,
});

function persistedRecord(
  conversation: SessionBindingRecord["conversation"],
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  return {
    bindingId: `generic:${buildConversationKey(conversation)}`,
    targetSessionKey: "agent:main:bound",
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
async function bindWorkspace(
  conversationId: string,
  options: {
    targetSessionKey?: string;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<SessionBindingRecord> {
  return expectSessionBinding(
    await bindGeneric({
      ...options,
      targetSessionKey: options.targetSessionKey ?? "agent:main:bound",
      targetKind: "session",
      conversation: workspaceConversation(conversationId),
    }),
  );
}

const resolveWorkspace = (id: string) => resolveGeneric(workspaceConversation(id));

aroundEach(async (runTest) => {
  await withOpenClawTestState({ label: "current-bindings", layout: "state-only" }, async () => {
    setBindingRegistry();
    testing.clearPersistedCurrentConversationBindingsForTests();
    try {
      await runTest();
    } finally {
      vi.useRealTimers();
      testing.clearPersistedCurrentConversationBindingsForTests();
    }
  });
});

it("inspects expired ownership without deleting the durable row", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  await bindWorkspace("user:inspection", { ttlMs: 1_000 });
  vi.setSystemTime(new Date(1_002_000));
  expect(
    inspectSessionBindingByConversation(workspaceConversation("user:inspection")),
  ).toMatchObject({
    status: "available",
    binding: null,
  });
  // Rewinding exposes whether inspection pruned the existing SQLite row.
  vi.setSystemTime(new Date(1_000_500));
  expect(resolveWorkspace("user:inspection")).not.toBeNull();
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

  expect(bound).toMatchObject({
    targetSessionKey: "agent:main:adopted",
  });
  expect(bound?.conversation).toEqual(conversation);
  expect(resolveGeneric(conversation)).toMatchObject({ targetSessionKey: "agent:main:adopted" });
});

it.each(["bind", "touch", "expiry cleanup", "unbind"] as const)(
  "preserves independently inserted and updated rows during %s",
  async (mutation) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const owned = await bindWorkspace("user:owner");
    const previousExternal = await bindWorkspace("user:updated", {
      targetSessionKey: "agent:main:old",
      metadata: { version: "before" },
    });
    await bindWorkspace("user:expired", { ttlMs: 1_000 });

    const latestExternal: SessionBindingRecord = {
      ...previousExternal,
      targetSessionKey: "agent:main:new",
      metadata: { version: "latest", opaque: { nested: true } },
    };
    replacePersisted(latestExternal);
    const inserted: SessionBindingRecord = {
      ...owned,
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:inserted",
      targetSessionKey: "agent:main:inserted",
      conversation: workspaceConversation("user:inserted"),
      metadata: { opaque: "external owner" },
    };
    seedPersisted(inserted);

    switch (mutation) {
      case "bind":
        await bindWorkspace("user:replacement");
        break;
      case "touch":
        touchGeneric(owned.bindingId, 1_000_500);
        break;
      case "expiry cleanup":
        vi.setSystemTime(new Date(1_002_000));
        expect(resolveWorkspace("user:expired")).toBeNull();
        break;
      case "unbind":
        await unbindGeneric({
          bindingId: owned.bindingId,
          reason: "owner cleanup",
        });
        break;
    }

    expect(readPersisted("user:inserted")).toEqual(inserted);
    expect(readPersisted("user:updated")).toEqual(latestExternal);

    await closeStateDatabaseForTest();
    expect(resolveWorkspace("user:inserted")).toEqual(inserted);
    expect(resolveWorkspace("user:updated")).toEqual(latestExternal);
  },
);

it("touches the latest committed target and complete opaque metadata", async () => {
  const initial = await bindWorkspace("user:owner", {
    targetSessionKey: "agent:main:old",
    metadata: { stale: true },
  });
  replacePersisted({
    ...initial,
    targetSessionKey: "agent:main:new",
    metadata: {
      opaque: { nested: ["latest", { preserved: true }] },
      lastActivityAt: 10,
    },
  });

  touchGeneric(initial.bindingId, 20);

  expect(readPersisted("user:owner")).toMatchObject({
    targetSessionKey: "agent:main:new",
    metadata: expect.objectContaining({
      opaque: { nested: ["latest", { preserved: true }] },
      lastActivityAt: 20,
    }),
  });
  expect(resolveWorkspace("user:owner")?.targetSessionKey).toBe("agent:main:new");
});

it("does not persist or publish a rejected synchronous generic touch", async () => {
  const conversation = workspaceConversation("user:held");
  // An account-policy binding now owns the conversation the stale generic ID names.
  seedPersisted(persistedRecord(conversation, { bindingId: "default:user:held" }));
  const rows = openOpenClawStateDatabase().db.prepare(
    "SELECT * FROM current_conversation_bindings ORDER BY binding_key",
  );
  const before = rows.all();
  const publications = recordPublications();
  touchGeneric(persistedRecord(conversation).bindingId, 99);
  expect(publications).toEqual([]);
  expect(rows.all()).toEqual(before);
});

it.each(["touch", "unbind"] as const)(
  "%s decodes conversation ids containing the key separator",
  async (operation) => {
    const prefixed = await bindWorkspace("user:held", { targetSessionKey: "agent:main:a" });
    const separated = await bindWorkspace("user:held\u241fb", { targetSessionKey: "agent:main:b" });
    if (operation === "touch") {
      touchGeneric(separated.bindingId, 99);
      expect(readPersisted("user:held\u241fb")?.metadata?.lastActivityAt).toBe(99);
    } else {
      await expect(
        unbindGeneric({ bindingId: separated.bindingId, reason: "manual" }),
      ).resolves.toEqual([separated]);
      expect(readPersisted("user:held\u241fb")).toBeNull();
    }
    expect(readPersisted("user:held")).toEqual(prefixed);
  },
);

it.each(["rebind", "delete"] as const)(
  "never restores a stale row when another owner commits a %s during normalization",
  (mutation) => {
    const initial = persistedRecord(workspaceConversation("user:race"), {
      targetSessionKey: " agent:main:stale ",
      boundAt: 1_000,
      metadata: { version: "stale" },
    });
    seedPersisted(initial);
    const latest: SessionBindingRecord = {
      ...initial,
      targetSessionKey: "agent:main:new",
      metadata: { version: "latest", opaque: { preserved: true } },
    };
    const parseJson = JSON.parse;
    let committed = false;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const parsed = parseJson(text, reviver);
      if (!committed && text.includes("user:race")) {
        committed = true;
        if (mutation === "rebind") {
          replacePersisted(latest);
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
      const resolved = resolveWorkspace("user:race");
      if (mutation === "delete") {
        expect(resolved).toBeNull();
        expect(readPersisted("user:race")).toBeNull();
        return;
      }
      expect(resolved).toEqual(latest);
      expect(readPersisted("user:race")).toEqual(latest);
    } finally {
      parseSpy.mockRestore();
    }
  },
);

it("does not hide another owner's committed row after a failed write", async () => {
  const owned = await bindWorkspace("user:owner");
  const external: SessionBindingRecord = {
    ...owned,
    bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:external",
    targetSessionKey: "agent:main:external",
    conversation: workspaceConversation("user:external"),
    metadata: { opaque: { survives: true } },
  };
  seedPersisted(external);

  await expect(
    withRejectedBindingCommit(() =>
      bindWorkspace("user:owner", {
        targetSessionKey: "agent:main:failed",
      }),
    ),
  ).rejects.toThrow();

  expect(resolveWorkspace("user:owner")).toEqual(owned);
  expect(resolveWorkspace("user:external")).toEqual(external);
  expect(readPersisted("user:external")).toEqual(external);
});

it.each(["resolve", "touch", "unbind"] as const)(
  "supports %s using canonical ids from legacy self-parent rows",
  async (operation) => {
    const targetSessionKey = "agent:main:forum";
    const legacy = persistedRecord(
      { ...forumConversation, parentConversationId: "6098642967" },
      {
        targetSessionKey: operation === "resolve" ? " agent:main:forum " : targetSessionKey,
        metadata: { label: "forum-dm", opaque: { preserved: true } },
      },
    );
    seedPersisted(legacy);
    const canonicalId = "generic:forum\u241fdefault\u241f\u241f6098642967";
    const resolved = expectSessionBinding(
      operation === "resolve"
        ? resolveGeneric(forumConversation)
        : listBySession(targetSessionKey)[0],
    );
    expect(resolved).toMatchObject({ bindingId: canonicalId, targetSessionKey });
    expect(resolved.conversation).toEqual(forumConversation);
    if (operation === "touch") {
      touchGeneric(resolved.bindingId, 9_876);
      expect(resolveGeneric(legacy.conversation)?.metadata).toEqual(
        expect.objectContaining({
          opaque: { preserved: true },
          lastActivityAt: 9_876,
        }),
      );
    } else {
      const removed = await unbindGeneric({
        bindingId: resolved.bindingId,
        reason: "legacy owner cleanup",
      });
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ bindingId: canonicalId });
      expect(resolveGeneric(forumConversation)).toBeNull();
      expect(listBySession(targetSessionKey)).toEqual([]);
    }
  },
);
it("unbinds durable generic rows without invoking reentrant plugin policy in a write transaction", async () => {
  const targetSessionKey = "agent:main:bound";
  const bound = await bindWorkspace("user:policy-owner");
  const policy = vi.fn(() => {
    runOpenClawStateWriteTransaction(() => undefined);
    return true;
  });
  setBindingRegistry(["workspace"], policy);

  const removed = await unbindGeneric({
    targetSessionKey,
    reason: "owner cleanup",
  });

  expect(removed).toEqual([bound]);
  expect(policy).not.toHaveBeenCalled();
  expect(readPersisted("user:policy-owner")).toBeNull();
});

it("drops persisted bindings with invalid expiration timestamps", async () => {
  seedPersisted(
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
      targetSessionKey: "agent:main:bound",
      targetKind: "session",
      conversation: workspaceConversation("user:U123"),
      ttlMs: 1,
    }),
  ).resolves.toBeNull();
  expect(resolveGeneric(workspaceConversation("user:U123"))).toBeNull();
});

it.each(["touch", "resolve", "list", "unbind"] as const)(
  "preserves committed state when %s fails",
  async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const targetSessionKey = "agent:main:shared";
    const bound = await bindWorkspace("user:U1", {
      targetSessionKey,
      metadata: { label: "workspace-dm" },
      ...(operation === "resolve" ? { ttlMs: 1_000 } : {}),
    });
    if (operation === "list" || operation === "unbind") {
      await bindWorkspace("user:U2", { targetSessionKey, ttlMs: 1_000 });
    }
    const read = () =>
      operation === "touch"
        ? resolveWorkspace("user:U1")?.metadata?.lastActivityAt
        : operation === "resolve"
          ? resolveWorkspace("user:U1")
          : listBySession(targetSessionKey);
    const before = read();
    vi.setSystemTime(new Date(1_002_000));
    const mutate = async () => {
      switch (operation) {
        case "touch":
          return touchGeneric(bound.bindingId, 9_999_999);
        case "resolve":
          return resolveWorkspace("user:U1");
        case "list":
          return listBySession(targetSessionKey);
        case "unbind":
          return unbindGeneric({ targetSessionKey, reason: "test cleanup" });
      }
    };
    await expect(
      operation === "unbind"
        ? withRejectedBindingCommit(mutate)
        : withReadOnlyStateDatabase(mutate),
    ).rejects.toThrow();
    vi.setSystemTime(new Date(1_000_500));
    expect(read()).toEqual(before);
  },
);
