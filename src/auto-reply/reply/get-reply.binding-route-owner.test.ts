import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
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
import * as steeringAuthority from "./agent-runner-fallback-authority.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";
import { getFollowupQueueDepth } from "./queue.js";
import { clearFollowupQueue } from "./queue/state.js";
import { replyRunRegistry } from "./reply-run-registry.js";

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
  routeSessionKey: "global",
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
  messageId = String(native ?? "binding"),
) {
  return buildChannelInboundEventContext({
    channel: "webchat",
    accountId: "default",
    messageId,
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
  replyOptions?: Parameters<typeof getReplyFromConfig>[1],
) {
  if (entrypoint === "getReply") {
    const reply = await getReplyFromConfig(ctx, replyOptions, cfg);
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

type DirectAttemptFixtureOptions = {
  toolsAllow?: string[];
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  terminalReplyExpectation?: "required" | "optional";
  inputProvenance?: {
    kind: "inter_session";
    sourceTool: "subagent_settle";
    sourceRole: "subagent";
    sourceSessionKey: string;
    originSessionId: string;
  };
};

type DirectInjectionRecord = {
  text: string;
  authorityKind: "run" | "source-bound";
  isInboundUserMessage: boolean;
  waitForTranscriptCommit: boolean;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  queueIdentity?: string;
};

async function seedSessionEntry(messageId: string) {
  await invoke("dispatch", makeContext(baseRoute, false, undefined, messageId));
  const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey: baseRoute.sessionKey });
  expect(entry?.sessionId).toBeTruthy();
  expect(replyRunRegistry.get(baseRoute.sessionKey)).toBeUndefined();
  return expectDefined(entry, "direct-run seed session");
}

async function withActiveDirectAttempt<T>(
  params: {
    sessionId: string;
    sessionFile: string;
    bashElevated: Parameters<typeof runEmbeddedAgent>[0]["bashElevated"];
    options?: DirectAttemptFixtureOptions;
  },
  run: (owner: {
    sessionKey: string;
    sessionId: string;
    sessionFile: string;
    runId: string;
    target: ReturnType<typeof replyRunRegistry.resolveCurrentMessageInjectionTarget>;
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    injections: DirectInjectionRecord[];
    transcriptConfirmations: string[];
  }) => Promise<T>,
): Promise<T> {
  const options = params.options ?? {};
  const sessionKey = baseRoute.sessionKey;
  const sessionFile = params.sessionFile;
  const runId = "direct-attempt-" + params.sessionId;
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "reply-owner-direct-attempt-test" },
    },
  });
  try {
    const admittedRunContext = await admission.admit("embedded", "reply-owner-direct-attempt-test");
    const attempt = {
      sessionId: params.sessionId,
      sessionKey,
      sessionFile,
      runId,
      agentId: "main",
      config: cfg,
      agentDir: state.agentDir(),
      workspaceDir: state.path("main-workspace"),
      provider: "mock-openai",
      modelId: "gpt-5.6-luna",
      sandboxSessionKey: sessionKey,
      messageChannel: "webchat",
      senderIsOwner: false,
      senderId: "synthetic-user",
      messageProvider: "webchat",
      chatType: "direct" as const,
      agentAccountId: "default",
      traceAuthorized: false,
      bashElevated: params.bashElevated,
      ...(options.toolsAllow !== undefined ? { toolsAllow: options.toolsAllow } : {}),
      ...(options.inputProvenance ? { inputProvenance: options.inputProvenance } : {}),
    };
    return await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext },
      attempt,
      undefined,
      async (prepared) => {
        expect(prepared.toolAuthorityFingerprint).toBeTruthy();
        const injections: DirectInjectionRecord[] = [];
        const transcriptConfirmations: string[] = [];
        const handle = createEmbeddedRunHandle({
          runId,
          toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
          isStreaming: true,
          supportsTranscriptCommitWait: true,
        });
        handle.sourceReplyDeliveryMode = options.sourceReplyDeliveryMode ?? "automatic";
        handle.terminalReplyExpectation = options.terminalReplyExpectation ?? "required";
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (text, queueOptions, assertCurrent, authorityKind) => {
            assertCurrent();
            const recorder = queueOptions?.userTurnTranscriptRecorder;
            const confirmTranscript = recorder?.confirmSteerTargetRunIdForPersistence;
            if (recorder && confirmTranscript) {
              recorder.confirmSteerTargetRunIdForPersistence = async (targetRunId) => {
                transcriptConfirmations.push(targetRunId);
                await confirmTranscript(targetRunId);
              };
            }
            injections.push({
              text,
              authorityKind,
              isInboundUserMessage: queueOptions?.isInboundUserMessage === true,
              waitForTranscriptCommit: queueOptions?.waitForTranscriptCommit === true,
              sourceReplyDeliveryMode: queueOptions?.sourceReplyDeliveryMode,
              queueIdentity: queueOptions?.queueIdentity,
            });
            queueOptions?.onQueueAccepted?.(true);
          },
        };
        setActiveEmbeddedRun(params.sessionId, handle, sessionKey, sessionFile, "main");
        try {
          const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey);
          return await run({
            sessionKey,
            sessionId: params.sessionId,
            sessionFile,
            runId,
            target,
            handle,
            injections,
            transcriptConfirmations,
          });
        } finally {
          clearActiveEmbeddedRun(params.sessionId, handle, sessionKey);
        }
      },
    );
  } finally {
    admission.close();
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

it.for([
  {
    name: "adopts a visible ordinary inbound turn into its admitted direct attempt",
    replace: false,
  },
  {
    name: "does not retarget a replacement direct registration during authority preparation",
    replace: true,
  },
])("$name", async ({ replace }, { signal }) => {
  const sessionKey = baseRoute.sessionKey;
  const seeded = await seedSessionEntry(replace ? "direct-aba-seed" : "direct-visible-seed");
  const sessionFile = expectDefined(
    vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].sessionFile,
    "real channel session file",
  );
  const bashElevated = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].bashElevated;
  expect(bashElevated).toBeDefined();
  vi.mocked(runEmbeddedAgent).mockClear();
  observed.events.length = 0;
  const ctx = makeContext(
    baseRoute,
    false,
    undefined,
    replace ? "direct-aba-inbound" : "direct-visible-inbound",
  );
  const adopted: string[] = [];
  const deferred: string[] = [];
  const adoptedFollowupSettled = createDeferred();
  const replacementReady = createDeferred<DirectInjectionRecord[]>();
  const releaseReplacement = createDeferred();
  let replacementLease: Promise<void> | undefined;
  let replacementInjections: DirectInjectionRecord[] | undefined;
  try {
    await withActiveDirectAttempt(
      { sessionId: seeded.sessionId, sessionFile, bashElevated },
      async (owner) => {
        expect(owner.sessionId).not.toBe(owner.sessionKey);
        expect(owner.target).toMatchObject({ runId: owner.runId, sourceTurnId: owner.runId });
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
        const originalResolve = steeringAuthority.resolveReplySteeringAuthority;
        const resolver = replace
          ? vi
              .spyOn(steeringAuthority, "resolveReplySteeringAuthority")
              .mockImplementation(async (...args) => {
                const selected = await originalResolve(...args);
                if (!replacementLease) {
                  replacementLease = withActiveDirectAttempt(
                    { sessionId: seeded.sessionId, sessionFile, bashElevated },
                    async (replacement) => {
                      expect(replacement.runId).toBe(owner.runId);
                      replacementReady.resolve(replacement.injections);
                      await releaseReplacement.promise;
                    },
                  );
                  replacementInjections = await withinTest(
                    awaitGateBeforeSettlement(
                      replacementReady.promise,
                      replacementLease,
                      "replacement scope settled before registration",
                    ),
                    signal,
                  );
                }
                return selected;
              })
          : undefined;
        try {
          await withinTest(
            withoutGatewayToolCallerIdentity(() =>
              invoke("inbound", ctx, {
                turnAdoptionLifecycle: {
                  onAdopted: () => {
                    adopted.push(owner.runId);
                  },
                  onDeferred: () => {
                    deferred.push(owner.runId);
                    return true;
                  },
                  onSettled: () => {
                    if (adopted.length > 0) {
                      adoptedFollowupSettled.resolve();
                    }
                  },
                },
              }),
            ),
            signal,
          );
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          if (replace) {
            expect(resolver).toHaveBeenCalledOnce();
            expect(getFollowupQueueDepth(sessionKey)).toBe(1);
            expect(owner.injections).toEqual([]);
            expect(
              expectDefined(replacementInjections, "replacement backend observations"),
            ).toEqual([]);
            expect(owner.transcriptConfirmations).toEqual([]);
            expect(adopted).toEqual([]);
          } else {
            expect(getFollowupQueueDepth(sessionKey)).toBe(0);
            expect(owner.injections).toHaveLength(1);
            const injection = expectDefined(owner.injections[0], "accepted direct input");
            expect(injection).toMatchObject({
              text: expect.stringContaining("hello"),
              authorityKind: "run",
              isInboundUserMessage: true,
              waitForTranscriptCommit: true,
            });
            expect(injection.queueIdentity).toBeTruthy();
            expect(owner.transcriptConfirmations).toEqual([owner.runId]);
          }
        } finally {
          resolver?.mockRestore();
          releaseReplacement.resolve();
          await replacementLease;
        }
      },
    );
    if (replace) {
      await withinTest(adoptedFollowupSettled.promise, signal);
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(adopted).toEqual(["direct-attempt-" + seeded.sessionId]);
    } else {
      expect(adopted).toEqual(["direct-attempt-" + seeded.sessionId]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    }
    expect(deferred).toEqual(["direct-attempt-" + seeded.sessionId]);
  } finally {
    releaseReplacement.resolve();
    await replacementLease;
    clearFollowupQueue(sessionKey);
  }
});

