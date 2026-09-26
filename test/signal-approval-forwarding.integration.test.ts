import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../src/channels/message/receipt.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildForwardedSystemAgentPendingPayload } from "../src/infra/exec-approval-forwarder.messages.js";
import { deliverOutboundPayloadsCore } from "../src/infra/outbound/deliver-core.js";
import { prepareOutboundPayloadBatch } from "../src/infra/outbound/deliver-prepare.js";
import { createPluginRuntimeStore, type PluginRuntime } from "../src/plugin-sdk/runtime-store.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenAsyncKeyedStoreOptions } from "../src/plugin-state/plugin-state-store.types.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";

beforeEach(() => vi.resetModules());

describe("Signal forwarded system-agent approvals", () => {
  it.for([false, true])(
    "preserves reaction routing with an explicit target configured=%s",
    async (explicitTarget, { onTestFinished }) => {
      const registrySnapshot = captureActivePluginRegistrySnapshot();
      const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
        pluginId: "signal",
        errorMessage: "Signal runtime not initialized",
      });
      const previousRuntime = runtimeStore.tryGetRuntime();
      onTestFinished(() => {
        rollbackStagedPluginRegistry(registrySnapshot);
        if (previousRuntime) {
          runtimeStore.setRuntime(previousRuntime);
        } else {
          runtimeStore.clearRuntime();
        }
        vi.resetModules();
      });
      const writes: Array<{ namespace: string; key: string; value: unknown }> = [];
      const runtime = createPluginRuntimeMock({
        state: {
          openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => ({
            register: async (key: string, value: T) => {
              writes.push({ namespace: options.namespace, key, value });
            },
            registerIfAbsent: async () => false,
            lookup: async () => undefined,
            consume: async () => undefined,
            delete: async () => false,
            entries: async () => [],
            clear: async () => {},
          }),
        },
      });
      const { signalPlugin } = await import("../extensions/signal/channel-plugin-api.js");
      const { setSignalRuntime } = await import("../extensions/signal/runtime-api.js");
      setSignalRuntime(runtime);
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
        null,
        "default",
      );

      const target = { channel: "signal" as const, to: "+15551230000", accountId: "default" };
      const cfg: OpenClawConfig = {
        channels: {
          signal: { account: "+15550009999", allowFrom: [target.to] },
        },
        ...(explicitTarget
          ? { approvals: { exec: { enabled: true, mode: "targets", targets: [target] } } }
          : {}),
      };
      const approvalId = "system-agent:forwarded-fixture";
      const payload = buildForwardedSystemAgentPendingPayload({
        cfg,
        target,
        nowMs: 1000,
        request: {
          id: approvalId,
          createdAtMs: 1000,
          expiresAtMs: 61_000,
          request: {
            title: "OpenClaw change",
            description: "Update the agent model",
            command: "Update the agent model",
            proposalHash: "fixture-proposal",
            allowedDecisions: ["allow-once", "deny"],
            sessionId: "fixture-session",
            agentId: "main",
            sessionKey: "agent:main:signal:direct:+15551230000",
            turnSourceChannel: "signal",
            turnSourceTo: target.to,
            turnSourceAccountId: target.accountId,
          },
        },
      });
      const messageId = "1700000000099";
      const send = vi.fn(async (_to: string, _text: string) => ({
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "signal", messageId }],
          kind: "text",
        }),
      }));
      const params = { cfg, ...target, payloads: [payload], deps: { signal: send } };
      const preparedBatch = await prepareOutboundPayloadBatch(params);
      await deliverOutboundPayloadsCore({ ...params, preparedBatch });

      expect(send).toHaveBeenCalledOnce();
      const deliveredText = send.mock.calls[0]?.[1];
      expect(deliveredText).toContain(`/approve ${approvalId} allow-once|deny`);
      if (explicitTarget) {
        expect(deliveredText).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
        expect(writes).toEqual([
          expect.objectContaining({
            namespace: "signal.approval-reactions.v2",
            key: `default:${target.to}:${messageId}`,
            value: expect.objectContaining({
              version: 1,
              target: expect.objectContaining({
                approvalId,
                approvalKind: "system-agent",
                allowedDecisions: ["allow-once", "deny"],
              }),
            }),
          }),
        ]);
      } else {
        expect(deliveredText).not.toContain("React with:");
        expect(writes).toEqual([]);
      }
    },
  );
});
