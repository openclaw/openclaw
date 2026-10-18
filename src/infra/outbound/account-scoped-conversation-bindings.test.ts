import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createAccountScopedConversationBindingManager as createBindings,
  createAccountScopedConversationBindingManagerV2 as createBindingsV2,
  resetAccountScopedConversationBindingsForTests as resetBindings,
  type AccountScopedConversationBindingManager as BindingManager,
} from "./account-scoped-conversation-bindings.js";
import { testing as currentConversationBindingTesting } from "./current-conversation-bindings.js";
import { getSessionBindingService } from "./session-binding-service.js";

type TestBindingKind = "subagent" | "acp";

const stateKey = Symbol("openclaw.accountScopedConversationBindingExpiry.test");
const startedAt = 1_700_000_000_000;
const service = getSessionBindingService();
const baseCfg = {
  session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } },
} satisfies OpenClawConfig;
const pluginMetadata = {
  pluginBindingOwner: "plugin",
  pluginId: "opaque-plugin",
  pluginRoot: "/plugins/opaque-plugin",
  boundBy: "operator",
};

function managerOptions(cfg: OpenClawConfig = baseCfg, accountId = "ttl-owner") {
  return {
    channel: "imessage",
    cfg,
    accountId,
    stateKey,
    toStoredTargetKind: (kind: TestBindingKind) => kind,
    toSessionBindingTargetKind: (kind: TestBindingKind): "subagent" | "session" =>
      kind === "subagent" ? "subagent" : "session",
  } as const;
}

function createManager(cfg: OpenClawConfig = baseCfg, accountId = "ttl-owner") {
  return createBindings<TestBindingKind>(managerOptions(cfg, accountId));
}

function conversationRef(manager: BindingManager<TestBindingKind>, conversationId: string) {
  return { channel: "imessage", accountId: manager.accountId, conversationId };
}

function bindConversation(
  manager: BindingManager<TestBindingKind>,
  conversationId = "chat:ttl-owner",
) {
  const binding = manager.bindConversation({
    conversationId,
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:ttl-owner",
  });
  if (!binding) {
    throw new Error("expected an account-scoped conversation binding");
  }
  return binding;
}

function session(conversationId: string, cfg = baseCfg) {
  const manager = createManager(cfg);
  const conversation = conversationRef(manager, conversationId);
  return {
    manager,
    conversation,
    bind: (targetSessionKey: string, metadata?: Record<string, unknown>) =>
      service.bind({ targetSessionKey, targetKind: "session", conversation, metadata }),
    resolve: () => service.resolveByConversation(conversation),
    reopen: async () => {
      manager.stop();
      await closeStateDatabaseForTest();
      createManager(cfg);
    },
  };
}

