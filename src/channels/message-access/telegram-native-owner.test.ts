import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { configureNativeAcp, createNativeAcpRuntime } from "./native-acp-owner.test-support.js";
import { withTelegramNativeOwners } from "./telegram-native-owner.test-support.js";

const denied = "You are not authorized to use this command.";
const failed = "⚠️ Command failed. Please try again later.";
const topicOwner = {
  senderIsOwner: true,
  agentId: "topic-owner",
  messageThreadId: 42,
  sessionKey: "agent:topic-owner:telegram:group:-10012345:topic:42",
};
const dmOwner = {
  senderIsOwner: true,
  isAuthorizedSender: true,
  channel: "telegram",
  accountId: "default",
  assertOwnerCurrent: expect.any(Function),
};

it.each([
  ["topic enabled", "open", undefined, "linked", true],
  ["group disabled", "disabled", undefined, "linked", false],
  ["topic disabled", "open", "disabled", "linked", false],
  ["topic overrides disabled group", "disabled", "open", "linked", true],
  ["DM linked owners", undefined, undefined, "linked", true],
  ["DM provider allowlist", undefined, undefined, "provider", false],
  ["DM global allowlist", undefined, undefined, "global", false],
  ["DM unlinked", undefined, undefined, "unlinked", false],
  ["DM asserted identity", undefined, undefined, "asserted", false],
] as const)(
  "enforces native owner admission and routing: %s",
  (_name, groupPolicy, topicPolicy, authority, allowed) =>
    withTelegramNativeOwners(async ({ cfg, invoke, invokeTopic, handler, driver }) => {
      if (groupPolicy) {
        const topic = {
          agentId: "topic-owner",
          ...(topicPolicy ? { groupPolicy: topicPolicy } : {}),
        };
        cfg.channels!.telegram!.groups = { "-10012345": { groupPolicy, topics: { "42": topic } } };
      }
      if (authority === "provider" || authority === "global") {
        cfg.commands!.allowFrom = { [authority === "provider" ? "telegram" : "*"]: ["999999"] };
      }
      const senderId = authority === "unlinked" ? 300 : 100;
      await (groupPolicy ? invokeTopic() : invoke(senderId));
      if (allowed) {
        if (!groupPolicy) {
          await invoke(200);
          expect(driver.pairingStoreReadCount()).toBe(0);
        }
        expect(handler).toHaveBeenCalledTimes(groupPolicy ? 1 : 2);
        for (const [ctx] of handler.mock.calls) {
          expect(ctx).toMatchObject(groupPolicy ? topicOwner : dmOwner);
        }
        if (groupPolicy) {
          expect(driver.deliveries()).toEqual([{ replies: [{ text: "TELEGRAM-OWNER-OK" }] }]);
        } else {
          expect(driver.deliveries()).toHaveLength(2);
        }
      } else {
        expect(handler).not.toHaveBeenCalled();
        const messages = groupPolicy ? [] : [{ chatId: senderId, text: denied }];
        expect([driver.sentMessages(), driver.deliveries()]).toEqual([messages, []]);
      }
    }, authority === "asserted"),
);

it("rejects stale native plugin owner authority after demotion", () =>
  withTelegramNativeOwners(async ({ invoke, handler, admins, driver }) => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let effects = 0;
    handler.mockImplementation(async (ctx) => {
      expect(ctx).toMatchObject({ senderIsOwner: true, assertOwnerCurrent: expect.any(Function) });
      entered.resolve();
      await finish.promise;
      ctx.assertOwnerCurrent?.();
      effects += 1;
      return { text: "TELEGRAM-OWNER-OK" };
    });
    const pending = invoke();
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Owner handler must enter before settling",
      );
      setUserProfileRole(admins[0]!.profile.id, "member");
      finish.resolve();
      await pending;
      expect(effects).toBe(0);
      expect(driver.deliveries()).toEqual([
        expect.objectContaining({
          replies: [expect.objectContaining({ text: failed })],
        }),
      ]);
    } finally {
      finish.resolve();
      await pending;
    }
  }));

