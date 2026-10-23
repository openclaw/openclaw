import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { mockPinnedHostnameResolution } from "../../test-helpers/ssrf.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.public.js";

function requestBodyText(body: unknown): string {
  if (typeof body !== "string") {
    throw new Error("expected the request body to be a JSON string");
  }
  return body;
}

const { a2aChannelPlugin } = await loadBundledPluginFacade<{ a2aChannelPlugin: ChannelPlugin }>({
  pluginId: "a2a",
  artifactBasename: "api.js",
});
let fixtureId = 0;

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

function fixture() {
  mockPinnedHostnameResolution();
  const sequence = ++fixtureId;
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "a2a", origin: "bundled" });
  owner.registry.plugins.push(record);
  owner
    .createApi(record, { config: {}, registrationMode: "full" })
    .registerChannel({ plugin: a2aChannelPlugin });
  setActivePluginRegistry(owner.registry);
  let contextId = `fixture-context-${sequence}`;
  let state = "TASK_STATE_WORKING";
  const methods: string[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const rpc = JSON.parse(requestBodyText(init?.body)) as {
      id: string;
      method: string;
      params: { message?: { contextId: string }; id?: string };
    };
    methods.push(rpc.method);
    if (rpc.params.message) {
      contextId = rpc.params.message.contextId;
    }
    const task = {
      id: `host-task-${sequence}`,
      contextId,
      status: { state },
      artifacts:
        state === "TASK_STATE_COMPLETED"
          ? [{ parts: [{ text: `Synthetic answer ${sequence}` }] }]
          : [],
    };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: rpc.method === "SendMessage" ? { task } : task,
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const context: ChannelMessageActionContext = {
    channel: "a2a",
    action: "send",
    params: { to: "peer", message: "Synthetic request" },
    cfg: {
      channels: {
        a2a: {
          enabled: true,
          peers: {
            peer: {
              token: "fixture-inbound",
              outboundToken: "fixture-outbound",
              url: "https://peer.example.test/a2a/v1",
            },
            other: {
              token: "fixture-other-inbound",
              outboundToken: "fixture-outbound",
              url: "https://peer.example.test/a2a/v1",
            },
          },
        },
      },
    },
    accountId: "default",
    requesterAccountId: "telegram-default",
    requesterSenderId: "fixture-human",
    agentId: "main",
    sessionKey: `agent:main:telegram:group:fixture-${sequence}`,
    sessionId: `fixture-session-${sequence}`,
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "telegram", currentChannelId: "fixture-human-chat" },
    assertDirectAdapterHandoff: () => undefined,
  };
  const readContext: ChannelMessageActionContext = {
    ...context,
    action: "read",
    params: { to: "peer", messageId: `host-task-${sequence}` },
  };
  return {
    context,
    readContext,
    record,
    registry: owner.registry,
    fetch,
    methods,
    complete: () => {
      state = "TASK_STATE_COMPLETED";
    },
  };
}

describe("A2A task reads through real host action admission", () => {
  it("allows the originating cross-channel session, not a guessed task ID in another session", async () => {
    const f = fixture();
    await expect(dispatchChannelMessageAction(f.context)).resolves.toMatchObject({
      details: { readAvailable: true },
    });
    await expect(dispatchChannelMessageAction(f.readContext)).resolves.toMatchObject({
      details: { state: "working", terminal: false },
    });
    f.complete();
    await expect(dispatchChannelMessageAction(f.readContext)).resolves.toMatchObject({
      details: {
        state: "completed",
        terminal: true,
        text: expect.stringContaining("Synthetic answer"),
      },
    });
    await expect(
      dispatchChannelMessageAction({
        ...f.readContext,
        sessionKey: "agent:main:other",
        params: {
          ...f.readContext.params,
          sessionKey: f.context.sessionKey,
          sessionId: f.context.sessionId,
          conversationReadOrigin: "direct-operator",
        },
      }),
    ).rejects.toThrow("exact agent/session");
    expect(f.methods).toEqual(["SendMessage", "GetTask", "GetTask"]);
  });

  it.each([
    { sessionKey: "agent:main:telegram:group:other" },
    { sessionId: "another-incarnation" },
    { agentId: "another-agent" },
    { accountId: "another-account" },
    { params: { to: "other" } },
  ])("denies another source or configured peer through host admission: %j", async (overrides) => {
    const f = fixture();
    await dispatchChannelMessageAction(f.context);
    f.fetch.mockClear();
    await expect(
      dispatchChannelMessageAction({
        ...f.readContext,
        ...overrides,
        params: { ...f.readContext.params, ...overrides.params },
      }),
    ).rejects.toThrow(/exact agent\/session|default account/);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refuses a read after the admitting plugin is revoked while provider I/O is pending", async () => {
    const f = fixture();
    await dispatchChannelMessageAction(f.context);
    const started = createDeferred();
    const release = createDeferred();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementationOnce(async (...args) => {
      started.resolve(undefined);
      await release.promise;
      return await original(...args);
    });
    const read = dispatchChannelMessageAction(f.readContext);
    await awaitGateBeforeSettlement(started.promise, read, "read settled before provider I/O");
    revokePluginRecord(f.registry, f.record);
    release.resolve(undefined);
    await expect(read).rejects.toThrow(/authority|revoked|active/);
  });

  it("keeps a timed-out read on the original task without sending another message", async () => {
    const f = fixture();
    await dispatchChannelMessageAction(f.context);
    f.fetch.mockRejectedValueOnce(new DOMException("Synthetic read timeout", "TimeoutError"));
    await expect(dispatchChannelMessageAction(f.readContext)).rejects.toThrow(
      "Synthetic read timeout",
    );
    f.complete();
    await expect(dispatchChannelMessageAction(f.readContext)).resolves.toMatchObject({
      details: {
        state: "completed",
        terminal: true,
        text: expect.stringContaining("Synthetic answer"),
      },
    });
    const requests = f.fetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(requestBodyText(init?.body)) as {
          method: string;
          params: { id?: string };
        },
    );
    expect(requests.map((rpc) => rpc.method)).toEqual(["SendMessage", "GetTask", "GetTask"]);
    expect(requests[1]!.params.id).toBe(requests[2]!.params.id);
  });

  it("rejects an unknown peer or task before any I/O without falling back to send", async () => {
    const f = fixture();
    await dispatchChannelMessageAction(f.context);
    f.fetch.mockClear();
    for (const params of [
      { to: "unknown-peer", messageId: f.readContext.params.messageId },
      { to: "peer", messageId: "unknown-task" },
    ]) {
      await expect(dispatchChannelMessageAction({ ...f.readContext, params })).rejects.toThrow();
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("permits explicit host-attested operator reconciliation without a sender receipt", async () => {
    const f = fixture();
    // The operator's host context, not a params field, supplies this authority.
    await expect(
      dispatchChannelMessageAction({
        ...f.readContext,
        conversationReadOrigin: "direct-operator",
        sessionKey: undefined,
        sessionId: undefined,
      }),
    ).resolves.toMatchObject({ details: { state: "working" } });
    expect(f.methods).toEqual(["GetTask"]);
  });
});
