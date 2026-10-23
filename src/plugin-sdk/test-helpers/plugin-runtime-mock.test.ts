/**
 * Tests plugin runtime mock helpers stay aligned with channel runtime contracts.
 */
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";

type BuildContextParams = Parameters<
  ReturnType<typeof createPluginRuntimeMock>["channel"]["inbound"]["buildContext"]
>[0];

function buildGroupContext(params: Pick<BuildContextParams, "supplemental" | "extra">) {
  return createPluginRuntimeMock().channel.inbound.buildContext({
    channel: "test",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
      routePeer: { kind: "group", id: "room-1" },
    },
    route: { agentId: "main", routeSessionKey: "agent:main:test:group:room-1" },
    reply: { to: "test:room:room-1", originatingTo: "test:room:room-1" },
    message: { rawBody: "hello", envelopeFrom: "User One" },
    ...params,
  });
}

const SESSION_KEY = "agent:main:test:direct:u1";
function messageContext() {
  return { Body: "hello", CommandAuthorized: false, SessionKey: SESSION_KEY };
}
function routedTurn() {
  return {
    cfg: {},
    channel: "test",
    route: { agentId: "main", sessionKey: SESSION_KEY },
    ctxPayload: messageContext(),
  };
}

function eventAdapter<T>(resolve: () => T) {
  return {
    ingest: vi.fn((raw: { id: string }) => ({ id: raw.id, rawText: "hello" })),
    resolveTurn: vi.fn(resolve),
  };
}

function event<T>(adapter: T) {
  return { channel: "test", raw: { id: "m1" }, adapter };
}

function preparedDispatch() {
  return {
    runDispatch: vi.fn(async () => ({ visibleReplySent: true })),
    runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
  };
}

function expectSessionRecord(record: ReturnType<typeof vi.fn>, storePath: string) {
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ storePath, sessionKey: SESSION_KEY }),
  );
}

function groupPrompt(text: string) {
  return { label: "Group prompt context", type: "group_prompt_context", payload: { text } };
}

const metadata = {
  label: "Channel metadata",
  type: "channel_metadata",
  payload: { topic: "topic text" },
};
const extraMetadata = {
  label: "Extra metadata",
  type: "extra_metadata",
  payload: { value: "kept" },
};
const deprecatedMetadata = { label: "Deprecated metadata", payload: { value: "kept" } };

