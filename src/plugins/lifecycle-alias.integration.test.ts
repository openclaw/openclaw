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

  it("fires ingress/recall/tool/response error aliases on dedicated runtime events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const postIngress = vi.fn();
    const postRecall = vi.fn();
    const onToolError = vi.fn();
    const onResponseError = vi.fn();
    api.lifecycle.on("postRequestIngress", postIngress);
    api.lifecycle.on("postRecall", postRecall);
    api.lifecycle.on("onToolError", onToolError);
    api.lifecycle.on("onResponseError", onResponseError);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runRequestPost(
      { from: "u1", content: "hello", timestamp: 1710000 },
      { channelId: "telegram", conversationId: "c1" },
    );
    await runner.runAfterRecall(
      { query: "todo", resultCount: 3, durationMs: 12 },
      { sessionKey: "s1" },
    );
    await runner.runToolError(
      { toolName: "exec", params: {}, error: "boom", durationMs: 4 },
      { toolName: "exec", sessionKey: "s1" },
    );
    await runner.runResponseError(
      { to: "u1", content: "reply", error: "send failed" },
      { channelId: "telegram", conversationId: "c1" },
    );

    expect(postIngress).toHaveBeenCalledTimes(1);
    expect(postIngress.mock.calls[0]?.[1]).toMatchObject({ phase: "postRequestIngress" });
    expect(postRecall).toHaveBeenCalledTimes(1);
    expect(postRecall.mock.calls[0]?.[1]).toMatchObject({ phase: "postRecall" });
    expect(onToolError).toHaveBeenCalledTimes(1);
    expect(onToolError.mock.calls[0]?.[1]).toMatchObject({ phase: "onToolError" });
    expect(onResponseError).toHaveBeenCalledTimes(1);
    expect(onResponseError.mock.calls[0]?.[1]).toMatchObject({ phase: "onResponseError" });
  });

  it("fires boot/shutdown aliases on gateway lifecycle events", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const preBoot = vi.fn();
    const postBoot = vi.fn();
    const preShutdown = vi.fn();
    const postShutdown = vi.fn();
    api.lifecycle.on("preBoot", preBoot);
    api.lifecycle.on("postBoot", postBoot);
    api.lifecycle.on("preShutdown", preShutdown);
    api.lifecycle.on("postShutdown", postShutdown);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runGatewayPreStart({ port: 18789 }, { port: 18789 });
    await runner.runGatewayStart({ port: 18789 }, { port: 18789 });
    await runner.runGatewayPreStop({ reason: "test" }, { port: 18789 });
    await runner.runGatewayStop({ reason: "test" }, { port: 18789 });

    expect(preBoot).toHaveBeenCalledTimes(1);
    expect(postBoot).toHaveBeenCalledTimes(1);
    expect(preShutdown).toHaveBeenCalledTimes(1);
    expect(postShutdown).toHaveBeenCalledTimes(1);
  });

  it("fires both alias and canonical handlers when mixed for the same runtime event", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const alias = vi.fn();
    const canonical = vi.fn();
    api.lifecycle.on("preResponse", alias, { priority: 20 });
    api.lifecycle.on("message.pre", canonical, { priority: 10 });

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await runner.runMessageSending(
      { to: "u1", content: "hello" },
      { channelId: "telegram", conversationId: "c1" },
    );

    expect(alias).toHaveBeenCalledTimes(1);
    expect(alias.mock.calls[0]?.[1]).toMatchObject({ phase: "preResponse" });
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(canonical.mock.calls[0]?.[1]).toMatchObject({ phase: "message.pre" });
  });

  it("honors fail-closed when alias+canonical are mixed on one runtime event", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const canonical = vi.fn();
    api.lifecycle.on(
      "preResponse",
      () => {
        throw new Error("blocked");
      },
      { priority: 100, mode: "fail-closed" },
    );
    api.lifecycle.on("message.pre", canonical, { priority: 10 });

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await expect(
      runner.runMessageSending(
        { to: "u1", content: "hello" },
        { channelId: "telegram", conversationId: "c1" },
      ),
    ).rejects.toThrow(/blocked/);
    expect(canonical).not.toHaveBeenCalled();
  });

  it("runs void hooks in parallel even when one mixed registration is fail-closed", async () => {
    const { registry, createApi } = createPluginRegistry({
      runtime: {} as never,
      coreGatewayHandlers: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const api = createApi(createRecord(), { config: {} as never });
    const canonical = vi.fn(async () => {});
    api.lifecycle.on(
      "preBoot",
      async () => {
        throw new Error("boot blocked");
      },
      { mode: "fail-closed" },
    );
    api.lifecycle.on("boot.pre", canonical);

    const runner = createHookRunner(registry, { logger: { warn: vi.fn(), error: vi.fn() } });
    await expect(runner.runGatewayPreStart({ port: 18789 }, { port: 18789 })).rejects.toThrow(
      /boot blocked/,
    );
    expect(canonical).toHaveBeenCalledTimes(1);
  });
});
