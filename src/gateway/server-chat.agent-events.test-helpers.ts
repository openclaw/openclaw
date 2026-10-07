import { expect, test, vi } from "vitest";
import { getRuntimeConfig as getCurrentRuntimeConfig } from "../config/io.js";
import {
  onAgentRuntimeEvent,
  type AgentEventPayload,
  type AgentEventStream,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createChatRunState } from "./server-chat-state.js";
import type { ChatRunRegistration, ChatRunState } from "./server-chat-state.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import { agentDiscoveryMock } from "./test-helpers.runtime-state.js";

type AgentEventHandler = (event: AgentEventPayload) => void | Promise<void>;

type AgentEventOverrideKey =
  | "agentId"
  | "lifecycleGeneration"
  | "seq"
  | "sessionId"
  | "sessionKey"
  | "ts";
type AgentEventOverrides = {
  [Key in AgentEventOverrideKey]?: AgentEventPayload[Key] | undefined;
};
type AgentEventCase = readonly [
  stream: AgentEventStream,
  data: Record<string, unknown>,
  overrides?: AgentEventOverrides,
];

type TextTranscriptEventOptions = {
  id?: string;
  parentId?: string | null;
  timestamp?: number;
  message?: Record<string, unknown>;
};

export function emitAgentEvent(
  handler: AgentEventHandler,
  runId: string,
  stream: AgentEventStream,
  data: Record<string, unknown>,
  overrides: AgentEventOverrides = {},
) {
  return handler({ runId, seq: 1, stream, ts: Date.now(), data, ...overrides });
}

export function emitAgentEvents(
  handler: AgentEventHandler,
  runId: string,
  events: readonly AgentEventCase[],
) {
  return Promise.all(
    events.map(([stream, data, overrides], index) =>
      Promise.resolve(
        emitAgentEvent(handler, runId, stream, data, { seq: index + 1, ...overrides }),
      ),
    ),
  );
}

/** Preserve synchronous event ingress while joining every accepted handler at unsubscribe. */
export function subscribeAgentEvents(handler: AgentEventHandler) {
  const pending: Array<Promise<void>> = [];
  const unsubscribe = onAgentRuntimeEvent((event) => {
    const accepted = Promise.resolve(handler(event));
    pending.push(accepted);
    // Observe rejection now; drain retains the original promise and still fails.
    accepted.catch(() => undefined);
  });
  const drain = () => Promise.all(pending);
  return Object.assign(
    async () => {
      unsubscribe();
      await drain();
    },
    { drain },
  );
}

export function registerChatRun(
  state: ChatRunState,
  runId: string,
  sessionKey: string,
  clientRunId: string,
  overrides: Omit<ChatRunRegistration, "clientRunId" | "sessionKey"> = {},
) {
  state.registry.add(runId, { sessionKey, clientRunId, ...overrides });
}

export function registerNamedChatRun(
  state: ChatRunState,
  name: string,
  overrides: Omit<ChatRunRegistration, "clientRunId" | "sessionKey"> = {},
) {
  registerChatRun(state, `run-${name}`, `session-${name}`, `client-${name}`, overrides);
}

export function createChatVisionModelCatalogSnapshot(): Awaited<
  ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>
> {
  return {
    agentId: "main",
    agentDir: "/tmp/chat-attachment-vision-agent",
    catalogComplete: false,
    workspaceDir: "/tmp/chat-attachment-vision-workspace",
    config: {},
    entries: [
      {
        id: "vision-model",
        name: "Vision Model",
        provider: "test-provider",
        input: ["text", "image"],
      },
    ],
    routeVariants: [],
  };
}

