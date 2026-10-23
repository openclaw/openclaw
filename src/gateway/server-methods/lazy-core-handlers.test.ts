import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const unavailable = vi.hoisted(() => () => {
  throw new Error("Optional runtime unavailable");
});
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

// mock-isolation: detect eager sandbox loading without initializing a real sandbox.
vi.mock("../../agents/sandbox/context.js", () => {
  optionalMediaRuntimesLoaded("sandbox-context");
  return {
    resolveSandboxContext: unavailable,
    ensureSandboxWorkspaceForSession: unavailable,
  };
});

// mock-isolation: detect eager media loading without staging files or starting sandbox runtimes.
vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => {
  optionalMediaRuntimesLoaded("stage-sandbox-media");
  return {
    SANDBOX_MEDIA_MAX_BYTES: 50 * 1024 * 1024,
    stageSandboxMedia: unavailable,
  };
});

vi.mock("../../auto-reply/reply/reply-media-paths.js", async (importOriginal) => {
  optionalMediaRuntimesLoaded("reply-media-paths");
  return {
    ...(await importOriginal<typeof import("../../auto-reply/reply/reply-media-paths.js")>()),
    createReplyMediaContext: unavailable,
    createReplyMediaPathNormalizer: unavailable,
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

async function invoke(
  method: string,
  params: Record<string, unknown>,
  options: Partial<GatewayRequestHandlerOptions> = {},
) {
  const { coreGatewayHandlers } = await import("./core-handlers.js");
  const respond = vi.fn();
  await expectDefined(
    coreGatewayHandlers[method],
    `${method} lazy handler`,
  )({
    req: { type: "req", id: "lazy-handler", method },
    params,
    respond,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
    ...options,
  });
  return respond;
}

function expectInvalid(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
}

describe("lazy core handler families", () => {
  it.each([
    { method: "plugins.list", params: { unexpected: true } },
    { method: "plugins.inspect", params: { pluginId: 42 } },
    { method: "plugins.search", params: { query: 42 } },
  ])("validates $method without importing plugin installers", async ({ method, params }) => {
    const respond = await invoke(method, params);

    expectInvalid(respond);
  });

  it.each([
    ["paired client", { enabled: true, phase: "listening" }, false, false, undefined],
    ["webchat with a Talk node", { enabled: false, phase: undefined }, true, true, undefined],
    ["webchat/no node", { enabled: true, phase: undefined }, true, false, "UNAVAILABLE"],
    ["invalid params", { enabled: "yes", phase: undefined }, false, false, "INVALID_REQUEST"],
  ] as const)(
    "handles Talk mode for %s without loading speech synthesis",
    async (_name, params, webchat, connectedTalkNode, errorCode) => {
      const broadcast = vi.fn();
      const respond = await invoke("talk.mode", params, {
        context: {
          broadcast,
          hasConnectedTalkNode: async () => connectedTalkNode,
        } as never,
        client: { connect: {} } as never,
        isWebchatConnect: () => webchat,
      });

      if (errorCode) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: errorCode }),
        );
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        const payload = {
          enabled: params.enabled,
          phase: params.phase ?? null,
          ts: expect.any(Number),
        };
        expect(respond).toHaveBeenCalledWith(true, payload, undefined);
        expect(broadcast).toHaveBeenCalledWith("talk.mode", payload, { dropIfSlow: true });
      }
    },
  );

  it("dispatches cancellation without importing unrelated chat workflows", async () => {
    const respond = await invoke("chat.abort", { sessionKey: 42 });

    expectInvalid(respond);
  });

  it("loads agent identity without importing the agent run stack", async () => {
    const respond = await invoke(
      "agent.identity.get",
      { agentId: "main" },
      { context: { getRuntimeConfig: () => ({}) } as never },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main" }),
      undefined,
    );
    expect(runStackLoaded).not.toHaveBeenCalled();
  });

  it("loads session reads without importing the session create stack", async () => {
    const respond = await invoke("sessions.list", { limit: "invalid" });

    expectInvalid(respond);
    expect(sessionCreateStackLoaded).not.toHaveBeenCalled();
  });

  it("validates chat.send without importing history, media, or title runtimes", async () => {
    const respond = await invoke("chat.send", { sessionKey: 42 });

    expectInvalid(respond);
    expect(optionalMediaRuntimesLoaded).not.toHaveBeenCalled();
    expect(titleRuntimeLoaded).not.toHaveBeenCalled();
  });
});