it.each([false, true])("checks live owner authority during login (revoke=%s)", (revoke) =>
  withTelegramNativeOwners(async ({ cfg, admins, driver }) => {
    cfg.agents = { defaults: { model: "openai/gpt-5.5" } };
    const finish = createDeferredCore();
    const notified = createDeferredCore();
    let writes = 0;
    let calls = 0;
    driver.configureLogin({
      run: async (options) => {
        calls += 1;
        await options.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-TEST-CODE" });
        await finish.promise;
        options.assertCurrent?.();
        writes += 1;
        return {
          providerId: "openai",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [],
        };
      },
      onResult: () => notified.resolve(),
    });
    try {
      await driver.invoke({ command: "login", match: "openai/openai-device-code" });
      expect(calls).toBe(1);
      if (revoke) {
        setUserProfileRole(admins[0]!.profile.id, "member");
      }
      finish.resolve();
      await notified.promise;
      expect(writes).toBe(revoke ? 0 : 1);
    } finally {
      finish.resolve();
      if (calls > 0) {
        await notified.promise;
      }
    }
  }),
);

const unavailable = "Configured ACP binding is unavailable right now. Please try again.";

it.each(["current", "capability lookup", "accepted control"])(
  "retains native Telegram owner authority during configured ACP preparation: %s",
  (phase) =>
    withTelegramNativeOwners(async ({ cfg, state, admins, invokeTopic, handler, driver }) => {
      cfg.channels!.telegram!.groups = { "-10012345": { groupPolicy: "open" } };
      const { backendId, binding, spec } = configureNativeAcp(cfg, state, "telegram");
      const { runtime, effects, preparing, finish, pause } = createNativeAcpRuntime(
        backendId,
        phase === "capability lookup"
          ? "capability"
          : phase === "accepted control"
            ? "control"
            : undefined,
      );
      managerTesting.resetAcpSessionManagerForTests();
      registerAcpRuntimeBackend({ id: backendId, runtime });
      const manager = getAcpSessionManager();
      let pending: Promise<void> | undefined;
      try {
        expect(
          await ensureConfiguredAcpBindingSession({
            cfg,
            spec: { ...spec, model: "fixture/previous", thinking: "off" },
          }),
        ).toMatchObject({ ok: true });
        effects.length = 0;
        const target = { cfg, agentId: "main", sessionKey: binding.statefulTarget.sessionKey };
        const before = manager.resolveSession(target);
        pause();
        pending = invokeTopic();
        if (phase !== "current") {
          await awaitGateBeforeSettlement(preparing.promise, pending, "ACP preparation must pause");
          setUserProfileRole(admins[0]!.profile.id, "member");
          finish.resolve();
        }
        await pending;
        const after = manager.resolveSession(target);
        if (phase === "current") {
          expect(effects).toEqual(["configure:model", "configure:thinking"]);
          expect(handler).toHaveBeenCalledOnce();
          expect(driver.deliveries()).toEqual([{ replies: [{ text: "TELEGRAM-OWNER-OK" }] }]);
        } else {
          expect(handler).not.toHaveBeenCalled();
          expect(driver.sentMessages()).toEqual([{ chatId: -10012345, text: unavailable }]);
          expect(driver.deliveries()).toEqual([]);
          expect(effects).toEqual(phase === "capability lookup" ? [] : ["configure:model"]);
        }
        if (phase === "capability lookup") {
          expect(after).toEqual(before);
        } else {
          const runtimeOptions = {
            model: spec.model,
            thinking: phase === "current" ? "high" : "off",
          };
          expect(after).toMatchObject({ kind: "ready", meta: { runtimeOptions } });
        }
      } finally {
        finish.resolve();
        try {
          await pending;
        } finally {
          await disposeAcpSessionManagerInstance(manager, "test complete");
          unregisterAcpRuntimeBackend(backendId);
          managerTesting.resetAcpSessionManagerForTests();
        }
      }
    }),
);
