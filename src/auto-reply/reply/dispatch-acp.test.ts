import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
}));

const gatewayRuntimeMocks = vi.hoisted(() => ({
  ensureSession: vi.fn(async () => ({})),
  recordRunDeliveryTarget: vi.fn(async () => ({})),
  getRun: vi.fn(async () => null),
}));

const projectionServiceMocks = vi.hoisted(() => ({
  ensureProjection: vi.fn<
    (
      params?: unknown,
      serviceParams?: {
        store: unknown;
        coordinatorFactory: (params: { target: unknown; restartMode: boolean }) => unknown;
      },
    ) => Promise<void>
  >(async () => undefined),
  instances: [] as Array<{
    store: unknown;
    coordinatorFactory: (params: { target: unknown; restartMode: boolean }) => unknown;
  }>,
}));

const zodMocks = vi.hoisted(() => {
  const createSchema = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "parse") {
            return (value: unknown) => value;
          }
          if (prop === "safeParse") {
            return (value: unknown) => ({ success: true, data: value });
          }
          if (prop === "spa") {
            return async (value: unknown) => ({ success: true, data: value });
          }
          return (..._args: unknown[]) => createSchema();
        },
      },
    );
  const z = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "coerce") {
          return new Proxy(
            {},
            {
              get:
                () =>
                (..._args: unknown[]) =>
                  createSchema(),
            },
          );
        }
        if (prop === "ZodIssueCode") {
          return {};
        }
        return (..._args: unknown[]) => createSchema();
      },
    },
  );
  return { z };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => managerMocks,
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: (sessionKey: string) => bindingServiceMocks.listBySession(sessionKey),
  }),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("zod", () => zodMocks);

vi.mock("../../acp/store/gateway-events.js", () => ({
  getAcpGatewayNodeRuntime: () => ({
    store: {
      ensureSession: gatewayRuntimeMocks.ensureSession,
      recordRunDeliveryTarget: gatewayRuntimeMocks.recordRunDeliveryTarget,
      getRun: gatewayRuntimeMocks.getRun,
    },
  }),
}));

vi.mock("./dispatch-acp-replay.js", () => ({
  AcpDurableProjectionService: class {
    constructor(params: {
      store: unknown;
      coordinatorFactory: (params: { target: unknown; restartMode: boolean }) => unknown;
    }) {
      projectionServiceMocks.instances.push(params);
    }

    ensureProjection = async (params: unknown) =>
      await projectionServiceMocks.ensureProjection(
        params,
        projectionServiceMocks.instances.at(-1),
      );
  },
}));

const { tryDispatchAcpReply } = await import("./dispatch-acp.js");
const sessionKey = "agent:codex-acp:session-1";

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const dispatcher: ReplyDispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    markComplete: vi.fn(),
  };
  return { dispatcher, counts };
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: createAcpSessionMeta(),
  });
}

function createAcpConfigWithVisibleToolTags(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

async function runDispatch(params: {
  bodyForAgent: string;
  cfg?: OpenClawConfig;
  dispatcher?: ReplyDispatcher;
  shouldRouteToOriginating?: boolean;
  onReplyStart?: () => void;
  ctxOverrides?: Record<string, unknown>;
}) {
  return tryDispatchAcpReply({
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: sessionKey,
      BodyForAgent: params.bodyForAgent,
      ...params.ctxOverrides,
    }),
    cfg: params.cfg ?? createAcpTestConfig(),
    dispatcher: params.dispatcher ?? createDispatcher().dispatcher,
    sessionKey,
    inboundAudio: false,
    shouldRouteToOriginating: params.shouldRouteToOriginating ?? false,
    ...(params.shouldRouteToOriginating
      ? { originatingChannel: "telegram", originatingTo: "telegram:thread-1" }
      : {}),
    shouldSendToolSummaries: true,
    bypassForCommand: false,
    ...(params.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    recordProcessed: vi.fn(),
    markIdle: vi.fn(),
  });
}

