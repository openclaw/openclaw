import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";

function createContext(): GatewayRequestContext {
  return {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: name.includes("approval") ? APPROVALS_SCOPE : WRITE_SCOPE,
    })),
  );
}

describe("createGatewayInstanceRuntime", () => {
  it("replays pending plugin context only to its Slack account", () => {
    const context = createContext();
    const request: PluginApprovalRequest = {
      approvalKind: "plugin",
      id: "plugin:replay-private",
      request: {
        title: "Sensitive action",
        description: "Needs approval",
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
        approvalSource: {
          channel: "slack",
          senderId: "U123",
          userMessageExcerpt: "private original message",
        },
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    context.pluginApprovalManager = {
      listLocalPendingRecords: () => [request],
    } as unknown as NonNullable<GatewayRequestContext["pluginApprovalManager"]>;
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });
    const subscribe = (channel: string, accountId: string) => {
      const shouldHandle = vi.fn(() => true);
      const onRequested = vi.fn();
      runtime.nativeApprovals.subscribe({
        eventKinds: new Set(["plugin"]),
        channel,
        accountId,
        shouldHandle,
        onRequested,
        onResolved: vi.fn(),
      });
      return { shouldHandle, onRequested };
    };
    const owner = subscribe("slack", "work");
    const otherAccount = subscribe("slack", "personal");
    const otherChannel = subscribe("matrix", "work");

    for (const recipient of [owner, otherAccount, otherChannel]) {
      expect(recipient.shouldHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      );
    }
    expect(owner.onRequested).toHaveBeenCalledWith(request);
    for (const recipient of [otherAccount, otherChannel]) {
      expect(recipient.onRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      );
    }
    runtime.close();
  });

  it("keeps a requester excerpt inside the matching Slack native approval runtime", () => {
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });
    const source = {
      channel: "slack",
      senderId: "U123",
      userMessageExcerpt: "private original message",
    };
    const request: PluginApprovalRequest = {
      approvalKind: "plugin",
      id: "plugin:private",
      request: {
        title: "Sensitive action",
        description: "Needs approval",
        turnSourceChannel: "slack",
        turnSourceAccountId: "work",
        approvalSource: source,
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    const recipients = [
      { channel: "slack", accountId: "work" },
      { channel: "slack", accountId: "personal" },
      { channel: "matrix", accountId: "work" },
      { channel: "slack", accountId: "default" },
    ].map(({ channel, accountId }) => {
      const shouldHandle = vi.fn(() => true);
      const onRequested = vi.fn();
      const onResolved = vi.fn();
      runtime.nativeApprovals.subscribe({
        eventKinds: new Set(["plugin"]),
        channel,
        accountId,
        shouldHandle,
        onRequested,
        onResolved,
      });
      return { shouldHandle, onRequested, onResolved };
    });

    expect(runtime.approvalEvents.publishRequested("plugin", request)).toBe(4);
    for (const recipient of recipients) {
      expect(recipient.shouldHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      );
    }
    expect(recipients[0]?.onRequested).toHaveBeenCalledWith(request);
    for (const recipient of recipients.slice(1)) {
      expect(recipient.onRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      );
    }

    for (const recipient of recipients) {
      recipient.onRequested.mockClear();
    }
    const defaultRequest: PluginApprovalRequest = {
      ...request,
      id: "plugin:default",
      request: { ...request.request, turnSourceAccountId: null },
    };
    expect(runtime.approvalEvents.publishRequested("plugin", defaultRequest)).toBe(4);
    const publicDefaultRequest = {
      ...defaultRequest,
      request: {
        ...defaultRequest.request,
        approvalSource: { channel: "slack", senderId: "U123" },
      },
    };
    for (const recipient of recipients) {
      expect(recipient.onRequested).toHaveBeenCalledWith(publicDefaultRequest);
    }

    runtime.approvalEvents.publishResolved("plugin", {
      id: request.id,
      decision: "deny",
      ts: 3,
      request: request.request,
    });
    for (const recipient of recipients) {
      expect(recipient.onResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            approvalSource: { channel: "slack", senderId: "U123" },
          }),
        }),
      );
    }
    runtime.close();
  });

  it.each([
    [{ decision: "deny" as const }, "denied"],
    [{ decision: "deny" as const, terminalStatus: "expired" as const }, "expired"],
    [{ decision: "deny" as const, terminalStatus: "cancelled" as const }, "cancelled"],
    [{ decision: "allow-once" as const }, "allowed"],
  ])("passes the plugin approval terminal outcome to the native route owner", (event, status) => {
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });
    const publishTerminal = vi
      .spyOn(runtime.nativeApprovals.routeCoordinator, "publishPluginTerminal")
      .mockResolvedValue();

    runtime.approvalEvents.publishResolved("plugin", { id: "plugin:1", ts: 1, ...event });

    expect(publishTerminal).toHaveBeenCalledWith({ approvalId: "plugin:1", status });
    runtime.close();
  });

  it.each([false, true])(
    "revalidates recovery authority across admission (dedicated principal=%s)",
    async (dedicatedPrincipal) => {
      const context = createContext();
      const payload = { runId: "bound-recovery", status: "ok", summary: "completed" };
      context.dedupe.set("agent:bound-recovery", { ts: Date.now(), ok: true, payload });
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRegistry({}),
        isDispatchAvailable: () => true,
      });
      let requesterCurrent = true;
      const options = {
        expectFinal: true,
        ...(dedicatedPrincipal
          ? { internalDeliveryMediaUrls: ["https://example.test/media"] }
          : {}),
        assertAdmissionCurrent: () => {
          if (!requesterCurrent) {
            throw new Error("Recovery requester retired");
          }
        },
      };
      const request = { message: "completed media", idempotencyKey: "bound-recovery" };
      try {
        await expect(runtime.recovery.dispatchAgent(request, undefined, options)).resolves.toEqual(
          payload,
        );
        const pending = runtime.recovery.dispatchAgent(request, undefined, options);
        requesterCurrent = false;
        await expect(pending).rejects.toThrow("Recovery requester retired");
      } finally {
        runtime.close();
      }
    },
  );

  it("uses the typed recovery path and fails closed when the owning instance closes", async () => {
    let available = false;
    const rawAgent = vi.fn<NonNullable<GatewayRequestHandlers["agent"]>>(({ respond }) => {
      respond(true, { raw: true });
    });
    const registry = createRegistry({ agent: rawAgent });
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => available,
    });
    expect(getGatewayRecoveryRuntime()).toBe(runtime.recovery);

    await expect(
      runtime.recovery.dispatchAgent({ message: "test", idempotencyKey: "run-unavailable" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    available = true;
    await expect(runtime.recovery.waitForAgent({ runId: "run-1", timeoutMs: 0 })).resolves.toEqual({
      runId: "run-1",
      status: "timeout",
    });
    context.dedupe.set("agent:run-cached-recovery", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-recovery", status: "ok", summary: "replayed" },
    });
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-cached-recovery",
      }),
    ).resolves.toEqual({ runId: "run-cached-recovery", status: "ok", summary: "replayed" });
    const onExecutionStarted = vi.fn();
    context.dedupe.set("agent:run-cached-active", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "run-cached-active", status: "accepted" },
    });
    context.chatAbortControllers.set("run-cached-active", {
      controller: new AbortController(),
      executionStarted: true,
    } as never);
    await expect(
      runtime.recovery.dispatchAgent(
        { message: "test", idempotencyKey: "run-cached-active" },
        undefined,
        { onExecutionStarted },
      ),
    ).resolves.toMatchObject({ runId: "run-cached-active", status: "in_flight" });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    await expect(
      runtime.recovery.dispatchAgent({
        message: "test",
        idempotencyKey: "run-typed-recovery",
        cwd: "relative",
      }),
    ).rejects.toThrow("cwd must be absolute");
    expect(rawAgent).not.toHaveBeenCalled();

    const retainedFacade = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] }),
    });
    runtime.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
    await expect(runtime.recovery.waitForAgent({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
    await expect(
      retainedFacade.dispatch({ message: "stale completion", idempotencyKey: "closed-host" }),
    ).rejects.toThrow("Gateway instance dispatch unavailable");
    await expect(retainedFacade.wait({ runId: "run-1" })).rejects.toThrow(
      "Gateway instance dispatch unavailable",
    );
  });

  it("captures trusted agent principal fields verbatim", () => {
    const client = createSyntheticPluginRuntimeClient({
      allowModelOverride: true,
      agentRunTracking: "plugin_subagent",
      cronRunContinuation: true,
      internalDeliveryMediaUrls: ["https://example.test/media"],
      internalDeliverySuppressText: true,
      pluginRuntimeOwnerId: "memory-core",
      delegatedToolPolicyHandoffId: "handoff-1",
      sessionCreation: {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
      },
    });

    const principal = captureAgentTurnPrincipal(client);

    expect(principal?.connect).toBe(client.connect);
    expect(principal?.internal).toBe(client.internal);
    expect(principal?.internal).toEqual(client.internal);

    const recoveryClient = createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] });
    const recoveryPrincipal = captureAgentTurnPrincipal(recoveryClient);
    expect(recoveryPrincipal?.connect?.client.mode).toBe("backend");
    expect(recoveryPrincipal?.internal).toEqual({
      syntheticClient: true,
      allowModelOverride: false,
    });
    expect(recoveryPrincipal?.internal?.agentRunTracking).toBeUndefined();
    expect(recoveryPrincipal?.internal?.sessionCreation).toBeUndefined();
  });

  it("sends recovery and live approval notices through normal outbound without plugin actions", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "recovery-notice-" }, async () => {
      let releasePlatformDispatch: (() => void) | undefined;
      let platformDispatchHold: Promise<void> | undefined;
      const visibleSend = vi.fn();
      const sendText = vi.fn(async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
        await platformDispatchHold;
        await ctx.onPlatformSendDispatch?.();
        visibleSend();
        return { channel: "signal", messageId: `signal-message-${visibleSend.mock.calls.length}` };
      });
      const handleAction = vi.fn(async () => {
        throw new Error("recovery notice must not invoke message actions");
      });
      const plugin: ChannelPlugin = {
        id: "signal",
        meta: {
          id: "signal",
          label: "Signal",
          selectionLabel: "Signal",
          docsPath: "/channels/signal",
          blurb: "Signal-shaped recovery test plugin.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["work"],
          resolveAccount: () => ({}),
          isConfigured: () => true,
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: () => false,
          handleAction,
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
          sendText,
        },
      };
      const pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(
        createTestRegistry([{ pluginId: "signal", source: "test", plugin }]),
        null,
        "default",
      );
      const context = {
        ...createContext(),
        getRuntimeConfig: () => ({ channels: { signal: { enabled: true } } }),
      } as GatewayRequestContext;
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRegistry({}),
        isDispatchAvailable: () => true,
      });

      try {
        const idempotencyKey = "main-session-restart-recovery:run-1:failed-notice";
        const notice = {
          channel: "signal",
          to: "+15551234567",
          accountId: "work",
          threadId: "thread-1",
          text: "Recovery notice",
          idempotencyKey,
        } as const;
        await runtime.recovery.sendRecoveryNotice(notice);
        await runtime.recovery.sendRecoveryNotice(notice);

        expect(await findDeliveryIntentOwner(idempotencyKey)).toMatchObject({
          status: "completed",
        });
        expect(visibleSend).toHaveBeenCalledOnce();

        let ownerCurrent = true;
        platformDispatchHold = new Promise<void>((resolve) => {
          releasePlatformDispatch = resolve;
        });
        const staleDelivery = runtime.recovery.sendRecoveryNotice({
          ...notice,
          idempotencyKey: "main-session-restart-recovery:run-2:failed-notice",
          liveOnly: true,
          isCurrent: () => ownerCurrent,
        });
        await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
        const queuedResumption = await findDeliveryIntentOwner(
          "main-session-restart-recovery:run-2:failed-notice",
        );
        ownerCurrent = false;
        releasePlatformDispatch?.();

        await expect(staleDelivery).rejects.toThrow(
          "Recovery notice owner retired before delivery",
        );

        expect(visibleSend).toHaveBeenCalledOnce();
        expect(queuedResumption).toBeNull();
        expect(sendText).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "+15551234567",
            accountId: "work",
            threadId: "thread-1",
            text: "Recovery notice",
          }),
        );
        expect(handleAction).not.toHaveBeenCalled();

        const guardedDurableNotice = {
          ...notice,
          idempotencyKey: "main-session-restart-recovery:subagent:run-3:resumed-notice",
          isCurrent: () => true,
        };
        await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
        expect(await findDeliveryIntentOwner(guardedDurableNotice.idempotencyKey)).toMatchObject({
          status: "completed",
        });
        await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
        expect(visibleSend).toHaveBeenCalledTimes(2);
        expect(await findDeliveryIntentOwner(guardedDurableNotice.idempotencyKey)).toMatchObject({
          status: "completed",
        });

        let approvalPending = true;
        platformDispatchHold = new Promise<void>((resolve) => {
          releasePlatformDispatch = resolve;
        });
        const approvalNoticeKey = "approval-route-notice:plugin:pending-handoff";
        const pendingNotice = runtime.nativeApprovals.requestRoute(
          "send",
          {
            channel: "signal",
            to: "+15551234567",
            accountId: "work",
            threadId: "thread-1",
            message: "Approval required",
            idempotencyKey: approvalNoticeKey,
          },
          { liveOnlyWhenCurrent: () => approvalPending },
        );
        await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(4));
        approvalPending = false;
        releasePlatformDispatch?.();
        await expect(pendingNotice).rejects.toThrow(
          "Recovery notice owner retired before delivery",
        );
        expect(visibleSend).toHaveBeenCalledTimes(2);
        expect(await findDeliveryIntentOwner(approvalNoticeKey)).toBeNull();
        expect(handleAction).not.toHaveBeenCalled();
      } finally {
        runtime.close();
        restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
      }
    });
  });

  it.each([
    {
      label: "reassigned before delivery",
      terminalToken: "xoxb-other",
      reassignment: "before" as const,
      terminalAttempts: 0,
      terminalPosts: 0,
    },
    {
      label: "reassigned at platform handoff",
      terminalToken: "xoxb-other",
      reassignment: "at-handoff" as const,
      terminalAttempts: 1,
      terminalPosts: 0,
    },
    {
      label: "unchanged after config refresh",
      terminalToken: "xoxb-original",
      reassignment: "before" as const,
      terminalAttempts: 1,
      terminalPosts: 1,
    },
  ])(
    "routes a Slack approval outcome with its write token $label",
    async ({ terminalToken, reassignment, terminalAttempts, terminalPosts }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "approval-terminal-token-" },
        async () => {
          const originalToken = "xoxb-original";
          const configForToken = (botToken: string): OpenClawConfig => ({
            channels: { slack: { accounts: { work: { botToken } } } },
          });
          const sourceConfig = configForToken(originalToken);
          let currentConfig = sourceConfig;
          const posts: Array<{ text: string; token: unknown }> = [];
          const sendText = vi.fn(
            async (options: {
              text: string;
              cfg: OpenClawConfig;
              onPlatformSendDispatch?: () => Promise<void>;
              assertDirectAdapterHandoff?: () => void;
            }) => {
              if (reassignment === "at-handoff" && options.text.includes("was denied")) {
                currentConfig = configForToken(terminalToken);
              }
              await options.onPlatformSendDispatch?.();
              options.assertDirectAdapterHandoff?.();
              posts.push({
                text: options.text,
                token: options.cfg.channels?.slack?.accounts?.work?.botToken,
              });
              return { channel: "slack", messageId: `1712345678.${posts.length}` };
            },
          );
          const plugin: ChannelPlugin = {
            id: "slack",
            meta: {
              id: "slack",
              label: "Slack",
              selectionLabel: "Slack",
              docsPath: "/channels/slack",
              blurb: "Slack-shaped approval test plugin.",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => ["work"],
              resolveAccount: () => ({}),
              isConfigured: () => true,
            },
            outbound: {
              deliveryMode: "direct",
              resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
              sendText,
            },
          };
          const pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
          stageActivePluginRegistry(
            createTestRegistry([{ pluginId: "slack", source: "test", plugin }]),
            null,
            "default",
          );
          const context = {
            ...createContext(),
            getRuntimeConfig: () => currentConfig,
          } as GatewayRequestContext;
          const runtime = createGatewayInstanceRuntime({
            getContext: () => context,
            getMethodRegistry: () => createRegistry({}),
            isDispatchAvailable: () => true,
          });
          const reporter = runtime.nativeApprovals.routeCoordinator.createReporter({
            handledKinds: new Set(["plugin"]),
            channel: "slack",
            channelLabel: "Slack",
            accountId: "work",
            sourceConfig,
            isOriginCurrent: () =>
              currentConfig.channels?.slack?.accounts?.work?.botToken === originalToken,
            requestGateway: runtime.nativeApprovals.requestRoute,
            shouldHandle: () => true,
            classifyRoute: () => "unbound",
          });

          try {
            const request: PluginApprovalRequest = {
              approvalKind: "plugin",
              id: `plugin:terminal-token-${terminalPosts}`,
              request: {
                title: "Review action",
                description: "Approve an operation",
                turnSourceChannel: "slack",
                turnSourceTo: "channel:C123",
                turnSourceAccountId: "work",
                turnSourceThreadId: "1712345678.123456",
              },
              createdAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
            };
            const approverDm = {
              surface: "approver-dm" as const,
              reason: "preferred" as const,
              target: { to: "user:U123" },
            };
            reporter.start();
            expect(reporter.selectRequest({ approvalKind: "plugin", request })).toEqual({
              kind: "selected",
            });
            await reporter.reportDelivery({
              approvalKind: "plugin",
              request,
              deliveryPlan: {
                targets: [approverDm],
                originTarget: { to: "channel:C123", threadId: "1712345678.123456" },
                notifyOriginWhenDmOnly: true,
              },
              deliveredTargets: [approverDm],
            });
            expect(posts).toEqual([
              {
                text: `Approval ${request.id} required. I sent the approval request to Slack DMs, not this chat.`,
                token: originalToken,
              },
            ]);

            if (reassignment === "before") {
              currentConfig = configForToken(terminalToken);
            }
            const publish = runtime.nativeApprovals.routeCoordinator.publishPluginTerminal({
              approvalId: request.id,
              status: "denied",
            });
            if (terminalPosts === 0) {
              await publish.catch(() => undefined);
            } else {
              await publish;
            }
            expect(
              sendText.mock.calls.filter((call) => call[0].text.includes("was denied")),
            ).toHaveLength(terminalAttempts);
            const terminalMessages = posts.filter((post) => post.text.includes("was denied"));
            expect(terminalMessages).toHaveLength(terminalPosts);
            expect(terminalMessages.map((post) => post.token)).toEqual(
              terminalPosts ? [originalToken] : [],
            );
            expect(
              await findDeliveryIntentOwner(`approval-terminal-notice:${request.id}`),
            ).toBeNull();
          } finally {
            await reporter.stop();
            runtime.close();
            restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
          }
        },
      );
    },
  );

  it("keeps approval subscribers isolated by Gateway instance and unregisters exactly once", () => {
    const registry = createRegistry({});
    const first = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    const second = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    const onRequested = vi.fn();
    const unsubscribe = first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => true,
      onRequested,
      onResolved: vi.fn(),
    });
    const request = {
      id: "approval-1",
      request: {},
      createdAtMs: 1,
      expiresAtMs: 2,
    } as ExecApprovalRequest;

    expect(second.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("plugin", request)).toBe(0);
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(1);
    expect(onRequested).toHaveBeenCalledOnce();

    unsubscribe();
    unsubscribe();
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);

    const declined = vi.fn();
    first.nativeApprovals.subscribe({
      eventKinds: new Set(["exec"]),
      shouldHandle: () => false,
      onRequested: declined,
      onResolved: vi.fn(),
    });
    expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);
    expect(declined).not.toHaveBeenCalled();
    first.close();
    expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
    second.close();
    expect(getGatewayRecoveryRuntime()).toBeUndefined();
  });

  it("rejects methods outside each closed internal principal", async () => {
    const runtime = createGatewayInstanceRuntime({
      getContext: createContext,
      getMethodRegistry: () => createRegistry({}),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request("config.get" as GatewayNativeApprovalMethod, {}),
    ).rejects.toThrow("internal principal cannot dispatch config.get");
    await expect(
      runtime.nativeApprovals.requestRoute("config.get" as "send", {
        channel: "slack",
        to: "channel:C123",
        message: "test",
        idempotencyKey: "approval-route-notice:test",
      }),
    ).rejects.toThrow("internal principal cannot dispatch config.get");
    runtime.close();
  });

  it("preserves a trusted approval resolver display name", async () => {
    const context = createContext();
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () =>
        createRegistry({
          "exec.approval.list": ({ client, respond }) =>
            respond(true, { displayName: client?.connect.client.displayName }),
        }),
      isDispatchAvailable: () => true,
    });

    await expect(
      runtime.nativeApprovals.request(
        "exec.approval.list",
        {},
        { clientDisplayName: "Telegram approval (owner)" },
      ),
    ).resolves.toEqual({ displayName: "Telegram approval (owner)" });
    runtime.close();
  });

  it("preserves the Gateway client's approval request deadline", async () => {
    vi.useFakeTimers();
    try {
      const { promise: started, resolve: markStarted } = createDeferred();
      const { promise: handlerCanFinish, resolve: finishHandler } = createDeferred();
      const context = createContext();
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () =>
          createRegistry({
            send: async () => {
              markStarted();
              await handlerCanFinish;
            },
          }),
        isDispatchAvailable: () => true,
      });

      try {
        const request = runtime.nativeApprovals.requestRoute("send", {
          channel: "slack",
          to: "channel:C123",
          message: "test",
          idempotencyKey: "approval-route-notice:test",
        });
        const error = request.catch((value: unknown) => value);
        await started;
        await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
        const caught = await error;
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("gateway request timeout for send");
      } finally {
        finishHandler();
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        runtime.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
