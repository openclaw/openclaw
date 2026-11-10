import { afterEach, assert, expect, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { stateTest } from "../plugin-state/plugin-state-fixtures.test-support.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeRegisteredPluginCommand } from "./plugin-command-execution.js";
import type { PluginCommandContext } from "./plugin-command.types.js";
import type { PluginToolRegistration } from "./registry-types.js";
import { setActivePluginRegistry, clearActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";
import { createPluginToolFactoryContext } from "./tool-factory-context.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";

const it = stateTest("binding-authority");
const sessionKey = "agent:main:binding-authority";
const conversation = { channel: "telegram", accountId: "default", conversationId: "room" };
const metadata = { pluginBindingOwner: "plugin", pluginId: "game", pluginRoot: "/synthetic/game" };

afterEach(async () => {
  vi.restoreAllMocks();
  await clearActivePluginRegistry();
});

async function fixture(state: OpenClawTestState, ttlMs?: number) {
  const registry = createTestRegistry([
    {
      pluginId: "telegram",
      source: "synthetic",
      plugin: {
        ...createChannelTestPluginBase({ id: "telegram" }),
        conversationBindings: { supportsCurrentConversationBinding: true },
        bindings: { resolveCommandConversation: () => conversation },
      },
    },
  ]);
  registry.plugins.push(createPluginRecord({ id: "game", rootDir: metadata.pluginRoot }));
  setActivePluginRegistry(registry);
  const scope = {
    agentId: "main",
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    env: state.env,
  };
  await replaceSessionEntry(scope, {
    sessionId: "original",
    lifecycleRevision: "first",
    updatedAt: 1,
  });
  const binding = await getSessionBindingService().bind({
    conversation,
    targetSessionKey: sessionKey,
    targetKind: "session",
    metadata,
    ttlMs,
  });
  const store = createPluginStateKeyedStore<number>("game", {
    namespace: "effects",
    maxEntries: 10,
    env: state.env,
  });
  await store.register("moves", 0);
  const invoke = (
    handler: (
      ctx: PluginCommandContext,
    ) => ReturnType<Parameters<typeof executeRegisteredPluginCommand>[1]["command"]["handler"]>,
    assertAuthorizedCurrent: () => void = () => {},
  ) =>
    executeRegisteredPluginCommand(registry, {
      command: {
        name: "move",
        description: "Synthetic scoped move",
        pluginId: "game",
        pluginRoot: metadata.pluginRoot,
        handler,
      },
      channel: "telegram",
      senderId: "player",
      isAuthorizedSender: true,
      senderIsOwner: false,
      assertAuthorizedCurrent,
      agentId: "main",
      sessionKey,
      sessionId: "original",
      sessionTarget: {
        agentId: "main",
        sessionKey,
        sessionId: "original",
        storePath: scope.storePath,
      },
      commandBody: "/move",
      config: {},
      accountId: "default",
      from: "room",
      to: "room",
    });
  return { registry, scope, binding, store, invoke };
}

it.for(["none", "rebind", "detach", "aba", "reset", "revoke"] as const)(
  "admits only the original non-owner command binding after awaited preparation: %s",
  async (change, { state }) => {
    const { scope, binding, store, invoke } = await fixture(state);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let authorized = true;
    let retained: (() => void) | undefined;
    const pending = invoke(
      async (ctx) => {
        expect(ctx.assertOwnerCurrent).toBeUndefined();
        assert(ctx.withCurrentConversationBinding, "host binding authority must be available");
        return ctx.withCurrentConversationBinding(async (authority) => {
          retained = authority.assertCurrent;
          expect(authority.requester).toEqual({
            kind: "channel",
            ...conversation,
            senderId: "player",
          });
          const action = store.withCurrent(authority);
          const observed = await action.observe("moves");
          entered.resolve();
          await resume.promise;
          await action.compareAndApply("moves", observed.comparison, {
            operation: "update",
            action: "set",
            value: 1,
          });
          return { text: "moved" };
        });
      },
      () => {
        if (!authorized) {
          throw new Error("player revoked");
        }
      },
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "finished")]),
      ).toBe("entered");
      if (change === "rebind") {
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: "agent:main:other",
          targetKind: "session",
          metadata,
        });
      }
      if (change === "detach" || change === "aba") {
        await getSessionBindingService().unbind({
          bindingId: binding.bindingId,
          scope: conversation,
          reason: "test",
        });
      }
      if (change === "aba") {
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: sessionKey,
          targetKind: "session",
          metadata,
        });
      }
      if (change === "reset") {
        await replaceSessionEntry(scope, { sessionId: "replacement", updatedAt: 2 });
      }
      if (change === "revoke") {
        authorized = false;
      }
      resume.resolve();
      const result = await pending;
      expect(result.text).toBe(
        change === "none" ? "moved" : "⚠️ Command failed. Please try again later.",
      );
      expect(await store.lookup("moves")).toBe(change === "none" ? 1 : 0);
      expect(retained).toBeTypeOf("function");
      expect(retained).toThrow();
    } finally {
      resume.resolve();
      await pending;
    }
  },
);

