import { afterEach, beforeEach, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapterV2,
  testing,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCommandAuthorizationAsync } from "../command-auth.js";
import { buildCommandContext } from "./commands-context.js";
import { handleForkCommand } from "./commands-fork.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

let previousRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  previousRegistry = captureActivePluginRegistrySnapshot();
});
afterEach(() => {
  testing.resetSessionBindingAdaptersForTests();
  rollbackStagedPluginRegistry(previousRegistry);
});

it.each(["unchanged", "admission", "native", "binding", "recap"] as const)(
  "rechecks real nonowner command admission before %s fork effects",
  async (stage) => {
    await withOpenClawTestState({ label: "fork-command-authority" }, async (state) => {
      const key = "agent:main:telegram:group:-100123:topic:7";
      const cfg = {
        agents: { defaults: { workspace: state.workspaceDir } },
        commands: { allowFrom: { telegram: ["42"] } },
        messages: { groupChat: { visibleReplies: "automatic" as const } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const revoke = () =>
        setRuntimeConfigSnapshot({
          ...cfg,
          commands: { allowFrom: { telegram: ["99"] } },
        });
      const effects: string[] = [];
      const records: SessionBindingRecord[] = [];
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "telegram",
          capabilities: { chatTypes: ["group"], threads: true },
        }),
        conversationBindings: {
          prepareFork: async (input) => ({
            ok: true,
            assertCurrent: input.assertCurrent,
            formatRecap: (text) => {
              if (stage === "recap") {
                revoke();
              }
              return { text };
            },
            create: async (targetSessionKey) => {
              await Promise.resolve();
              if (stage === "native") {
                revoke();
              }
              input.assertCurrent();
              effects.push("native");
              const binding = await getSessionBindingService().bind({
                targetSessionKey,
                targetKind: "session",
                placement: "current",
                conversation: {
                  channel: "telegram",
                  accountId: "default",
                  conversationId: "-100123:topic:89",
                  parentConversationId: "-100123",
                },
                assertCurrent: input.assertCurrent,
              });
              return { binding };
            },
          }),
        },
        messaging: { resolveDeliveryTarget: () => ({ to: "-100123", threadId: "89" }) },
        outbound: {
          deliveryMode: "direct",
          sendText: async () => {
            effects.push("recap");
            return { channel: "telegram", messageId: "recap" };
          },
        },
      };
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        null,
        "default",
      );
      registerSessionBindingAdapterV2({
        version: 2,
        channel: "telegram",
        accountId: "default",
        capabilities: { placements: ["current"] },
        assertCurrent() {},
        listBySession: () => records,
        listBySessionAsync: async () => records,
        resolveByConversation: () => null,
        resolveByConversationAsync: async () => null,
        inspectByConversationAsync: async () => null,
        inspectByConversationsAsync: async (refs) => ({
          bindings: refs.map(() => null),
          assertCurrent() {},
        }),
        touchAsync: async () => {},
        bind: async (input) => {
          await Promise.resolve();
          if (stage === "binding") {
            revoke();
          }
          input.assertCurrent?.();
          effects.push("binding");
          const record: SessionBindingRecord = {
            bindingId: "fork:89",
            targetSessionKey: input.targetSessionKey,
            targetKind: "session",
            conversation: input.conversation,
            status: "active",
            boundAt: 1,
          };
          records.push(record);
          return record;
        },
      });
      const source = await createGatewaySession({
        cfg,
        key,
        commandSource: "test",
        creation: { via: "channel" },
      });
      if (!source.ok) {
        throw new Error(source.error.message);
      }
      await appendTranscriptMessage(
        { sessionKey: key, sessionId: source.entry.sessionId },
        { message: { role: "user", content: "Preserved fork source" } },
      );
      const params = buildCommandTestParams("/fork", cfg, {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        SenderId: "42",
        From: "telegram:group:-100123",
        To: "-100123",
        OriginatingTo: "-100123",
        MessageThreadId: "7",
        SessionKey: key,
        MessageSid: "fork-authority",
        CommandSource: "native",
      });
      params.isGroup = true;
      params.sessionKey = key;
      params.workspaceDir = state.workspaceDir;
      const auth = await resolveCommandAuthorizationAsync({
        cfg,
        ctx: params.ctx,
        commandAuthorized: true,
      });
      expect(auth).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
      params.command = buildCommandContext(
        { cfg, ctx: params.ctx, isGroup: true, triggerBodyNormalized: "/fork" },
        auth,
      );
      if (stage === "admission") {
        revoke();
      }
      const result = await handleForkCommand(params, true);
      expect(effects).toEqual(
        stage === "unchanged"
          ? ["native", "binding", "recap"]
          : stage === "recap"
            ? ["native", "binding"]
            : stage === "binding"
              ? ["native"]
              : [],
      );
      expect(result?.reply?.text).toMatch(
        stage === "unchanged"
          ? /Fork created/
          : stage === "recap"
            ? /recap was not delivered/
            : /authoriz/i,
      );
    });
  },
);