export function createDirectChatContext(
  overrides: Partial<GatewayRequestContext> = {},
): GatewayRequestContext {
  const getRuntimeConfig = overrides.getRuntimeConfig ?? getCurrentRuntimeConfig;
  const loadGatewayModelCatalog =
    overrides.loadGatewayModelCatalog ??
    vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(async () =>
      agentDiscoveryMock.models.map((model) =>
        Object.assign({}, model, { name: model.name ?? model.id }),
      ),
    );
  return {
    loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot: vi.fn<
      GatewayRequestContext["loadGatewayModelCatalogSnapshot"]
    >(async (request) => {
      const entries = await loadGatewayModelCatalog(request);
      return {
        agentId: request?.agentId ?? "main",
        agentDir: "/tmp/chat-model-catalog-agent",
        workspaceDir: "/tmp/chat-model-catalog-workspace",
        config: getRuntimeConfig(),
        entries,
        routeVariants: entries,
        catalogComplete: true,
      };
    }),
    logGateway: {
      ...createSubsystemLogger("test/gateway"),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } satisfies GatewayRequestContext["logGateway"],
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    forgetConnectionAncestors: vi.fn<GatewayRequestContext["forgetConnectionAncestors"]>(),
    nodeSendToSession: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    getRuntimeConfig,
    trackExecution: trackAsyncWork,
    readChatMetadata: vi.fn(async () => {
      throw new Error("prepared chat metadata is unavailable in direct handler tests");
    }),
    recoveryRuntime: {
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    },
    dedupe: new Map(),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

export function createTextTranscriptEvent(
  role: "assistant" | "toolResult" | "user",
  text: string,
  options: TextTranscriptEventOptions = {},
) {
  const { id, parentId, timestamp = Date.now(), message = {} } = options;
  return {
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp,
      ...message,
    },
  };
}

type ChatConnectionIdentityInput = {
  authenticatedUserId?: string;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
  };
  idempotencyKey: string;
  message: string;
};

export function registerChatConnectionIdentityTest(harness: {
  withDirectChatSession: (run: () => Promise<void>) => Promise<void>;
  prepareSession: () => Promise<void>;
  waitForSessionWork: () => Promise<void> | undefined;
  sendControlUiChat: (
    params: ChatConnectionIdentityInput & { context: GatewayRequestContext; respond: RespondFn },
  ) => Promise<void>;
  readTranscript: () => unknown[];
}) {
  test("chat.send persists optional connection identity per turn", async () => {
    await harness.withDirectChatSession(async () => {
      await harness.prepareSession();
      const context = createDirectChatContext();
      const send = async (params: ChatConnectionIdentityInput) => {
        const removeCount = (context.removeChatRun as ReturnType<typeof vi.fn>).mock.calls.length;
        await harness.sendControlUiChat({
          context,
          ...params,
          respond: vi.fn() as RespondFn,
        });
        await harness.waitForSessionWork();
        expect(context.removeChatRun).toHaveBeenCalledTimes(removeCount + 1);
      };

      await send({
        authenticatedUserId: "alice@example.com",
        authenticatedUserProfile: {
          profileId: ensureProfileForEmail("alice@example.com").id,
          displayName: "Alice",
          hasAvatar: false,
        },
        idempotencyKey: "idem-attributed-alice",
        message: "prompt from alice",
      });
      await send({
        authenticatedUserId: "bob@example.com",
        authenticatedUserProfile: {
          profileId: ensureProfileForEmail("bob@example.com").id,
          displayName: "Bob",
          hasAvatar: true,
        },
        idempotencyKey: "idem-attributed-bob",
        message: "prompt from bob",
      });
      await send({
        idempotencyKey: "idem-unattributed",
        message: "prompt without identity",
      });

      const transcriptEvents = harness.readTranscript();
      expect(transcriptEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt from alice",
              __openclaw: expect.objectContaining({
                senderId: ensureProfileForEmail("alice@example.com").id,
                senderName: "Alice",
              }),
            }),
          }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt from bob",
              __openclaw: expect.objectContaining({
                senderId: ensureProfileForEmail("bob@example.com").id,
                senderName: "Bob",
              }),
            }),
          }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt without identity",
              __openclaw: expect.not.objectContaining({ senderId: expect.anything() }),
            }),
          }),
        ]),
      );
    });
  });
}

