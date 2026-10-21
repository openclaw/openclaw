import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import { ensureConfiguredAcpBindingSession } from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { resolveConfiguredBinding } from "../plugins/configured-binding-registry.js";
import { withTelegramNativeOwners } from "./telegram-native-owner.test-support.js";

const unavailable = "Configured ACP binding is unavailable right now. Please try again.";

it.each(["current", "capability lookup", "accepted control"])(
  "retains native Telegram owner authority during configured ACP preparation: %s",
  (phase) =>
    withTelegramNativeOwners(async ({ cfg, state, admins, invokeTopic, handler, driver }) => {
      const backendId = "telegram-native-owner-proof";
      const route = { channel: "telegram", accountId: "default" };
      const peer = { kind: "group", id: "-10012345:topic:42" } as const;
      cfg.acp = { enabled: true, backend: backendId, allowedAgents: ["main"] };
      cfg.session = { store: state.path("native-acp-sessions.json") };
      cfg.agents = {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" }, thinkingDefault: "high" },
        entries: { main: { workspace: state.workspaceDir, model: "fixture/current" } },
      };
      cfg.channels!.telegram!.groups = { "-10012345": { groupPolicy: "open" } };
      cfg.bindings = [
        {
          type: "acp",
          agentId: "main",
          match: { ...route, peer },
          acp: { backend: backendId, cwd: state.workspaceDir, mode: "persistent" },
        },
      ];
      const binding = resolveConfiguredBinding({
        cfg,
        conversation: {
          ...route,
          conversationId: peer.id,
          parentConversationId: "-10012345",
        },
      });
      const spec = binding && resolveConfiguredAcpBindingSpecFromRecord(binding.record);
      if (!binding || !spec) {
        throw new Error("Expected configured Telegram native ACP binding");
      }
      const effects: string[] = [];
      const acceptedOptions = new Map<string, string>();
      const preparing = createDeferredCore();
      const finish = createDeferredCore();
      let pause = false;
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession({ agentId, sessionKey, model, thinking }) {
          effects.push("initialize");
          acceptedOptions.clear();
          for (const [key, value] of [
            ["model", model],
            ["thinking", thinking],
          ] as const) {
            if (value) {
              acceptedOptions.set(key, value);
            }
          }
          return { agentId, sessionKey, backend: backendId, runtimeSessionName: sessionKey };
        },
        async getCapabilities() {
          if (pause && phase === "capability lookup") {
            preparing.resolve();
            await finish.promise;
          }
          return { controls: ["session/set_config_option"] };
        },
        async setConfigOption({ key, value }) {
          effects.push(`configure:${key}`);
          acceptedOptions.set(key, value);
          if (pause && phase === "accepted control" && key === "model") {
            preparing.resolve();
            await finish.promise;
          }
          return {
            configOptions: [...acceptedOptions].map(([id, currentValue]) => ({ id, currentValue })),
          };
        },
        async close() {},
        async cancel() {},
        runTurn() {
          throw new Error("Native preparation must not start a provider turn");
        },
      };
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
        pause = true;
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
