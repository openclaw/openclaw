import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { createAdmittedHostCapabilityTestFixture } from "../harness/host-capability.test-support.js";
import { jsonResult, type AnyAgentTool } from "./common.js";

const hoisted = vi.hoisted(() => ({
  resolvePluginTools: vi.fn(),
}));

vi.mock("../../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/tools.js")>()),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

type ResolveTarget = NonNullable<
  NonNullable<ChannelMessagingAdapter["targetResolver"]>["resolveTarget"]
>;
type SendMedia = NonNullable<ChannelOutboundAdapter["sendMedia"]>;
type SendText = NonNullable<ChannelOutboundAdapter["sendText"]>;

async function withWriterBoundDeliveryProbe(
  params: {
    label: string;
    resolveTarget?: ResolveTarget;
    sendMedia?: SendMedia;
    sendText?: SendText;
  },
  run: (fixture: {
    boundTool: AnyAgentTool;
    replaceWriter: (activeWriterRunId: string | undefined) => void;
    resolveTarget?: ResolveTarget;
    sendMedia: ReturnType<typeof vi.fn<SendMedia>>;
    sendText: ReturnType<typeof vi.fn<SendText>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: params.label }, async (state) => {
    const sendText = vi.fn<SendText>(
      params.sendText ??
        (async () => ({ channel: "telegram" as const, messageId: "must-not-send-text" })),
    );
    const sendMedia = vi.fn<SendMedia>(
      params.sendMedia ??
        (async () => ({ channel: "telegram" as const, messageId: "must-not-send-media" })),
    );
    let createdTool: AnyAgentTool | undefined;
    const factory = vi.fn((context: OpenClawPluginToolContext): AnyAgentTool => {
      createdTool = {
        name: "delivery_probe",
        label: "Delivery probe",
        description: "Deliver through the current admitted turn.",
        parameters: Type.Object({}),
        execute: async () => {
          if (!context.delivery) {
            throw new Error("expected registered plugin delivery capability");
          }
          await context.delivery.send({ text: "must not escape" });
          return jsonResult({ delivered: true });
        },
      };
      return createdTool;
    });
    const registry = createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: { deliveryMode: "direct", sendText, sendMedia },
          messaging: {
            normalizeTarget: (raw) => raw,
            targetResolver: {
              looksLikeId: () => true,
              hint: "<chat-id>",
              ...(params.resolveTarget ? { resolveTarget: params.resolveTarget } : {}),
            },
          },
        }),
      },
    ]);
    registry.plugins.push({
      id: "delivery-probe",
      origin: "bundled",
      status: "loaded",
      enabled: true,
    } as never);
    registry.tools.push({
      pluginId: "delivery-probe",
      optional: false,
      source: "test",
      names: ["delivery_probe"],
      declaredNames: ["delivery_probe"],
      factory,
    });
    const registration = registry.tools[0];
    if (!registration) {
      throw new Error("expected registered delivery probe");
    }
    setActivePluginRegistry(registry);
    hoisted.resolvePluginTools.mockImplementation(
      (options: { context: OpenClawPluginToolContext }) => {
        const resolved = registration.factory(options.context);
        return Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
      },
    );

    const sessionKey = `agent:main:telegram:direct:${params.label}`;
    const runId = `run-${params.label}`;
    const sessionId = `session-${params.label}`;
    const sessionTarget = {
      agentId: "main",
      expectedWriterRunId: runId,
      sessionId,
      sessionKey,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const replaceWriter = (activeWriterRunId: string | undefined) =>
      replaceSessionEntrySync(sessionTarget, {
        activeWriterRunId,
        sessionId,
        updatedAt: 2,
      });
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
    const config = { tools: { codeMode: { enabled: true } } } as OpenClawConfig;
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
      const tools = await host.runWithHostScope(async () =>
        host.hostCapabilities.bindToolSurface(
          createOpenClawCodingTools({
            agentId: "main",
            config,
            disableMessageTool: true,
            includeCoreTools: false,
            messageActionTurnCapability: token,
            messageChannel: "telegram",
            messageTo: "writer-proof",
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
          }),
        ),
      );
      const boundTool = tools.find((tool) => tool.name === "delivery_probe");
      if (!boundTool) {
        throw new Error("expected bound registered delivery probe");
      }
      expect(factory).toHaveBeenCalledOnce();
      expect(boundTool).not.toBe(createdTool);
      expect(tools.some((tool) => tool.name === "send_current_reply")).toBe(false);
      await run({
        boundTool,
        replaceWriter,
        resolveTarget: params.resolveTarget,
        sendMedia,
        sendText,
      });
    } finally {
      host.closeHost();
      host.closeAdmission();
      revokeMessageActionTurnCapability(token);
    }
  });
}

describe("public plugin delivery writer fencing", () => {
  afterEach(() => {
    hoisted.resolvePluginTools.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it.each([
    { activeWriterRunId: "replacement-writer", label: "replacement" },
    { activeWriterRunId: undefined, label: "release" },
  ])("rejects bound plugin delivery after writer $label", async ({ activeWriterRunId, label }) => {
    await withWriterBoundDeliveryProbe({ label: `writer-${label}` }, async (fixture) => {
      fixture.replaceWriter(activeWriterRunId);
      await expect(fixture.boundTool.execute("writer-revoked", {})).rejects.toThrow(
        "Session writer changed before final reply delivery",
      );
      expect(fixture.sendText).not.toHaveBeenCalled();
      expect(fixture.sendMedia).not.toHaveBeenCalled();
    });
  });

  it("rechecks the SQLite writer after awaited target preparation", async () => {
    const preparationStarted = createDeferred();
    const releasePreparation = createDeferred();
    const resolveTarget = vi.fn<ResolveTarget>(async ({ input }) => {
      preparationStarted.resolve();
      await releasePreparation.promise;
      return { to: input, kind: "user" };
    });
    try {
      await withWriterBoundDeliveryProbe(
        { label: "writer-held-preparation", resolveTarget },
        async (fixture) => {
          const pending = fixture.boundTool.execute("writer-held", {});
          await preparationStarted.promise;
          fixture.replaceWriter("replacement-writer");
          releasePreparation.resolve();

          await expect(pending).rejects.toThrow(
            "Session writer changed before final reply delivery",
          );
          expect(resolveTarget).toHaveBeenCalledOnce();
          expect(fixture.sendText).not.toHaveBeenCalled();
          expect(fixture.sendMedia).not.toHaveBeenCalled();
        },
      );
    } finally {
      releasePreparation.resolve();
    }
  });
});
