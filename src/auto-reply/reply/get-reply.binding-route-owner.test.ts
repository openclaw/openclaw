import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import {
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { buildChannelInboundEventContext } from "../../plugin-sdk/channel-inbound.js";
import { resolveNativeCommandSessionTargets } from "../../plugin-sdk/command-auth-native.js";
import {
  getSessionBindingService,
  inspectRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
} from "../../plugin-sdk/conversation-binding-runtime.js";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  type ReplyPayload,
} from "../../plugin-sdk/reply-runtime.js";
import { registerSessionBindingAdapter } from "../../plugin-sdk/session-binding-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";

const observed = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async ({ agentId }: { agentId?: string }) => {
    observed.events.push(`backend:${agentId}`);
    return { payloads: [{ text: `${agentId} prepared` }], meta: { durationMs: 1 } };
  }),
}));

let state: OpenClawTestState | undefined;
let adapter: SessionBindingAdapter | undefined;
const registeredAdapters: SessionBindingAdapter[] = [];
afterEach(async () => {
  for (const registered of registeredAdapters.splice(0).toReversed()) {
    unregisterSessionBindingAdapter({
      channel: "webchat",
      accountId: "default",
      adapter: registered,
    });
  }
  adapter = undefined;
  await state?.cleanup();
  state = undefined;
  resetInboundDedupe();
  observed.events.length = 0;
  vi.clearAllMocks();
});

async function createBindingRouteOwnerFixture(label: string) {
  const testState = await createOpenClawTestState({
    label,
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  state = testState;
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: testState.path("main-workspace") },
        work: { workspace: testState.path("work-workspace") },
      },
      defaults: {
        workspace: testState.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  });
  await testState.writeConfig(cfg);
  return { testState, cfg };
}

