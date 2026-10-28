import { beforeEach, describe, expect, it, vi } from "vitest";
import "./dispatch-from-config.abort-and-dedupe.test-utils.js";
import "./dispatch-from-config.lifecycle-and-bindings.test-utils.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createApprovalNativeRouteReporter } from "../../infra/approval-native-route-coordinator.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  mocks,
  runtimePluginMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  messageAuditEvents,
  firstToolResultPayload,
  firstFinalReplyPayload,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
import { buildTestCtx } from "./test-ctx.js";

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("audits an aborted prepared-runtime wait as a skipped reply operation", async () => {
    setNoAbort();
    const abort = new AbortController();
    const preparedLookup = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) =>
      racePromiseWithAbortSignal(new Promise<never>(() => {}), abortSignal),
    );
    const runtimeLoaders = await import("./dispatch-from-config.runtime-loaders.js");
    using _ = vi.spyOn(runtimeLoaders, "loadPreparedModelRuntime").mockResolvedValue({
      loadPublishedGatewayReplyDispatchRuntime: preparedLookup,
    } as never);
    const dispatch = withDispatchProcessedOutcomeSink(() =>
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: "agent:main:main",
        }),
        cfg: { ...emptyConfig, diagnostics: { enabled: true } },
        dispatcher: createDispatcher(),
        replyOptions: { abortSignal: abort.signal },
      }),
    );

    await vi.waitFor(() => expect(preparedLookup).toHaveBeenCalledOnce());
    abort.abort(new Error("request cancelled"));
    const outcome = await dispatch;

    expect(outcome.result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(outcome.processedOutcome).toEqual({
      outcome: "skipped",
      reason: "reply_operation_aborted",
    });
    expect(messageAuditEvents()[0]).toMatchObject({
      status: "blocked",
      outcome: "skipped",
      reasonCode: "reply_operation_aborted",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "reply_operation_aborted",
      }),
    );
    const preparedSignal = preparedLookup.mock.calls[0]?.[0].abortSignal;
    expect(preparedSignal).toBeInstanceOf(AbortSignal);
    expect(preparedSignal?.aborted).toBe(true);
    expect(preparedSignal?.reason).toBe(abort.signal.reason);
    expect(preparedLookup).toHaveBeenCalledWith({
      agentId: "main",
      demand: "interactive",
      abortSignal: abort.signal,
      onRuntimeLease: expect.any(Function),
    });
  });
  it.each([
    {
      name: "suppresses with an active plugin route",
      handledKind: "plugin",
      enabled: true,
      suppress: true,
    },
    {
      name: "keeps with only an exec route",
      handledKind: "exec",
      enabled: true,
      suppress: false,
    },
    {
      name: "keeps without a native route",
      handledKind: undefined,
      enabled: true,
      suppress: false,
    },
    {
      name: "keeps when plugin approvals are disabled",
      handledKind: "plugin",
      enabled: false,
      suppress: false,
    },
  ] as const)(
    "$name for Google Chat plugin approval prompts",
    async ({ handledKind, enabled, suppress }) => {
      setNoAbort();
      const { googlechatPlugin } = await loadBundledPluginFacade<{
        googlechatPlugin: ChannelPlugin;
      }>({
        pluginId: "googlechat",
        artifactBasename: "api.ts",
      });
      const registry = createTestRegistry([
        { pluginId: "googlechat", source: "test", plugin: googlechatPlugin },
      ]);
      setActivePluginRegistry(registry);
      runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
      mocks.isRoutableChannel.mockReturnValue(true);
      const cfg: OpenClawConfig = {
        approvals: { exec: { enabled: true }, plugin: { enabled } },
        channels: {
          googlechat: {
            serviceAccount: {
              type: "service_account",
              client_email: "bot@example.test",
              private_key: "synthetic-test-key",
              token_uri: "https://oauth2.googleapis.com/token",
            },
            audienceType: "app-url",
            audience: "https://chat-app.example.test/googlechat",
            allowFrom: ["users/123"],
          },
        },
      };
      const sessionKey = "agent:main:googlechat:direct:spaces/AAA";
      const payload: ReplyPayload = {
        text: "Plugin approval required.",
        channelData: {
          execApproval: {
            approvalId: "plugin:12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
            approvalKind: "plugin",
            sessionKey,
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      };
      const reporter = handledKind
        ? createApprovalNativeRouteReporter({
            handledKinds: new Set([handledKind]),
            channel: "googlechat",
            channelLabel: "Google Chat",
            accountId: "default",
            requestGateway: async <T>() => ({ ok: true }) as T,
            shouldHandle: () => true,
            classifyRoute: () => "unbound",
          })
        : undefined;
      reporter?.start();
      try {
        const dispatcher = createDispatcher();
        await dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "googlechat",
            Surface: "googlechat",
            AccountId: "default",
            SessionKey: sessionKey,
          }),
          cfg,
          dispatcher,
          replyResolver: async (_ctx: MsgContext, options?: GetReplyOptions) => {
            await options?.onToolResult?.(payload);
            return { text: "done" };
          },
        });

        if (suppress) {
          expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
        } else {
          expect(firstToolResultPayload(dispatcher)?.text).toBe(payload.text);
        }
        expect(firstFinalReplyPayload(dispatcher)?.text).toBe("done");
      } finally {
        await reporter?.stop();
      }
    },
  );
});
