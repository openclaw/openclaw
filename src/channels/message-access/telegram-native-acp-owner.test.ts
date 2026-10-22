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
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { configureNativeAcp, createNativeAcpRuntime } from "./native-acp-owner.test-support.js";
import { withTelegramNativeOwners } from "./telegram-native-owner.test-support.js";

const unavailable = "Configured ACP binding is unavailable right now. Please try again.";

it.each(["current", "capability lookup", "accepted control"])(
  "retains native Telegram owner authority during configured ACP preparation: %s",
  (phase) =>
    withTelegramNativeOwners(async ({ cfg, state, admins, invokeTopic, handler, driver }) => {
      cfg.channels!.telegram!.groups = { "-10012345": { groupPolicy: "open" } };
      const { backendId, binding, spec } = configureNativeAcp(cfg, state, "telegram");
      const effects: string[] = [];
      const { runtime, preparing, finish, pause } = createNativeAcpRuntime(
        backendId,
        (effect) => {
          effects.push(effect);
        },
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