it("does not retarget a null caller capture", async ({ signal }) => {
  const sessionKey = baseRoute.sessionKey;
  const seeded = await seedSessionEntry("seed-null-direct-target");
  const sessionFile = expectDefined(
    vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].sessionFile,
    "real channel session file",
  );
  const bashElevated = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].bashElevated;
  expect(bashElevated).toBeDefined();
  vi.mocked(runEmbeddedAgent).mockClear();
  const runId = "direct-null-" + seeded.sessionId;
  const unadmittedHandle = createEmbeddedRunHandle({ runId: "unadmitted-" + seeded.sessionId });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "reply-owner-null-capture-test" },
    },
  });
  const captured =
    createDeferred<ReturnType<typeof replyRunRegistry.resolveCurrentMessageInjectionTarget>>();
  const originalResolve =
    replyRunRegistry.resolveCurrentMessageInjectionTarget.bind(replyRunRegistry);
  let activeHandle: ReturnType<typeof createEmbeddedRunHandle> | undefined = unadmittedHandle;
  let firstCapture = true;
  try {
    const admittedRunContext = await admission.admit("embedded", "reply-owner-null-capture-test");
    setActiveEmbeddedRun(seeded.sessionId, unadmittedHandle, sessionKey, sessionFile, "main");
    const attempt = {
      sessionId: seeded.sessionId,
      sessionKey,
      sessionFile,
      runId,
      agentId: "main",
      config: cfg,
      agentDir: state.agentDir(),
      workspaceDir: state.path("main-workspace"),
      provider: "mock-openai",
      modelId: "gpt-5.6-luna",
      sandboxSessionKey: sessionKey,
      messageChannel: "webchat",
      senderIsOwner: false,
      senderId: "synthetic-user",
      messageProvider: "webchat",
      chatType: "direct" as const,
      agentAccountId: "default",
      traceAuthorized: false,
      bashElevated,
    };
    await withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext },
      attempt,
      undefined,
      async (prepared) => {
        const injections: DirectInjectionRecord[] = [];
        const transcriptConfirmations: string[] = [];
        const handle = createEmbeddedRunHandle({
          runId,
          toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
          isStreaming: true,
          supportsTranscriptCommitWait: true,
        });
        handle.sourceReplyDeliveryMode = "automatic";
        handle.terminalReplyExpectation = "required";
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (text, queueOptions, assertCurrent, authorityKind) => {
            assertCurrent();
            const recorder = queueOptions?.userTurnTranscriptRecorder;
            const confirm = recorder?.confirmSteerTargetRunIdForPersistence;
            if (recorder && confirm) {
              recorder.confirmSteerTargetRunIdForPersistence = async (targetRunId) => {
                transcriptConfirmations.push(targetRunId);
                await confirm(targetRunId);
              };
            }
            injections.push({
              text,
              authorityKind,
              isInboundUserMessage: queueOptions?.isInboundUserMessage === true,
              waitForTranscriptCommit: queueOptions?.waitForTranscriptCommit === true,
              sourceReplyDeliveryMode: queueOptions?.sourceReplyDeliveryMode,
              queueIdentity: queueOptions?.queueIdentity,
            });
            queueOptions?.onQueueAccepted?.(true);
          },
        };
        const resolver = vi
          .spyOn(replyRunRegistry, "resolveCurrentMessageInjectionTarget")
          .mockImplementation((key) => {
            const target = originalResolve(key);
            if (firstCapture) {
              firstCapture = false;
              expect(target).toBeUndefined();
              clearActiveEmbeddedRun(seeded.sessionId, unadmittedHandle, sessionKey);
              setActiveEmbeddedRun(seeded.sessionId, handle, sessionKey, sessionFile, "main");
              activeHandle = handle;
              captured.resolve(target);
            }
            return target;
          });
        const pending = invoke(
          "inbound",
          makeContext(baseRoute, false, undefined, "null-direct-target-inbound"),
          {
            turnAdoptionLifecycle: {
              onAdopted: vi.fn(),
              onDeferred: () => true,
            },
          },
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(captured.promise, pending, "caller did not capture absence"),
            signal,
          );
          expect(originalResolve(sessionKey)).toMatchObject({ runId, sourceTurnId: runId });
          await withinTest(pending, signal);
          expect(injections).toEqual([]);
          expect(transcriptConfirmations).toEqual([]);
          expect(getFollowupQueueDepth(sessionKey)).toBe(1);
        } finally {
          resolver.mockRestore();
          if (activeHandle) {
            clearActiveEmbeddedRun(seeded.sessionId, activeHandle, sessionKey);
            activeHandle = undefined;
          }
          clearFollowupQueue(sessionKey);
        }
      },
    );
  } finally {
    if (activeHandle) {
      clearActiveEmbeddedRun(seeded.sessionId, activeHandle, sessionKey);
    }
    admission.close();
    clearFollowupQueue(sessionKey);
  }
});