it.each(
  (["getReply", "dispatch"] as const).flatMap((entrypoint) =>
    (
      [
        "none-to-global",
        "inspection-owner-replaced",
        "earlier-child-change-during-later-base-read",
        "plugin-to-global",
        "parent-to-child",
        "metadata-during-touch",
        "derived-none-to-global",
        "derived-bound",
        "stable-unbound",
        "stable-bound",
        "stable-parent",
        "ignored-cron",
        "direct",
      ] as const
    ).map((scenario) => ({ entrypoint, scenario })),
  ),
)(
  "preserves prepared ownership through $entrypoint: $scenario",
  async ({ entrypoint, scenario }) => {
    const fixture = await createBindingRouteOwnerFixture("binding-route-owner");
    state = fixture.testState;
    const { cfg } = fixture;
    const earlierChildChange = scenario === "earlier-child-change-during-later-base-read";
    const parentSelection = scenario === "parent-to-child" || scenario === "stable-parent";
    const request: ConversationRef = {
      channel: "webchat",
      accountId: "default",
      conversationId: "room",
      ...(parentSelection ? { parentConversationId: "parent" } : {}),
    };
    const childRequest: ConversationRef = {
      ...request,
      conversationId: "child",
      parentConversationId: request.conversationId,
    };
    let childBinding: SessionBindingRecord | null = null;
    const binding: SessionBindingRecord = {
      bindingId: "new-global",
      targetSessionKey: scenario === "derived-bound" ? "agent:work:main" : "global",
      targetKind: "session",
      status: "active",
      boundAt: 1,
      conversation: request,
      metadata: { agentId: "work" },
    };
    const parent: SessionBindingRecord = {
      ...binding,
      bindingId: "existing-parent",
      metadata: { agentId: "main" },
      conversation: { ...request, conversationId: "parent", parentConversationId: undefined },
    };
    let current: SessionBindingRecord | null =
      scenario === "metadata-during-touch" || earlierChildChange
        ? {
            ...binding,
            bindingId: earlierChildChange ? "existing-base" : binding.bindingId,
            metadata: { agentId: "main" },
          }
        : scenario === "stable-bound" || scenario === "derived-bound"
          ? binding
          : parentSelection
            ? parent
            : scenario === "ignored-cron"
              ? { ...binding, targetSessionKey: "agent:main:cron:job:run:proof" }
              : scenario === "plugin-to-global"
                ? {
                    ...binding,
                    targetSessionKey: "plugin-binding:synthetic:source",
                    metadata: {
                      pluginBindingOwner: "plugin",
                      pluginId: "synthetic",
                      pluginRoot: state.path("plugin"),
                    },
                  }
                : null;
    const inspectionReplacement = scenario === "inspection-owner-replaced";
    const transition =
      earlierChildChange ||
      inspectionReplacement ||
      scenario === "none-to-global" ||
      scenario === "plugin-to-global" ||
      scenario === "parent-to-child" ||
      scenario === "metadata-during-touch" ||
      scenario === "derived-none-to-global";
    const entered = createDeferred();
    const release = createDeferred();
    let pending = false;
    let replacedDuringInspection = false;
    const lookup = (ref: ConversationRef) => {
      if (earlierChildChange) {
        return ref.conversationId === childRequest.conversationId
          ? childBinding
          : ref.conversationId === request.conversationId
            ? current
            : null;
      }
      if (!parentSelection) {
        return current;
      }
      if (ref.conversationId === "parent") {
        return parent;
      }
      return ref.conversationId === "room" && ref.parentConversationId === "parent"
        ? current
        : null;
    };
    const readAsync = async (ref: ConversationRef) => {
      if (
        pending &&
        scenario !== "metadata-during-touch" &&
        (!earlierChildChange || ref.conversationId === request.conversationId)
      ) {
        pending = false;
        entered.resolve();
        await release.promise;
      }
      return lookup(ref);
    };
    adapter = {
      channel: "webchat",
      accountId: "default",
      listBySession: () => (current ? [current] : []),
      ...(earlierChildChange
        ? {
            bind: async (input: Parameters<NonNullable<SessionBindingAdapter["bind"]>>[0]) => {
              childBinding = {
                ...binding,
                targetSessionKey: input.targetSessionKey,
                targetKind: input.targetKind,
                conversation: input.conversation,
                metadata: input.metadata,
              };
              return childBinding;
            },
          }
        : {}),
      resolveByConversation: lookup,
      inspectByConversation: lookup,
      inspectByConversationAsync: readAsync,
      ...(inspectionReplacement
        ? {
            inspectByConversationAsync: async (ref: ConversationRef) => {
              const captured = lookup(ref);
              if (!replacedDuringInspection) {
                replacedDuringInspection = true;
                const retiring = adapter;
                if (!retiring) {
                  throw new Error("Expected the first registered binding owner");
                }
                await Promise.resolve();
                unregisterSessionBindingAdapter({
                  channel: "webchat",
                  accountId: "default",
                  adapter: retiring,
                });
                current = binding;
                const replacement: SessionBindingAdapter = {
                  channel: "webchat",
                  accountId: "default",
                  listBySession: () => [binding],
                  resolveByConversation: () => binding,
                  inspectByConversationAsync: async () => binding,
                  resolveByConversationAsync: async () => binding,
                  touchAsync: async () => {},
                };
                adapter = replacement;
                registeredAdapters.push(replacement);
                registerSessionBindingAdapter(replacement);
              }
              return captured;
            },
          }
        : {}),
      resolveByConversationAsync: readAsync,
      touchAsync: async () => {
        if (pending && scenario === "metadata-during-touch") {
          pending = false;
          entered.resolve();
          await release.promise;
        }
      },
    };
    registeredAdapters.push(adapter);
    registerSessionBindingAdapter(adapter);
    const buildContext = async () => {
      const baseRoute = {
        agentId: scenario === "direct" ? "work" : "main",
        channel: "webchat",
        accountId: "default",
        sessionKey: "global",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session" as const,
        matchedBy: "default" as const,
      };
      const childRoute = earlierChildChange
        ? await resolveRuntimeConversationBindingRouteAsync({
            route: baseRoute,
            conversation: childRequest,
          })
        : undefined;
      const route = childRoute
        ? childRoute.bindingRecord
          ? childRoute.route
          : (
              await resolveRuntimeConversationBindingRouteAsync({
                route: childRoute.route,
                conversation: request,
              })
            ).route
        : scenario === "direct"
          ? baseRoute
          : inspectionReplacement
            ? (
                await resolveRuntimeConversationBindingRouteAsync({
                  route: baseRoute,
                  conversation: request,
                })
              ).route
            : inspectRuntimeConversationBindingRoute({
                route: baseRoute,
                inspection: await getSessionBindingService().inspectByConversationAsync(request),
              }).route;
      return buildChannelInboundEventContext({
        channel: "webchat",
        accountId: "default",
        messageId: `${entrypoint}-${scenario}`,
        from: "synthetic-user",
        sender: { id: "synthetic-user" },
        conversation: { kind: "direct", id: "room" },
        route: {
          ...route,
          ...(scenario === "derived-bound"
            ? { sessionKey: `${route.sessionKey}:thread:room:42` }
            : scenario === "derived-none-to-global"
              ? { dispatchSessionKey: `agent:${route.agentId}:webchat:direct:room:thread:42` }
              : {}),
          routeSessionKey:
            scenario === "derived-bound" ? `${route.sessionKey}:thread:room:42` : route.sessionKey,
        },
        reply: { to: "room" },
        message: { rawBody: "hello" },
        extra: { CommandAuthorized: true },
      });
    };
    const invoke = async (ctx: Awaited<ReturnType<typeof buildContext>>) => {
      const options = {
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            observed.events.push("adopted");
          },
          onAbandoned: () => {
            observed.events.push("abandoned");
          },
        },
      };
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          observed.events.push("delivered");
        },
      });
      try {
        return entrypoint === "getReply"
          ? await getReplyFromConfig(ctx, options, cfg)
          : await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions: options });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    };
    let ctx = inspectionReplacement ? undefined : await buildContext();
    pending = transition && !inspectionReplacement;
    const invocation = ctx
      ? invoke(ctx)
      : buildContext().then((prepared) => {
          ctx = prepared;
          return invoke(prepared);
        });
    const settled = invocation.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (transition) {
      if (!inspectionReplacement) {
        await Promise.race([entered.promise, settled]);
        if (earlierChildChange) {
          await getSessionBindingService().bind({
            targetSessionKey: "global",
            targetKind: "session",
            conversation: childRequest,
            placement: "current",
            metadata: { agentId: "work" },
          });
        } else {
          current = binding;
        }
        release.resolve();
      }
      expect(await settled, `reply events: ${observed.events.join(", ")}`).toMatchObject({
        code: "SESSION_WORK_START_CHANGED",
      });
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(observed.events).not.toContain("adopted");
      expect(observed.events).not.toContain("delivered");
      expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: "global" })).toBeUndefined();
      expect(loadSessionEntryReadOnly({ agentId: "work", sessionKey: "global" })).toBeUndefined();
      if (earlierChildChange) {
        expect(existsSync(state.path("main-workspace"))).toBe(false);
      }
      if (entrypoint === "dispatch" && ctx) {
        const claim = claimInboundDedupe(ctx);
        expect(claim.status).toBe("claimed");
        claim.release?.();
      }
      ctx = await buildContext();
      await invoke(ctx);
    } else {
      expect(await settled).toBeUndefined();
    }
    if (!ctx) {
      throw new Error("Expected a rebuilt reply context");
    }
    const expectedAgent =
      transition ||
      scenario === "stable-bound" ||
      scenario === "derived-bound" ||
      scenario === "direct"
        ? "work"
        : "main";
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(runEmbeddedAgent).mock.calls[0]?.[0]).toMatchObject({
      agentId: expectedAgent,
      sessionKey: ctx.SessionKey,
      workspaceDir: state.path(`${expectedAgent}-workspace`),
    });
    expect(observed.events.filter((event) => event === "adopted")).toHaveLength(1);
    expect(
      loadSessionEntryReadOnly({ agentId: expectedAgent, sessionKey: ctx.SessionKey }),
    ).toBeDefined();
    if (entrypoint === "dispatch") {
      expect(observed.events.filter((event) => event === "delivered")).toHaveLength(1);
      expect(claimInboundDedupe(ctx).status).toBe("duplicate");
    }
  },
);

