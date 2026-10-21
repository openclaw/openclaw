import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// mock-isolation: Record even caught import failures; lightweight requests cannot load these.
const forbiddenLoad = vi.hoisted(() =>
  vi.fn((module: string): never => {
    throw new Error(`Optional runtime unavailable: ${module}`);
  }),
);
vi.mock("./agent-run-handler.js", () => forbiddenLoad("agent-run"));
vi.mock("../session-create-service.js", () => forbiddenLoad("session-create"));
vi.mock("./chat.js", () => forbiddenLoad("chat-history"));
vi.mock("../../agents/sandbox/context.js", () => forbiddenLoad("sandbox-context"));
vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => forbiddenLoad("sandbox-media"));
vi.mock("../../auto-reply/reply/reply-media-paths.js", () => forbiddenLoad("reply-media"));
vi.mock("../../auto-reply/reply/conversation-label-generator.js", () => forbiddenLoad("labels"));
vi.mock("../../tts/tts-synthesis.js", () => forbiddenLoad("speech"));
vi.mock("../../plugins/install.js", () => forbiddenLoad("plugin-install"));
beforeEach(() => forbiddenLoad.mockClear());
afterEach(() => expect(forbiddenLoad).not.toHaveBeenCalled());

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
  expectRpcError(respond, { code: "INVALID_REQUEST" });
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
        expectRpcError(respond, { code: errorCode });
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        const payload = {
          enabled: params.enabled,
          phase: params.phase ?? null,
          ts: expect.any(Number),
        };
        expectRpcResult(respond, payload);
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

    expectRpcResult(respond, expect.objectContaining({ agentId: "main" }));
  });

  it("loads session reads without importing the session create stack", async () => {
    const respond = await invoke("sessions.list", { limit: "invalid" });

    expectInvalid(respond);
  });

  it("validates chat.send without importing history, media, or title runtimes", async () => {
    const respond = await invoke("chat.send", { sessionKey: 42 });

    expectInvalid(respond);
  });
});