/** Bounded widget retention shares the agent-event fixture without growing its event-fanout suite. */
export function registerBoundedWidgetSnapshotsTest({
  createHarness,
  widgetResult,
  logWarnMock,
}: {
  createHarness: () => ReturnType<
    typeof import("./server-chat.agent-events.test-harness.js").createAgentEventTestHarness
  >;
  widgetResult: typeof import("./server-chat.agent-events.test-harness.js").widgetResult;
  logWarnMock: ReturnType<typeof vi.fn>;
}) {
  test("keeps live widget snapshots bounded without retaining failed or node-panel results", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.registerNamed("widgets");
    let seq = 0;
    const id = (index: number) => `cv_${index.toString(16).padStart(32, "0")}`;
    const publish = (result: ReturnType<typeof widgetResult>, isError = false) =>
      h.emit(
        "run-widgets",
        "tool",
        {
          phase: "result",
          name: "show_widget",
          result,
          isError,
        },
        { seq: ++seq },
      );
    const publishWidget = async (index: number, titleChars = 1_700) => {
      const result = widgetResult(id(index), "assistant_message", "a".repeat(titleChars));
      // These fixtures survive embedded and default Codex tool-result text caps.
      expect(result.content[0]?.text.length).toBeLessThan(8_000);
      await publish(result);
    };
    const snapshot = async () => {
      await h.emit("run-widgets", "assistant", { text: `Widgets ready: ${seq}.` }, { seq: ++seq });
      vi.advanceTimersByTime(75);
      return h
        .chat()
        .at(-1)?.[1]
        .message.content.filter((block: { type: string }) => block.type === "canvas")
        .map((block: { preview: { viewId: string } }) => block.preview.viewId);
    };
    await publish(widgetResult("failed"), true);
    await publish(widgetResult("node", "node_panel"));
    for (let index = 0; index < 34; index++) {
      await publishWidget(index);
    }
    const initial = Array.from({ length: 32 }, (_, index) => id(index + 2));
    expect(await snapshot()).toEqual(initial);
    await publishWidget(33);
    expect(await snapshot()).toEqual(initial);
    expect(logWarnMock).not.toHaveBeenCalled();

    await publishWidget(34, 7_000);
    const firstEviction = Array.from({ length: 30 }, (_, index) => id(index + 5));
    expect.soft(await snapshot()).toEqual(firstEviction);
    await publishWidget(34, 7_000);
    expect.soft(await snapshot()).toEqual(firstEviction);
    expect.soft(logWarnMock).toHaveBeenCalledTimes(1);
    await publishWidget(35, 7_000);
    await publishWidget(36, 7_000);
    expect.soft(await snapshot()).toEqual(Array.from({ length: 25 }, (_, index) => id(index + 12)));
    expect.soft(logWarnMock).toHaveBeenCalledTimes(3);

    // A descriptor that cannot fit alone must retire the old suffix too.
    await publish(widgetResult(id(37), "assistant_message", "a".repeat(65_536)));
    expect.soft(await snapshot()).toEqual([]);
    await publish(widgetResult(id(38), "assistant_message", "a".repeat(65_536)));
    expect.soft(await snapshot()).toEqual([]);
    await publishWidget(39);
    expect.soft(await snapshot()).toEqual([id(39)]);
    expect
      .soft(logWarnMock.mock.calls)
      .toEqual(
        Array.from({ length: 5 }, () => [
          "Live chat canvas preview omitted: display descriptors exceed the 64 KiB limit.",
        ]),
      );
    await h.emit("run-widgets", "lifecycle", { phase: "end" }, { seq: ++seq });
    expect(h.chat().at(-1)?.[1].message.content).toHaveLength(2);
    await h.handler.dispose();
  });
}
