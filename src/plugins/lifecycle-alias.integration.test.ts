import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createPluginRegistry, type PluginRecord } from "./registry.js";

function createRecord(): PluginRecord {
  return {
    id: "alias-test-plugin",
    name: "Alias Test Plugin",
    source: "/tmp/alias-test-plugin.js",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    configSchema: false,
  };
}

describe("lifecycle alias integration", () => {
  it("fires preRequest on message_received events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();
    api.lifecycle.on("preRequest", handler);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runMessageReceived(
      { from: "u1", content: "hello" },
      { channelId: "telegram", conversationId: "c1" },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ phase: "preRequest" });
  });

  it("fires preResponse on message_sending events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();
    api.lifecycle.on("preResponse", handler);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runMessageSending(
      { to: "u1", content: "hello" },
      { channelId: "telegram", conversationId: "c1" },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ phase: "preResponse" });
  });

  it("fires preRecall on before_recall events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const handler = vi.fn();
    api.lifecycle.on("preRecall", handler);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runBeforeRecall({ query: "pending tasks" }, { sessionKey: "s1" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ phase: "preRecall" });
  });

  it("fires preToolExecution and postToolExecution around tool hook events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const pre = vi.fn();
    const post = vi.fn();
    api.lifecycle.on("preToolExecution", pre);
    api.lifecycle.on("postToolExecution", post);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runBeforeToolCall(
      { toolName: "echo", params: { text: "ok" } },
      { toolName: "echo", sessionKey: "s1" },
    );
    await runner.runAfterToolCall(
      { toolName: "echo", params: { text: "ok" }, result: { ok: true } },
      { toolName: "echo", sessionKey: "s1" },
    );

    expect(pre).toHaveBeenCalledTimes(1);
    expect(pre.mock.calls[0]?.[1]).toMatchObject({ phase: "preToolExecution" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ phase: "postToolExecution" });
  });

  it("fires preCompaction and postCompaction on compaction events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const pre = vi.fn();
    const post = vi.fn();
    api.lifecycle.on("preCompaction", pre);
    api.lifecycle.on("postCompaction", post);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runBeforeCompaction({ messageCount: 10, tokenCount: 1200 }, { sessionKey: "s1" });
    await runner.runAfterCompaction(
      { messageCount: 6, tokenCount: 600, compactedCount: 4 },
      { sessionKey: "s1" },
    );

    expect(pre).toHaveBeenCalledTimes(1);
    expect(pre.mock.calls[0]?.[1]).toMatchObject({ phase: "preCompaction" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ phase: "postCompaction" });
  });

  it("fires postRequest on agent_end and onError on agent_error", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const postRequest = vi.fn();
    const onError = vi.fn();
    api.lifecycle.on("postRequest", postRequest);
    api.lifecycle.on("onError", onError);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runAgentEnd({ messages: [], success: true }, { sessionKey: "s1" });
    await runner.runAgentError(
      { messages: [], success: false, error: "boom" },
      { sessionKey: "s1" },
    );

    expect(postRequest).toHaveBeenCalledTimes(1);
    expect(postRequest.mock.calls[0]?.[1]).toMatchObject({ phase: "postRequest" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ phase: "onError" });
  });
});
