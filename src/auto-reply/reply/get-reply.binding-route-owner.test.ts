import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import {
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
} from "../../plugin-sdk/channel-inbound.js";
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
import { getReplyFromConfigInternal } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";

const observed = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async ({ agentId }: { agentId?: string }) => {
    observed.events.push(`backend:${agentId}`);
    return { payloads: [{ text: `${agentId} prepared` }], meta: { durationMs: 1 } };
  }),
}));

let state: OpenClawTestState;
let cfg: ReturnType<typeof withFullRuntimeReplyConfig>;
const adapters: SessionBindingAdapter[] = [];
const conversation: ConversationRef = {
  channel: "webchat",
  accountId: "default",
  conversationId: "room",
};
const baseRoute = {
  agentId: "main",
  channel: "webchat",
  accountId: "default",
  sessionKey: "global",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "session" as const,
  matchedBy: "default" as const,
};
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "reply-owner", env: { OPENCLAW_TEST_FAST: "0" } });
  cfg = withFullRuntimeReplyConfig({
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: state.path("main-workspace") },
        work: { workspace: state.path("work-workspace") },
      },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  });
  await state.writeConfig(cfg);
});
afterEach(async () => {
  for (const adapter of adapters.splice(0).toReversed()) {
    unregisterSessionBindingAdapter({ channel: "webchat", accountId: "default", adapter });
  }
  await state?.cleanup();
  resetInboundDedupe();
  observed.events.length = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function registerAdapter(
  lookup: (ref: ConversationRef) => SessionBindingRecord | null,
  overrides: Partial<SessionBindingAdapter> = {},
) {
  const adapter: SessionBindingAdapter = {
    channel: "webchat",
    accountId: "default",
    listBySession: () => {
      const binding = lookup(conversation);
      return binding ? [binding] : [];
    },
    inspectByConversation: lookup,
    resolveByConversation: lookup,
    inspectByConversationAsync: async (ref) => lookup(ref),
    resolveByConversationAsync: async (ref) => lookup(ref),
    touchAsync: async () => {},
    ...overrides,
  };
  adapters.push(adapter);
  registerSessionBindingAdapter(adapter);
  return adapter;
}

function makeContext(
  route: BuildChannelInboundEventContextParams["route"],
  native?: boolean,
  target?: string,
) {
  return buildChannelInboundEventContext({
    channel: "webchat",
    accountId: "default",
    messageId: String(native ?? "binding"),
    from: "synthetic-user",
    sender: { id: "synthetic-user" },
    conversation: { kind: "direct", id: "room" },
    route,
    reply: { to: "room" },
    message: { rawBody: native ? "/help" : "hello" },
    access: { commands: { authorized: true } },
    command: native ? { kind: "native", name: "help", body: "/help", authorized: true } : undefined,
    extra: { CommandAuthorized: true, CommandTargetSessionKey: target },
  });
}

async function invoke(
  entrypoint: "getReply" | "dispatch" | "inbound",
  ctx: Parameters<typeof dispatchReplyFromConfig>[0]["ctx"],
  replyOptions?: Parameters<typeof getReplyFromConfigInternal>[1],
) {
  if (entrypoint === "getReply") {
    const reply = await getReplyFromConfigInternal(ctx, replyOptions, cfg);
    return Array.isArray(reply) ? reply : reply ? [reply] : [];
  }
  const replies: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      observed.events.push("delivered");
      replies.push(payload);
    },
  });
  try {
    const dispatch = entrypoint === "inbound" ? dispatchInboundMessage : dispatchReplyFromConfig;
    await dispatch({ ctx, cfg, dispatcher, replyOptions });
    return replies;
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
}

