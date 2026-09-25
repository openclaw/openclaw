import { expect, test, vi } from "vitest";
import { getRuntimeConfig as getCurrentRuntimeConfig } from "../config/io.js";
import type { AgentEventPayload, AgentEventStream } from "../infra/agent-events.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createChatRunState } from "./server-chat-state.js";
import type { ChatRunRegistration, ChatRunState } from "./server-chat-state.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import { agentDiscoveryMock } from "./test-helpers.runtime-state.js";

type AgentEventHandler = (event: AgentEventPayload) => void;

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
  handler({ runId, seq: 1, stream, ts: Date.now(), data, ...overrides });
}

export function emitAgentEvents(
  handler: AgentEventHandler,
  runId: string,
  events: readonly AgentEventCase[],
) {
  events.forEach(([stream, data, overrides], index) =>
    emitAgentEvent(handler, runId, stream, data, { seq: index + 1, ...overrides }),
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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
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