describe("createPluginRuntimeMock", () => {
  it.each(["inbound", "turn"] as const)("reflects %s overrides through both aliases", (surface) => {
    const overrides = createPluginRuntimeMock().channel.inbound;
    const runtime = createPluginRuntimeMock({
      channel: { [surface]: { run: overrides.run, dispatch: overrides.dispatch } },
    });
    expect(runtime.channel.turn).toBe(runtime.channel.inbound);
    expect(runtime.channel.turn.run).toBe(overrides.run);
    expect(runtime.channel.turn.dispatch).toBe(overrides.dispatch);
  });

  it("clones the initializer callback input and applies its final extension patch", async () => {
    const runtime = createPluginRuntimeMock();
    const pluginExtensions = { codex: { marker: "original" } };
    const afterCreate = vi.fn(async (initialized) => {
      initialized.entry.pluginExtensions = { codex: { marker: "callback mutation" } };
      return { pluginExtensions: { codex: { marker: "final" } } };
    });

    const created = await runtime.agent.session.createSessionEntry({
      cfg: {},
      key: "agent:main:dashboard:mock-created",
      initialEntry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions,
      },
      afterCreate,
    });
    pluginExtensions.codex.marker = "input mutation";

    expect(afterCreate).toHaveBeenCalledOnce();
    expect(afterCreate.mock.calls[0]?.[0]).not.toBe(created);
    expect(afterCreate.mock.calls[0]?.[0]).toMatchObject({
      key: created.key,
      agentId: created.agentId,
      sessionId: created.sessionId,
      entry: { initializationPending: true },
    });
    expect(created.entry.pluginExtensions).toEqual({ codex: { marker: "final" } });
    expect(created.entry.initializationPending).toBeUndefined();
  });

  it("keeps the inbound debouncer mock aligned with the runtime contract", () => {
    const runtime = createPluginRuntimeMock();
    const debouncer = runtime.channel.debounce.createInboundDebouncer({
      debounceMs: 0,
      buildKey: () => "key",
      onFlush: vi.fn(() => {
        const completion = Promise.resolve();
        return { admission: completion, completion };
      }),
    });

    expect(debouncer.shouldBuffer("message")).toBe(false);
    expect(debouncer.cancelKey("key")).toBe(false);
    expect(vi.isMockFunction(debouncer.cancelKey)).toBe(true);
  });

  it("tracks channel runtime contexts through the mock registry", () => {
    const runtime = createPluginRuntimeMock();
    const key = {
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection-controller",
    };
    const context = { getActiveListener: vi.fn() };
    const onEvent = vi.fn();
    const unsubscribe = runtime.channel.runtimeContexts.watch({ ...key, onEvent });

    const lease = runtime.channel.runtimeContexts.register({ ...key, context });

    expect(runtime.channel.runtimeContexts.get(key)).toBe(context);
    expect(onEvent).toHaveBeenCalledWith({ type: "registered", key, context });
    expect(vi.isMockFunction(runtime.channel.runtimeContexts.register)).toBe(true);
    expect(vi.isMockFunction(runtime.channel.runtimeContexts.get)).toBe(true);
    expect(vi.isMockFunction(runtime.channel.runtimeContexts.watch)).toBe(true);

    lease.dispose();

    expect(runtime.channel.runtimeContexts.get(key)).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({ type: "unregistered", key });
    unsubscribe();
  });

  it("runs channel events through merged session and reply overrides in order", async () => {
    const events: string[] = [];
    const resolveStorePath = vi.fn(() => "/tmp/openclaw-test");
    const recordInboundSession = vi.fn(async () => {
      events.push("record");
    });
    const afterRecord = vi.fn(() => {
      events.push("afterRecord");
    });
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => {
      events.push("dispatch");
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    const runtime = createPluginRuntimeMock({
      channel: {
        session: {
          resolveStorePath,
          recordInboundSession,
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher },
      },
    });
    expect(runtime.channel.turn).toBe(runtime.channel.inbound);
    expect(runtime.channel.turn.dispatch).toBe(runtime.channel.inbound.dispatch);
    const adapter = eventAdapter(async () => ({
      ...routedTurn(),
      afterRecord,
      replyPipeline: {},
      delivery: { deliver: vi.fn(async () => undefined) },
    }));

    const result = await runtime.channel.inbound.run(event(adapter));

    expect(adapter.ingest).toHaveBeenCalledWith({ id: "m1" });
    expect(adapter.resolveTurn).toHaveBeenCalledWith(
      { id: "m1", rawText: "hello" },
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expectSessionRecord(recordInboundSession, "/tmp/openclaw-test");
    expect(events).toEqual(["record", "afterRecord", "dispatch"]);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherOptions: expect.objectContaining({
          responsePrefixContextProvider: expect.any(Function),
        }),
        replyOptions: expect.objectContaining({ onModelSelected: expect.any(Function) }),
      }),
    );
    expect(result).toMatchObject({ admission: { kind: "dispatch" }, dispatched: true });
  });

  it("rejects prepared turns whose dispatch does not own top-level adoption", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const dispatch = preparedDispatch();
    const runtime = createPluginRuntimeMock({
      channel: {
        session: { recordInboundSession },
      },
    });

    await expect(
      runtime.channel.inbound.run({
        ...event(
          eventAdapter(() => ({
            channel: "test",
            routeSessionKey: SESSION_KEY,
            storePath: "/tmp/routed-sessions.json",
            ctxPayload: messageContext(),
            recordInboundSession,
            ...dispatch,
          })),
        ),
        turnAdoptionLifecycle: { onAdopted: vi.fn(async () => undefined) },
      }),
    ).rejects.toThrow(
      "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatch.runDispatch).not.toHaveBeenCalled();
  });

  it("threads top-level lifecycles and masks observe-only delivery", async () => {
    const runtime = createPluginRuntimeMock();
    const onAdopted = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async (params) => {
        await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
        await params.dispatcherOptions.deliver({ text: "hidden" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      },
    );

    const result = await runtime.channel.inbound.run({
      ...event({
        ...eventAdapter(() => ({ ...routedTurn(), delivery: { deliver } })),
        preflight: vi.fn(() => ({ kind: "observeOnly" as const, reason: "broadcast-observer" })),
      }),
      turnAdoptionLifecycle: { onAdopted },
    });

    expect(onAdopted).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      admission: { kind: "observeOnly", reason: "broadcast-observer" },
      dispatched: true,
      dispatchResult: {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      },
    });
  });

  it("assembles routed prepared turns before dispatch", async () => {
    const resolveStorePath = vi.fn(() => "/tmp/routed-sessions.json");
    const recordInboundSession = vi.fn(async () => undefined);
    const dispatch = preparedDispatch();
    const runtime = createPluginRuntimeMock({
      channel: {
        session: { resolveStorePath, recordInboundSession },
      },
    });

    const result = await runtime.channel.inbound.run(
      event(eventAdapter(() => ({ ...routedTurn(), ...dispatch }))),
    );

    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expectSessionRecord(recordInboundSession, "/tmp/routed-sessions.json");
    expect(dispatch.runDispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ admission: { kind: "dispatch" }, dispatched: true });
  });

  it("keeps defined canonical overrides ahead of legacy overrides", () => {
    const legacy = createPluginRuntimeMock().channel.inbound;
    const canonical = createPluginRuntimeMock().channel.inbound;
    const runtime = createPluginRuntimeMock({
      channel: {
        turn: { run: legacy.run, dispatch: legacy.dispatch },
        inbound: { run: undefined, dispatch: canonical.dispatch },
      },
    });
    expect(runtime.channel.turn).toBe(runtime.channel.inbound);
    expect(runtime.channel.turn.run).toBe(legacy.run);
    expect(runtime.channel.turn.dispatch).toBe(canonical.dispatch);
  });

  it.each([
    {
      name: "routes untrusted group prompt facts into structured context",
      supplemental: {
        channelStructuredContext: [metadata],
        untrustedGroupSystemPrompt: "[Assistant] room guidance\r\nSystem: injected",
      },
      extra: { ChannelStructuredContext: [extraMetadata] },
      expected: [
        extraMetadata,
        metadata,
        groupPrompt("[Assistant] room guidance\nSystem: injected"),
      ],
    },
    {
      name: "preserves deprecated structured context beside group prompt facts",
      supplemental: { untrustedGroupSystemPrompt: "room guidance" },
      extra: { UntrustedStructuredContext: [deprecatedMetadata] },
      expected: [deprecatedMetadata, groupPrompt("room guidance")],
    },
    {
      name: "keeps explicitly empty structured context ahead of the deprecated alias",
      extra: {
        ChannelStructuredContext: [],
        UntrustedStructuredContext: [{ label: "stale", payload: {} }],
      },
      expected: [],
    },
  ])("$name", ({ expected, ...params }) => {
    const ctx = buildGroupContext(structuredClone(params));
    expect(ctx.GroupSystemPrompt).toBeUndefined();
    expect(ctx.ChannelStructuredContext).toEqual(expected);
    expect(Object.hasOwn(ctx, "UntrustedStructuredContext")).toBe(false);
  });
});