describe("account-scoped conversation binding expiry", () => {
  let testStateDir = "";

  beforeEach(async () => {
    testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-account-bindings-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", testStateDir);
    resetBindings({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
  });

  afterEach(async () => {
    resetBindings({ stateKey });
    currentConversationBindingTesting.clearPersistedCurrentConversationBindingsForTests();
    await closeStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(testStateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("warns once for legacy construction and leaves V2 construction silent", () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    withPluginRuntimePluginScope({ pluginId: "account-binding-factory-warning" }, () => {
      const manager = createBindingsV2<TestBindingKind>(managerOptions());
      expect(manager.accountId).toBe("ttl-owner");
      expect(warning).not.toHaveBeenCalled();
      createManager();
      createManager();
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "createAccountScopedConversationBindingManager is deprecated; use createAccountScopedConversationBindingManagerV2",
      ),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
    expect(warning.mock.calls[0]?.[0]).toContain("first January 2027 stable release");
  });

  it.each(["agent", "plugin"] as const)(
    "preserves opaque %s binding metadata through recreation",
    async (ownerKind) => {
      const cfg = {
        ...baseCfg,
        agents: { entries: { alpha: {}, beta: {} } },
      } satisfies OpenClawConfig;
      const { manager, conversation, bind, resolve, reopen } = session("chat:opaque-metadata", cfg);
      const metadata = {
        ...pluginMetadata,
        ...(ownerKind === "agent" ? { agentId: "alpha" } : {}),
        label: "durable label",
        nested: { ownerEpoch: 7, capabilities: ["approve", "resume"] },
      };
      const bound = await bind(
        ownerKind === "agent"
          ? "agent:alpha:acp:opaque-session"
          : "plugin-binding:opaque-plugin:opaque-session",
        metadata,
      );

      expect(bound).toMatchObject({ bindingId: "ttl-owner:chat:opaque-metadata", metadata });
      expect(bound.metadata?.agentId).toBe(ownerKind === "agent" ? "alpha" : undefined);
      expect(manager.getByConversationId(conversation.conversationId)?.targetKind).toBe("acp");
      await expect(bind(bound.targetSessionKey)).resolves.toMatchObject({ metadata });
      if (ownerKind === "plugin") {
        await expect(
          service.bind({
            targetSessionKey: "unscoped-core-target",
            targetKind: "session",
            conversation: { ...conversation, conversationId: "chat:requires-owner" },
          }),
        ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
        expect(manager.getByConversationId("chat:requires-owner")).toBeUndefined();
      }

      await reopen();

      expect(resolve()).toMatchObject({
        bindingId: "ttl-owner:chat:opaque-metadata",
        targetKind: "session",
        metadata,
      });
    },
  );

  it("keeps the previously committed account binding visible when its replacement write fails", () => {
    const manager = createManager();
    const original = bindConversation(manager, "chat:write-failure");
    const { db } = openOpenClawStateDatabase();
    db.exec("PRAGMA query_only = ON");
    try {
      expect(() =>
        manager.bindConversation({
          conversationId: original.conversationId,
          targetKind: "session",
          targetSessionKey: "agent:main:acp:uncommitted-owner",
          metadata: { label: "must-not-leak" },
        }),
      ).toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }

    expect(manager.getByConversationId(original.conversationId)).toEqual(original);
    const resolved = service.resolveByConversation(
      conversationRef(manager, original.conversationId),
    );
    expect(resolved?.targetSessionKey).toBe(original.targetSessionKey);
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const { bind, resolve, reopen } = session("chat:replacement-owner");
      const metadata = { ...pluginMetadata, opaque: { runtimeId: "original" } };
      const originalTarget = "plugin-binding:opaque-plugin:original";
      await bind(originalTarget, { ...metadata, agentId: "previous-agent" });
      const targetSessionKey = replace ? "agent:main:acp:replacement" : originalTarget;

      await bind(targetSessionKey, { label: "updated" });
      await reopen();

      expect(resolve()).toMatchObject({
        targetSessionKey,
        metadata: { agentId: replace ? "main" : "previous-agent", label: "updated" },
      });
      const resolvedMetadata = resolve()?.metadata;
      for (const [key, value] of Object.entries(metadata)) {
        expect(resolvedMetadata?.[key]).toEqual(replace ? undefined : value);
      }
    },
  );

  it.each([
    ["maximum age despite refreshed activity", 2, 1, 30 * 60_000, 60 * 60_000],
    ["idle expiry cannot be revived", 1, 0, null, 60 * 60_000],
    ["disabled expiry preserves bindings", 0, 0, null, 10 * 365 * 24 * 60 * 60_000],
  ] as const)("enforces %s", (_name, idleHours, maxAgeHours, activity, elapsed) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager({ session: { threadBindings: { idleHours, maxAgeHours } } });
    const binding = bindConversation(manager);
    const { conversationId, targetSessionKey } = binding;
    if (activity !== null) {
      now.mockReturnValue(startedAt + activity);
      expect(manager.touchConversation(conversationId)?.lastActivityAt).toBe(startedAt + activity);
      const resolved = service.resolveByConversation(conversationRef(manager, conversationId));
      expect(resolved?.expiresAt).toBe(startedAt + 60 * 60_000);
    }
    now.mockReturnValue(startedAt + elapsed);
    if (idleHours === 0) {
      expect(manager.getByConversationId(conversationId)).toEqual(binding);
      expect(manager.listBySessionKey(targetSessionKey)).toEqual([binding]);
      expect(manager.touchConversation(conversationId)?.lastActivityAt).toBe(Date.now());
      expect(manager.unbindConversation(conversationId)?.targetSessionKey).toBe(targetSessionKey);
    } else {
      if (activity === null) {
        expect(manager.touchConversation(conversationId, startedAt + elapsed + 1)).toBeNull();
      }
      expect(manager.getByConversationId(conversationId)).toBeUndefined();
      expect(manager.listBySessionKey(targetSessionKey)).toEqual([]);
    }
  });

  it("prunes only the expired account when accounts share a conversation id", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const expiredManager = createManager(baseCfg, "ttl-expired");
    const expired = bindConversation(expiredManager, "chat:shared");

    now.mockReturnValue(startedAt + 30 * 60_000);
    const activeManager = createManager(baseCfg, "ttl-active");
    const active = bindConversation(activeManager, "chat:shared");

    now.mockReturnValue(startedAt + 60 * 60_000);

    expect(expiredManager.getByConversationId(expired.conversationId)).toBeUndefined();
    expect(activeManager.getByConversationId(active.conversationId)).toEqual(active);
    expect(activeManager.listBySessionKey(active.targetSessionKey)).toEqual([active]);
  });
});