async function emitToolLifecycleEvents(
  onEvent: (event: unknown) => Promise<void>,
  toolCallId: string,
) {
  await onEvent({
    type: "tool_call",
    tag: "tool_call",
    toolCallId,
    status: "in_progress",
    title: "Run command",
    text: "Run command (in_progress)",
  });
  await onEvent({
    type: "tool_call",
    tag: "tool_call_update",
    toolCallId,
    status: "completed",
    title: "Run command",
    text: "Run command (completed)",
  });
  await onEvent({ type: "done" });
}

function mockToolLifecycleTurn(toolCallId: string) {
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await emitToolLifecycleEvents(onEvent, toolCallId);
    },
  );
}

function mockVisibleTextTurn(text = "visible") {
  managerMocks.runTurn.mockImplementationOnce(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

async function dispatchVisibleTurn(onReplyStart: () => void) {
  await runDispatch({
    bodyForAgent: "visible",
    dispatcher: createDispatcher().dispatcher,
    onReplyStart,
  });
}

describe("tryDispatchAcpReply", () => {
  beforeEach(() => {
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.getObservabilitySnapshot.mockReset();
    managerMocks.getObservabilitySnapshot.mockReturnValue({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 0 },
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReset();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
    policyMocks.resolveAcpAgentPolicyError.mockReset();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
    gatewayRuntimeMocks.ensureSession.mockReset();
    gatewayRuntimeMocks.ensureSession.mockResolvedValue({});
    gatewayRuntimeMocks.recordRunDeliveryTarget.mockReset();
    gatewayRuntimeMocks.recordRunDeliveryTarget.mockResolvedValue({});
    gatewayRuntimeMocks.getRun.mockReset();
    gatewayRuntimeMocks.getRun.mockResolvedValue(null);
    projectionServiceMocks.ensureProjection.mockReset();
    projectionServiceMocks.ensureProjection.mockResolvedValue(undefined);
    projectionServiceMocks.instances.length = 0;
  });

  it("routes ACP block output to originating channel", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "hello", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(result?.counts.block).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
      }),
    );
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("edits ACP tool lifecycle updates in place when supported", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-1");
    routeMocks.routeReply.mockResolvedValueOnce({ ok: true, messageId: "tool-msg-1" });

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(messageActionMocks.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "edit",
        params: expect.objectContaining({
          messageId: "tool-msg-1",
        }),
      }),
    );
  });

  it("falls back to new tool message when edit fails", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-2");
    routeMocks.routeReply
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2" })
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2-fallback" });
    messageActionMocks.runMessageAction.mockRejectedValueOnce(new Error("edit unsupported"));

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(messageActionMocks.runMessageAction).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle when ACP turn starts, including hidden-only turns", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "status",
          tag: "usage_update",
          text: "usage updated: 1/100",
          used: 1,
          size: 100,
        });
        await onEvent({ type: "done" });
      },
    );
    await runDispatch({
      bodyForAgent: "hidden",
      dispatcher,
      onReplyStart,
    });
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);
    expect(onReplyStart).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle once per turn when output is delivered", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("persists a run-scoped delivery target and starts durable projection for acp-node turns", async () => {
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: createAcpSessionMeta({
        backend: "acp-node",
      }),
    });
    managerMocks.runTurn.mockResolvedValue(undefined);

    await runDispatch({
      bodyForAgent: "reply from durable path",
      shouldRouteToOriginating: true,
      ctxOverrides: {
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:thread-1",
      },
    });

    expect(gatewayRuntimeMocks.ensureSession).toHaveBeenCalledWith({
      sessionKey,
    });
    expect(gatewayRuntimeMocks.recordRunDeliveryTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        runId: expect.any(String),
        channel: "telegram",
        to: "telegram:thread-1",
        routeMode: "originating",
      }),
    );
    expect(projectionServiceMocks.ensureProjection).toHaveBeenCalledTimes(1);
    expect(projectionServiceMocks.ensureProjection.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        cfg: expect.any(Object),
        target: expect.objectContaining({
          runId: expect.any(String),
          channel: "telegram",
          to: "telegram:thread-1",
        }),
        restartMode: false,
        waitForRunStart: true,
      }),
    );
    expect(managerMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
      }),
    );
    expect(managerMocks.runTurn.mock.calls[0]?.[0]).not.toHaveProperty("onEvent");
  });

  it("shares live durable delivery state so routed counts and final TTS propagate through the dispatch result", async () => {
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: createAcpSessionMeta({
        backend: "acp-node",
      }),
    });
    managerMocks.runTurn.mockResolvedValue(undefined);
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as { kind: string; payload: { text?: string } };
      if (params.kind === "final" && params.payload.text === "durable streamed block") {
        return {
          mediaUrl: "https://example.com/final-tts.mp3",
          audioAsVoice: true,
        };
      }
      return params.payload;
    });
    projectionServiceMocks.ensureProjection.mockImplementation(async (...args: unknown[]) => {
      const params = args[0] as { target: unknown };
      const serviceParams = args[1] as
        | {
            coordinatorFactory: (params: { target: unknown; restartMode: boolean }) => unknown;
          }
        | undefined;
      const coordinator = serviceParams?.coordinatorFactory({
        target: params.target,
        restartMode: false,
      }) as {
        deliver: (
          kind: "tool" | "block" | "final",
          payload: { text?: string; mediaUrl?: string; audioAsVoice?: boolean },
          meta?: { toolCallId?: string; allowEdit?: boolean },
        ) => Promise<boolean>;
      };
      await coordinator.deliver(
        "tool",
        { text: "tool update" },
        { toolCallId: "tool-1", allowEdit: false },
      );
      await coordinator.deliver("block", { text: "durable streamed block" });
    });

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply from durable path",
      dispatcher,
      shouldRouteToOriginating: true,
      ctxOverrides: {
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:thread-1",
      },
    });

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: {
        tool: 1,
        block: 1,
        final: 1,
      },
    });
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(3);
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
        payload: expect.objectContaining({ text: "tool update" }),
      }),
    );
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
        payload: expect.objectContaining({ text: "durable streamed block" }),
      }),
    );
    expect(routeMocks.routeReply).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:thread-1",
        payload: expect.objectContaining({
          mediaUrl: "https://example.com/final-tts.mp3",
          audioAsVoice: true,
        }),
      }),
    );
  });

  it("uses confirmed session-route delivery for live durable projection instead of the queued dispatcher lane", async () => {
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: createAcpSessionMeta({
        backend: "acp-node",
      }),
    });
    managerMocks.runTurn.mockResolvedValue(undefined);
    projectionServiceMocks.ensureProjection.mockImplementation(async (...args: unknown[]) => {
      const params = args[0] as { target: unknown };
      const serviceParams = args[1] as
        | {
            coordinatorFactory: (params: { target: unknown; restartMode: boolean }) => unknown;
          }
        | undefined;
      const coordinator = serviceParams?.coordinatorFactory({
        target: params.target,
        restartMode: false,
      }) as {
        deliver: (kind: "tool" | "block" | "final", payload: { text?: string }) => Promise<boolean>;
      };
      await coordinator.deliver("block", { text: "session route block" });
    });

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply from session route durable path",
      dispatcher,
      shouldRouteToOriginating: false,
      ctxOverrides: {
        To: "discord:session-thread",
      },
    });

    expect(result).toMatchObject({
      counts: {
        block: 1,
      },
    });
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "discord:session-thread",
        payload: expect.objectContaining({ text: "session route block" }),
      }),
    );
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("does not start reply lifecycle for empty ACP prompt", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "   ",
      dispatcher,
      onReplyStart,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("forwards normalized image attachments into ACP turns", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "inbound.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: imagePath,
          MediaType: "image/png",
        },
      });

      expect(managerMocks.runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          attachments: [
            {
              mediaType: "image/png",
              data: Buffer.from("image-bytes").toString("base64"),
            },
          ],
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips ACP turns for non-image attachments when there is no text prompt", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const docPath = path.join(tempDir, "inbound.pdf");
    const { dispatcher } = createDispatcher();
    const onReplyStart = vi.fn();
    try {
      await fs.writeFile(docPath, "pdf-bytes");

      await runDispatch({
        bodyForAgent: "   ",
        dispatcher,
        onReplyStart,
        ctxOverrides: {
          MediaPath: docPath,
          MediaType: "application/pdf",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
      expect(onReplyStart).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces ACP policy errors as final error replies", async () => {
    setReadyAcpResolution();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy."),
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ACP_DISPATCH_DISABLED"),
      }),
    );
  });
});