it.each([
  ["getReply", "earlier-child-change-during-later-base-read"],
  ["getReply", "derived-none-to-global"],
  ["dispatch", "metadata-during-touch"],
] as const)("preserves ownership through %s after %s", async (entrypoint, scenario) => {
  const childChange = scenario === "earlier-child-change-during-later-base-read";
  const duringTouch = scenario === "metadata-during-touch";
  const childRequest = { ...conversation, conversationId: "child", parentConversationId: "room" };
  const binding: SessionBindingRecord = {
    bindingId: "new-global",
    targetSessionKey: "global",
    targetKind: "session",
    status: "active",
    boundAt: 1,
    conversation,
    metadata: { agentId: "work" },
  };
  let childBinding: SessionBindingRecord | null = null;
  let current: SessionBindingRecord | null =
    duringTouch || childChange
      ? {
          ...binding,
          bindingId: childChange ? "existing-base" : binding.bindingId,
          metadata: { agentId: "main" },
        }
      : null;
  const lookup = (ref: ConversationRef) => {
    if (childChange) {
      return ref.conversationId === "child"
        ? childBinding
        : ref.conversationId === "room"
          ? current
          : null;
    }
    return current;
  };
  const entered = createDeferred();
  const release = createDeferred();
  let pending = false;
  const read = async (ref: ConversationRef) => {
    if (pending && !duringTouch && (!childChange || ref.conversationId === "room")) {
      pending = false;
      entered.resolve();
      await release.promise;
    }
    return lookup(ref);
  };
  registerAdapter(lookup, {
    listBySession: () => (current ? [current] : []),
    resolveByConversationAsync: read,
    inspectByConversationAsync: read,
    touchAsync: async () => {
      if (pending && duringTouch) {
        pending = false;
        entered.resolve();
        await release.promise;
      }
    },
    ...(childChange
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
  });
  const buildContext = async () => {
    const childRoute = childChange
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
              conversation,
            })
          ).route
      : inspectRuntimeConversationBindingRoute({
          route: baseRoute,
          inspection: await getSessionBindingService().inspectByConversationAsync(conversation),
        }).route;
    return makeContext({
      ...route,
      routeSessionKey: route.sessionKey,
      ...(scenario === "derived-none-to-global"
        ? { dispatchSessionKey: `agent:${route.agentId}:webchat:direct:room:thread:42` }
        : {}),
    });
  };
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
  let ctx = await buildContext();
  pending = true;
  const settled = invoke(entrypoint, ctx, options).then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([entered.promise, settled]);
  if (childChange) {
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
  expect(await settled, `reply events: ${observed.events.join(", ")}`).toMatchObject({
    code: "SESSION_WORK_START_CHANGED",
  });
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
  expect(observed.events).not.toContain("adopted");
  expect(observed.events).not.toContain("delivered");
  expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: "global" })).toBeUndefined();
  expect(loadSessionEntryReadOnly({ agentId: "work", sessionKey: "global" })).toBeUndefined();
  if (childChange) {
    expect(existsSync(state.path("main-workspace"))).toBe(false);
  }
  if (entrypoint === "dispatch") {
    const claim = claimInboundDedupe(ctx);
    expect(claim.status).toBe("claimed");
    claim.release?.();
  }
  ctx = await buildContext();
  await invoke(entrypoint, ctx, options);
  expect(runEmbeddedAgent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: "work",
      sessionKey: ctx.SessionKey,
      workspaceDir: state.path("work-workspace"),
    }),
  );
  expect(observed.events.filter((event) => event === "adopted")).toHaveLength(1);
  expect(loadSessionEntryReadOnly({ agentId: "work", sessionKey: ctx.SessionKey })).toBeDefined();
  if (entrypoint === "dispatch") {
    expect(observed.events.filter((event) => event === "delivered")).toHaveLength(1);
    expect(claimInboundDedupe(ctx).status).toBe("duplicate");
  }
});

it("honors a public SDK native target with unavailable source facts", async () => {
  registerAdapter(() => null, {
    inspectByConversationAsync: async () => {
      registerAdapter(() => null);
      return null;
    },
  });
  const inspection = await getSessionBindingService().inspectByConversationAsync(conversation);
  expect(inspection.status).toBe("unavailable");
  const resolved = inspectRuntimeConversationBindingRoute({
    route: { ...baseRoute, sessionKey: "agent:main:source" },
    inspection,
  });
  const targets = resolveNativeCommandSessionTargets({
    agentId: resolved.route.agentId,
    sessionPrefix: "webchat:slash",
    userId: "synthetic-user",
    targetSessionKey: "agent:work:explicit-command",
  });
  const route = {
    ...resolved.route,
    routeSessionKey: resolved.route.sessionKey,
    dispatchSessionKey: targets.sessionKey,
  };
  const commandContext = makeContext(route, true, targets.commandTargetSessionKey);
  const ordinaryContext = makeContext(route, false, targets.commandTargetSessionKey);
  expect(commandContext).toMatchObject({
    AgentId: "main",
    SessionKey: targets.sessionKey,
    CommandTargetSessionKey: "agent:work:explicit-command",
    CommandSource: "native",
  });
  await expect(invoke("inbound", ordinaryContext)).rejects.toMatchObject({
    code: "SESSION_WORK_START_CHANGED",
  });
  expect(observed.events).not.toContain("delivered");
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
  expect(await invoke("inbound", commandContext)).toEqual([
    expect.objectContaining({ text: expect.stringContaining("ℹ️ Help") }),
  ]);
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
  expect(
    loadSessionEntryReadOnly({ agentId: "work", sessionKey: targets.commandTargetSessionKey }),
  ).toBeDefined();
  expect(
    loadSessionEntryReadOnly({ agentId: "main", sessionKey: "agent:main:replacement" }),
  ).toBeUndefined();
});

it.each([
  { agentId: "work", sessionKey: "global", target: undefined },
  { agentId: "main", sessionKey: "agent:main:source", target: "agent:work:target" },
])("stages a work attachment from $sessionKey/$target", async ({ agentId, sessionKey, target }) => {
  const file = state.statePath("media", "inbound", "owner.zip");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = "PK\u0003\u0004mimetypeapplication/epub+zipcontent.opf";
  await fs.writeFile(file, bytes);
  const ctx = finalizeInboundContext({
    AgentId: agentId,
    SessionKey: sessionKey,
    CommandTargetSessionKey: target,
    CommandSource: target ? "native" : undefined,
    Body: "read this attachment",
    BodyForAgent: "read this attachment",
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    CommandAuthorized: true,
    media: [{ path: file, contentType: "application/zip" }],
  });
  expect(await invoke("getReply", ctx)).toEqual([
    expect.objectContaining({ text: "work prepared" }),
  ]);
  expect(runEmbeddedAgent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ agentId: "work", sessionKey: target ?? sessionKey }),
  );
  expect(ctx.media?.[0]).toMatchObject({
    staged: true,
    workspaceDir: state.path("work-workspace"),
  });
  expect(await fs.readFile(expectDefined(ctx.media?.[0]?.path, "staged attachment"), "utf8")).toBe(
    bytes,
  );
});