it.each(
  (["getReply", "dispatch"] as const).flatMap((entrypoint) =>
    (["changed", "unavailable"] as const).map((sourceState) => ({ entrypoint, sourceState })),
  ),
)(
  "honors a public SDK native target through $entrypoint with $sourceState source facts",
  async ({ entrypoint, sourceState }) => {
    const fixture = await createBindingRouteOwnerFixture("public-native-binding-target");
    state = fixture.testState;
    const { cfg } = fixture;
    const conversation: ConversationRef = {
      channel: "webchat",
      accountId: "default",
      conversationId: "command-room",
    };
    let current: SessionBindingRecord | null = null;
    const makeAdapter = (): SessionBindingAdapter => ({
      channel: "webchat",
      accountId: "default",
      listBySession: () => (current ? [current] : []),
      inspectByConversation: () => current,
      resolveByConversation: () => current,
      resolveByConversationAsync: async () => current,
      touchAsync: async () => {},
    });
    adapter = makeAdapter();
    if (sourceState === "unavailable") {
      adapter.inspectByConversationAsync = async () => {
        const captured = current;
        const replacement = makeAdapter();
        registeredAdapters.push(replacement);
        registerSessionBindingAdapter(replacement);
        return captured;
      };
    }
    registeredAdapters.push(adapter);
    registerSessionBindingAdapter(adapter);
    const inspection = await getSessionBindingService().inspectByConversationAsync(conversation);
    expect(inspection.status).toBe(sourceState === "unavailable" ? "unavailable" : "available");
    const resolved = inspectRuntimeConversationBindingRoute({
      route: {
        agentId: "main",
        channel: "webchat",
        accountId: "default",
        sessionKey: "agent:main:source",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      inspection,
    });
    const targets = resolveNativeCommandSessionTargets({
      agentId: resolved.route.agentId,
      sessionPrefix: "webchat:slash",
      userId: "synthetic-user",
      targetSessionKey: "agent:work:explicit-command",
    });
    const buildContext = (native: boolean) =>
      buildChannelInboundEventContext({
        channel: "webchat",
        accountId: "default",
        messageId: `${entrypoint}-${sourceState}-${native ? "native" : "ordinary"}`,
        from: "synthetic-user",
        sender: { id: "synthetic-user" },
        conversation: { kind: "direct", id: conversation.conversationId },
        route: {
          ...resolved.route,
          routeSessionKey: resolved.route.sessionKey,
          dispatchSessionKey: targets.sessionKey,
        },
        reply: { to: "command-room" },
        message: { rawBody: native ? "/help" : "hello" },
        access: { commands: { authorized: true } },
        command: native
          ? { kind: "native", name: "help", body: "/help", authorized: true }
          : undefined,
        extra: { CommandTargetSessionKey: targets.commandTargetSessionKey },
      });
    const commandContext = buildContext(true);
    const ordinaryContext = buildContext(false);
    expect(commandContext).toMatchObject({
      AgentId: "main",
      SessionKey: targets.sessionKey,
      CommandTargetSessionKey: "agent:work:explicit-command",
      CommandSource: "native",
    });
    if (sourceState === "changed") {
      current = {
        bindingId: "replacement-source",
        boundAt: 1,
        targetKind: "session",
        targetSessionKey: "agent:main:replacement",
        conversation,
        status: "active",
      };
    }
    const replies: ReplyPayload[] = [];
    const invoke = async (ctx: typeof commandContext) => {
      if (entrypoint === "getReply") {
        const reply = await getReplyFromConfig(ctx, {}, cfg);
        replies.push(...(Array.isArray(reply) ? reply : reply ? [reply] : []));
        return;
      }
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          replies.push(payload);
        },
      });
      try {
        await dispatchInboundMessage({ ctx, cfg, dispatcher });
      } finally {
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
    };

    await expect(invoke(ordinaryContext)).rejects.toMatchObject({
      code: "SESSION_WORK_START_CHANGED",
    });
    expect(replies).toEqual([]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    await invoke(commandContext);
    expect(replies).toEqual([
      expect.objectContaining({ text: expect.stringContaining("ℹ️ Help") }),
    ]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(
      loadSessionEntryReadOnly({ agentId: "work", sessionKey: targets.commandTargetSessionKey }),
    ).toBeDefined();
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey: "agent:main:replacement" }),
    ).toBeUndefined();
  },
);
