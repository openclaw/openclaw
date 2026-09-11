import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "../harness/host-capability.test-support.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));

vi.mock("../../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/tools.js")>()),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

describe("OpenClaw host-owned plugin delivery", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("keeps delivery but hides send_current_reply without terminal-result capability", async () => {
    await withOpenClawTestState({ label: "host-non-code-mode-delivery" }, async (state) => {
      const sendText = vi.fn(async () => ({ channel: "telegram" as const, messageId: "sent-1" }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "telegram",
              outbound: {
                deliveryMode: "direct",
                sendText,
                sendMedia: async () => ({ channel: "telegram", messageId: "media-1" }),
              },
              messaging: {
                normalizeTarget: (raw) => raw,
                targetResolver: { looksLikeId: () => true, hint: "<chat-id>" },
              },
            }),
          },
        ]),
      );
      const sessionKey = "agent:main:telegram:direct:123";
      const runId = "run-no-code-mode";
      const sessionId = "session-no-code-mode";
      const sessionTarget = {
        agentId: "main",
        expectedWriterRunId: runId,
        sessionId,
        sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      replaceSessionEntrySync(sessionTarget, {
        activeWriterRunId: runId,
        sessionId,
        updatedAt: 1,
      });
      const token = mintMessageActionTurnCapability({
        agentId: "main",
        runId,
        sessionKey,
        sessionId,
      });
      let delivery: { send: (input: { text: string }) => Promise<void> } | undefined;
      hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
        delivery = (
          params as {
            context?: { delivery?: { send: (input: { text: string }) => Promise<void> } };
          }
        ).context?.delivery;
        return [];
      });
      const host = await createAdmittedHostCapabilityTestFixture({
        agentId: "main",
        config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
        model: { compat: { supportsTools: true } },
        provider: "openai",
        modelId: "gpt-test",
        runId,
        sessionFile: "",
        sessionId,
        sessionKey,
        sessionTarget,
      } as never);

      try {
        const tools = host.hostCapabilities.createToolSurface?.({
          agentId: "main",
          config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
          disableMessageTool: true,
          includeCoreTools: false,
          messageActionTurnCapability: token,
          messageChannel: "telegram",
          messageTo: "123",
          modelId: "gpt-test",
          modelProvider: "openai",
          runId,
          runSessionKey: sessionKey,
          sessionId,
          sessionKey,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: true,
          },
        });

        if (!delivery || !tools) {
          throw new Error("expected host-created plugin delivery capability");
        }
        expect(tools.some((tool) => tool.name === "send_current_reply")).toBe(false);
        host.closeHost();
        await expect(delivery.send({ text: "too late" })).rejects.toThrow();
        expect(sendText).not.toHaveBeenCalled();
      } finally {
        host.closeHost();
        host.closeAdmission();
        revokeMessageActionTurnCapability(token);
      }
    });
  });

  it.each([
    { codeMode: false, writer: true, label: "Code Mode off" },
    { codeMode: true, writer: true, label: "Code Mode on" },
    { codeMode: true, writer: false, label: "independent side turn" },
  ])(
    "preserves public construction plus binding for $label without terminal authority",
    async ({ codeMode, writer, label }) => {
      await withOpenClawTestState(
        { label: `host-public-delivery-${label.replaceAll(" ", "-")}` },
        async (state) => {
          const sendText = vi.fn(async () => ({
            channel: "telegram" as const,
            messageId: "sent-public",
          }));
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "telegram",
                source: "test",
                plugin: createOutboundTestPlugin({
                  id: "telegram",
                  outbound: {
                    deliveryMode: "direct",
                    sendText,
                    sendMedia: async () => ({ channel: "telegram", messageId: "media-public" }),
                  },
                  messaging: {
                    normalizeTarget: (raw) => raw,
                    targetResolver: { looksLikeId: () => true, hint: "<chat-id>" },
                  },
                }),
              },
            ]),
          );
          const sessionKey = "agent:main:telegram:direct:public";
          const runId = `run-public-${codeMode}-${writer}`;
          const sessionId = `session-public-${codeMode}-${writer}`;
          const sessionTarget = writer
            ? {
                agentId: "main",
                expectedWriterRunId: runId,
                sessionId,
                sessionKey,
                storePath: path.join(state.sessionsDir(), "sessions.json"),
              }
            : undefined;
          if (sessionTarget) {
            replaceSessionEntrySync(sessionTarget, {
              activeWriterRunId: runId,
              sessionId,
              updatedAt: 1,
            });
          }
          const token = mintMessageActionTurnCapability({
            agentId: "main",
            runId,
            sessionKey,
            sessionId,
          });
          let delivery: { send: (input: { text: string }) => Promise<void> } | undefined;
          hoisted.resolvePluginTools.mockImplementation((params: unknown) => {
            delivery = (
              params as {
                context?: { delivery?: { send: (input: { text: string }) => Promise<void> } };
              }
            ).context?.delivery;
            return [];
          });
          const config = {
            tools: { codeMode: { enabled: codeMode } },
          } as OpenClawConfig;
          const host = await createAdmittedHostCapabilityTestFixture({
            agentId: "main",
            config,
            model: { compat: { supportsTools: true } },
            provider: "openai",
            modelId: "gpt-test",
            runId,
            sessionId,
            sessionKey,
            sessionTarget,
          } as never);

          try {
            const tools = await host.runWithHostScope(async () => {
              const unbound = createOpenClawCodingTools({
                agentId: "main",
                config,
                disableMessageTool: true,
                includeCoreTools: false,
                messageActionTurnCapability: token,
                messageChannel: "telegram",
                messageTo: "public",
                modelId: "gpt-test",
                modelProvider: "openai",
                runId,
                runSessionKey: sessionKey,
                sessionId,
                sessionKey,
                toolConstructionPlan: {
                  includeBaseCodingTools: false,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: false,
                  includePluginTools: true,
                },
              });
              return host.hostCapabilities.bindToolSurface(unbound);
            });

            if (!delivery) {
              throw new Error("expected public builder plugin delivery capability");
            }
            expect(tools.some((tool) => tool.name === "send_current_reply")).toBe(false);
            await expect(delivery.send({ text: "side reply" })).resolves.toBeUndefined();
            expect(sendText).toHaveBeenCalledOnce();

            host.closeHost();
            await expect(delivery.send({ text: "too late" })).rejects.toThrow();
            expect(sendText).toHaveBeenCalledOnce();
          } finally {
            host.closeHost();
            host.closeAdmission();
            revokeMessageActionTurnCapability(token);
          }
        },
      );
    },
  );
});