it("rechecks the non-owner at the real V2 worker commit grant", async ({ state }) => {
  const { store, invoke } = await fixture(state);
  let current = true;
  let commits = 0;
  const result = await invoke(
    async (ctx) => {
      assert(ctx.withCurrentConversationBinding);
      return ctx.withCurrentConversationBinding(async (authority) => {
        const action = store.withCurrent(authority);
        const observed = await action.observe("moves");
        probe.admission(mutationAdmission, (request, grant, admit) => {
          if (request.stage === "commit") {
            commits++;
            current = false;
          }
          admit(request, grant);
        });
        await action.compareAndApply("moves", observed.comparison, {
          operation: "update",
          action: "set",
          value: 1,
        });
        return { text: "moved" };
      });
    },
    () => {
      if (!current) {
        throw new Error("player revoked at commit");
      }
    },
  );
  expect(result.text).toContain("Command failed");
  expect(commits).toBe(1);
  expect(await store.lookup("moves")).toBe(0);
});

it("rejects copied restrictions and a state store from another physical source", async ({
  state,
}) => {
  const { store, invoke } = await fixture(state);
  const other = createPluginStateKeyedStore<number>("game", {
    namespace: "effects",
    maxEntries: 10,
    env: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir + "/other" },
  });
  const result = await invoke(async (ctx) => {
    assert(ctx.withCurrentConversationBinding);
    return ctx.withCurrentConversationBinding(async (authority) => {
      expect(() =>
        store.withCurrent({
          ...authority,
          conversationBindingCurrent: { ...authority.conversationBindingCurrent },
        }),
      ).toThrow("unavailable");
      await expect(other.withCurrent(authority).register("moves", 99)).rejects.toMatchObject({
        cause: { message: "Plugin conversation binding and state require the same physical store" },
      });
      return { text: "refused" };
    });
  });
  expect(result.text).toBe("refused");
  expect(await store.lookup("moves")).toBe(0);
  expect(await other.lookup("moves")).toBeUndefined();
});

it.for([false, true])(
  "binds V2 model tools to their call and current assignment (rebind=%s)",
  async (rebind, { state }) => {
    const { registry, store } = await fixture(state);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const entry: PluginToolRegistration = {
      pluginId: "game",
      rootDir: metadata.pluginRoot,
      source: "synthetic",
      contextVersion: 2,
      names: ["move"],
      optional: false,
      factory: () => null,
    };
    const context = createPluginToolFactoryContext({
      entry,
      registry,
      assertInvocationCurrent() {},
      context: {
        agentId: "main",
        sessionKey,
        sessionId: "original",
        messageChannel: "telegram",
        agentAccountId: "default",
        requesterSenderId: "player",
        deliveryContext: { to: "room" },
      },
    });
    let retained: (() => void) | undefined;
    const tool = bindPluginToolCallbacks(
      entry,
      registry,
      {
        name: "move",
        label: "Move",
        description: "Scoped move",
        parameters: { type: "object", properties: {} },
        async execute() {
          assert(context.withCurrentConversationBinding);
          return context.withCurrentConversationBinding(async (authority) => {
            retained = authority.assertCurrent;
            const action = store.withCurrent(authority);
            const observed = await action.observe("moves");
            entered.resolve();
            await resume.promise;
            await action.compareAndApply("moves", observed.comparison, {
              operation: "update",
              action: "set",
              value: 1,
            });
            return { content: [], details: { moved: true } };
          });
        },
      },
      context.assertInvocationCurrent,
    );
    const pending = tool.execute("move", {});
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), pending.then(() => "finished")]),
      ).toBe("entered");
      if (rebind) {
        await getSessionBindingService().bind({
          conversation,
          targetSessionKey: "agent:main:other",
          targetKind: "session",
          metadata,
        });
      }
      resume.resolve();
      if (rebind) {
        await expect(pending).rejects.toThrow();
      } else {
        await expect(pending).resolves.toMatchObject({ details: { moved: true } });
      }
      expect(await store.lookup("moves")).toBe(rebind ? 0 : 1);
      expect(retained).toThrow();
      assert(context.withCurrentConversationBinding);
      await expect(
        context.withCurrentConversationBinding(async () => "retained method"),
      ).rejects.toThrow("invocation closed");
    } finally {
      resume.resolve();
      await pending.catch(() => {});
    }
  },
);

it("refuses an effect after binding expiry without a publication", async ({ state }) => {
  const { binding, invoke } = await fixture(state, 60_000);
  assert(binding.expiresAt);
  let effects = 0;
  const result = await invoke(async (ctx) => {
    assert(ctx.withCurrentConversationBinding);
    return ctx.withCurrentConversationBinding(async (authority) => {
      authority.assertCurrent();
      await Promise.resolve();
      const clock = vi.spyOn(Date, "now").mockReturnValue(binding.expiresAt! + 1);
      try {
        authority.assertCurrent();
        effects++;
        return { text: "effect accepted" };
      } finally {
        clock.mockRestore();
      }
    });
  });
  expect(result.text).toContain("Command failed");
  expect(effects).toBe(0);
});