it.for([
  {
    name: "optional inter-session requester-settle continuation",
    messageId: "direct-hidden-optional",
    options: {
      sourceReplyDeliveryMode: "message_tool_only" as const,
      terminalReplyExpectation: "optional" as const,
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool: "subagent_settle" as const,
        sourceRole: "subagent" as const,
        sourceSessionKey: "agent:work:child",
        originSessionId: "child-session",
      },
    },
  },
  {
    name: "optional direct reply contract",
    messageId: "direct-optional-reply",
    options: { terminalReplyExpectation: "optional" as const },
  },
  {
    name: "mismatched tool authority",
    messageId: "direct-mismatched-authority",
    options: { toolsAllow: ["exec"] },
  },
])(
  "keeps $name input on the protected followup path",
  async ({ messageId, options }, { signal }) => {
    const sessionKey = baseRoute.sessionKey;
    const seeded = await seedSessionEntry("seed-" + messageId);
    const sessionFile = expectDefined(
      vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].sessionFile,
      "real channel session file",
    );
    const bashElevated = vi.mocked(runEmbeddedAgent).mock.calls.at(-1)?.[0].bashElevated;
    expect(bashElevated).toBeDefined();
    vi.mocked(runEmbeddedAgent).mockClear();
    observed.events.length = 0;
    const ctx = makeContext(baseRoute, false, undefined, messageId);
    const adopted = vi.fn();
    const followupCompleted = createDeferred();
    const backend = vi.mocked(runEmbeddedAgent);
    const implementation = expectDefined(backend.getMockImplementation(), "mocked runtime");
    backend.mockImplementation(async (...args) => {
      try {
        const result = await implementation(...args);
        followupCompleted.resolve();
        return result;
      } catch (error) {
        followupCompleted.reject(error);
        throw error;
      }
    });
    try {
      await withActiveDirectAttempt(
        { sessionId: seeded.sessionId, sessionFile, bashElevated, options },
        async (owner) => {
          expect(owner.target).toMatchObject({ runId: owner.runId, sourceTurnId: owner.runId });
          await withoutGatewayToolCallerIdentity(() =>
            invoke("inbound", ctx, {
              turnAdoptionLifecycle: { onAdopted: adopted },
            }),
          );
          expect(owner.injections).toEqual([]);
          expect(owner.transcriptConfirmations).toEqual([]);
          expect(getFollowupQueueDepth(sessionKey)).toBe(1);
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          expect(adopted).not.toHaveBeenCalled();
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
        },
      );
      await withinTest(followupCompleted.promise, signal);
      expect(backend).toHaveBeenCalledTimes(1);
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    } finally {
      backend.mockImplementation(implementation);
      clearFollowupQueue(sessionKey);
    }
    expect(adopted).toHaveBeenCalledTimes(1);
  },
);
