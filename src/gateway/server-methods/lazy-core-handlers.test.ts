import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";

const runStackLoaded = vi.hoisted(() => vi.fn());
const sessionCreateStackLoaded = vi.hoisted(() => vi.fn());
const optionalMediaRuntimesLoaded = vi.hoisted(() => vi.fn());
const titleRuntimeLoaded = vi.hoisted(() => vi.fn());

vi.mock("./agent-run-handler.js", () => {
  runStackLoaded();
  return { agentRunHandler: vi.fn() };
});

vi.mock("../session-create-service.js", () => {
  sessionCreateStackLoaded();
  return {};
});

vi.mock("./chat.js", () => {
  throw new Error("Chat history handlers are unavailable");
});

vi.mock("../../agents/sandbox/context.js", () => {
  optionalMediaRuntimesLoaded("sandbox-context");
  return {
    resolveSandboxContext: () => {
      throw new Error("Sandbox context is unavailable");
    },
    ensureSandboxWorkspaceForSession: () => {
      throw new Error("Sandbox workspace runtime is unavailable");
    },
  };
});

vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => {
  optionalMediaRuntimesLoaded("stage-sandbox-media");
  return {
    SANDBOX_MEDIA_MAX_BYTES: 50 * 1024 * 1024,
    stageSandboxMedia: () => {
      throw new Error("Sandbox media staging is unavailable");
    },
  };
});

vi.mock("../../auto-reply/reply/reply-media-paths.runtime.js", () => {
  optionalMediaRuntimesLoaded("reply-media-paths");
  return {
    createReplyMediaContext: () => {
      throw new Error("Reply media context is unavailable");
    },
    createReplyMediaPathNormalizer: () => {
      throw new Error("Reply media normalization is unavailable");
    },
  };
});

vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => {
  titleRuntimeLoaded();
  return {
    generateConversationLabel: vi.fn(async () => null),
    generateConversationLabelWithFallback: vi.fn(async () => null),
  };
});

vi.mock("../../tts/tts-synthesis.js", () => {
  throw new Error("Speech synthesis is unavailable");
});

vi.mock("../../plugins/install.js", () => {
  throw new Error("Plugin inventory must not load source installers");
});

describe("lazy core handler families", () => {
  it.each([
    { method: "plugins.list", params: { unexpected: true } },
    { method: "plugins.inspect", params: { pluginId: 42 } },
    { method: "plugins.search", params: { query: 42 } },
  ])("validates $method without importing plugin installers", async ({ method, params }) => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers[method],
      "plugin metadata lazy handler",
    )({
      req: { type: "req", id: "plugin-metadata-family", method },
      params,
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each([
    {
      name: "paired client",
      params: { enabled: true, phase: "listening" },
      webchat: false,
      connectedTalkNode: false,
      errorCode: undefined,
    },
    {
      name: "webchat with a Talk node",
      params: { enabled: false },
      webchat: true,
      connectedTalkNode: true,
      errorCode: undefined,
    },
    {
      name: "webchat without a Talk node",
      params: { enabled: true },
      webchat: true,
      connectedTalkNode: false,
      errorCode: "UNAVAILABLE",
    },
    {
      name: "invalid mode parameters",
      params: { enabled: "yes" },
      webchat: false,
      connectedTalkNode: false,
      errorCode: "INVALID_REQUEST",
    },
  ])("handles Talk mode for $name without loading speech synthesis", async (testCase) => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    const broadcast = vi.fn();
    await expectDefined(
      coreGatewayHandlers["talk.mode"],
      "talk.mode lazy handler",
    )({
      req: { type: "req", id: "talk-mode-light-family", method: "talk.mode" },
      params: testCase.params,
      respond,
      context: {
        broadcast,
        hasConnectedTalkNode: async () => testCase.connectedTalkNode,
      } as never,
      client: { connect: {} } as never,
      isWebchatConnect: () => testCase.webchat,
    });

    if (testCase.errorCode) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: testCase.errorCode }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    } else {
      const payload = {
        enabled: testCase.params.enabled,
        phase: testCase.params.phase ?? null,
        ts: expect.any(Number),
      };
      expect(respond).toHaveBeenCalledWith(true, payload, undefined);
      expect(broadcast).toHaveBeenCalledWith("talk.mode", payload, { dropIfSlow: true });
    }
  });

  it("dispatches cancellation without importing unrelated chat workflows", async () => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["chat.abort"],
      "chat.abort lazy handler",
    )({
      req: { type: "req", id: "abort-light-family", method: "chat.abort" },
      params: { sessionKey: 42 },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("loads agent identity without importing the agent run stack", async () => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["agent.identity.get"],
      "agent.identity.get lazy handler",
    )({
      req: { type: "req", id: "identity-light-family", method: "agent.identity.get" },
      params: { agentId: "main" },
      respond,
      context: { getRuntimeConfig: () => ({}) } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main" }),
      undefined,
    );
    expect(runStackLoaded).not.toHaveBeenCalled();
  });

  it("loads session reads without importing the session create stack", async () => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["sessions.list"],
      "sessions.list lazy handler",
    )({
      req: { type: "req", id: "sessions-read-family", method: "sessions.list" },
      params: { limit: "invalid" },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(sessionCreateStackLoaded).not.toHaveBeenCalled();
  });

  it("validates chat.send without importing history, media, or title runtimes", async () => {
    const { coreGatewayHandlers } = await import("./core-handlers.js");
    const respond = vi.fn();
    await expectDefined(
      coreGatewayHandlers["chat.send"],
      "chat.send lazy handler",
    )({
      req: { type: "req", id: "send-light-family", method: "chat.send" },
      params: { sessionKey: 42 },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(optionalMediaRuntimesLoaded).not.toHaveBeenCalled();
    expect(titleRuntimeLoaded).not.toHaveBeenCalled();
  });
});
