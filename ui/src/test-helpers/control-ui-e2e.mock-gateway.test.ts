/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { expect, vi } from "vitest";
import { ChannelsPairingListResultSchema } from "../../../packages/gateway-protocol/src/schema/channel-pairing.ts";
import { ChannelsStatusResultSchema } from "../../../packages/gateway-protocol/src/schema/channels.ts";
import { MigrationProtocolSchemas } from "../../../packages/gateway-protocol/src/schema/migrations.ts";
import { SystemAgentChatHistoryResultSchema } from "../../../packages/gateway-protocol/src/schema/openclaw.ts";
import {
  PluginsCatalogBrowseResultSchema,
  PluginsCatalogCategoriesResultSchema,
} from "../../../packages/gateway-protocol/src/schema/plugins.ts";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockRequestHandler,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

const getGateway = (window: MockGatewayWindow) =>
  expectDefined(window.openclawControlUiE2eGateway, "Mock Gateway was not installed");

it("serves protocol-valid empty Custodian history without method advertisement", async ({
  gatewayPage,
}) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript({ featureMethods: ["openclaw.chat"] }));
  const { request } = gatewayPage.connect();
  await flushMockTimers();

  const history = await request("custodian-history", "openclaw.chat.history", {});

  expect(Compile(SystemAgentChatHistoryResultSchema).Check(history)).toBe(true);
  expect(history.turns).toEqual([]);
});

it("serves protocol-valid empty channel status and pairing defaults", async ({ gatewayPage }) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  const { request } = gatewayPage.connect();
  await flushMockTimers();

  const snapshot = await request("channel-status", "channels.status", { probe: false });

  expect(Compile(ChannelsStatusResultSchema).Check(snapshot)).toBe(true);
  expect([snapshot.channels, snapshot.channelAccounts]).toEqual([{}, {}]);

  const pairing = await request("channel-pairing", "channels.pairing.list", {});
  expect(Compile(ChannelsPairingListResultSchema).Check(pairing)).toBe(true);
  expect([pairing.accounts, pairing.requests]).toEqual([[], []]);
});

it("serves protocol-valid empty plugin discovery defaults", async ({ gatewayPage }) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  const { request } = gatewayPage.connect();
  await flushMockTimers();

  const categories = await request("plugin-categories", "plugins.catalog.categories", {});
  expect(Compile(PluginsCatalogCategoriesResultSchema).Check(categories)).toBe(true);
  expect(categories.categories).toEqual([]);

  const catalog = await request("plugin-catalog", "plugins.catalog.browse", {});
  expect(Compile(PluginsCatalogBrowseResultSchema).Check(catalog)).toBe(true);
  expect(catalog.items).toEqual([]);
});

it("serves protocol-valid empty memory plans for the requested agent", async ({ gatewayPage }) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  const { request } = gatewayPage.connect();
  await flushMockTimers();
  const validate = Compile(MigrationProtocolSchemas.MigrationsMemoryPlanResult);

  for (const agentId of ["main", "research"]) {
    const plan = await request(`memory-plan-${agentId}`, "migrations.memory.plan", { agentId });
    expect(validate.Check(plan)).toBe(true);
    expect(plan).toMatchObject({ agentId, providers: [] });
  }
  const fallback = await request("memory-plan-default", "migrations.memory.plan", {});
  expect(validate.Check(fallback)).toBe(true);
  expect(fallback.agentId).toBe("main");
});

it("keeps handler responses and events on the requesting socket", async ({ gatewayPage }) => {
  const { window, execute } = gatewayPage;
  execute(createControlUiMockGatewayInitScript());
  const gateway = getGateway(window);
  const pending: Parameters<ControlUiMockRequestHandler>[0][] = [];
  gateway.setRequestHandler("health", (request) => pending.push(request));
  const sockets = ["first", "second"].map((name) => gatewayPage.connect(`ws://mock/${name}`));
  await flushMockTimers();
  for (const [index, socket] of sockets.entries()) {
    socket.send(String(index), "health", { index });
  }
  await flushMockTimers();
  expect(pending.map((request) => request.params)).toEqual([{ index: 0 }, { index: 1 }]);
  for (const request of pending.toReversed()) {
    request.respond(request.params);
    request.emit("checked", request.params);
  }
  for (const index of [0, 1]) {
    expect(
      sockets[index]?.frames.filter((frame) => frame.event !== "connect.challenge"),
    ).toMatchObject([
      { type: "res", id: String(index), ok: true, payload: { index } },
      { type: "event", event: "checked", payload: { index } },
    ]);
  }
});

it("takes existing mock sockets offline without closing their replacement", async ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  const passthroughPrefix = "ws://source-ui/?token=";
  const script = createControlUiMockGatewayInitScript({
    webSocketPassthroughPrefixes: [passthroughPrefix],
  });
  class PassthroughWebSocket extends window.EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = PassthroughWebSocket.OPEN;

    close(): void {
      this.readyState = PassthroughWebSocket.CLOSED;
    }
  }
  window.WebSocket = PassthroughWebSocket as unknown as typeof WebSocket;

  execute(script);

  const passthrough = new window.WebSocket(`${passthroughPrefix}vite`);
  const first = new window.WebSocket("ws://mock-gateway/first");
  const second = new window.WebSocket("ws://mock-gateway/second");
  await flushMockTimers();
  expect(passthrough.readyState).toBe(window.WebSocket.OPEN);
  expect(first.readyState).toBe(window.WebSocket.OPEN);
  expect(second.readyState).toBe(window.WebSocket.OPEN);

  let replacement: WebSocket | undefined;
  first.addEventListener("close", () => {
    replacement = new window.WebSocket("ws://mock-gateway/replacement");
  });

  const controls = getGateway(window);
  controls.setOnline(false);

  expect(passthrough.readyState).toBe(window.WebSocket.OPEN);
  expect(first.readyState).toBe(window.WebSocket.CLOSED);
  expect(second.readyState).toBe(window.WebSocket.CLOSED);
  expect(replacement?.readyState).toBe(window.WebSocket.CONNECTING);

  controls.setOnline(true);
  expect(replacement?.readyState).toBe(window.WebSocket.OPEN);
});

it.for(["absent", "null", "explicit"] as const)(
  "round-trips config.set through config.get with %s source projections and an advancing hash",
  async (projectionShape, { gatewayPage }) => {
    const { execute } = gatewayPage;
    const raw = '{\n  "logging": {\n    "level": "info"\n  }\n}\n';
    const config = (level: string) => ({ logging: { level } });
    const initialConfig = config("info");
    const runtimeDefaults = { agents: { defaults: { thinkingDefault: "low" } } };
    const projections =
      projectionShape === "explicit"
        ? {
            sourceConfig: initialConfig,
            resolved: initialConfig,
            runtimeConfig: { ...initialConfig, ...runtimeDefaults },
          }
        : projectionShape === "null"
          ? { sourceConfig: null, resolved: null, runtimeConfig: null }
          : {};
    const expectProjections = (snapshot: Record<string, unknown>, source: unknown) => {
      if (projectionShape === "explicit") {
        expect(snapshot.sourceConfig).toEqual(source);
        expect(snapshot.resolved).toEqual(source);
        expect(snapshot.runtimeConfig).toMatchObject(runtimeDefaults);
      } else {
        for (const key of ["sourceConfig", "resolved", "runtimeConfig"]) {
          if (projectionShape === "null") {
            expect(snapshot[key]).toBeNull();
          } else {
            expect(Object.hasOwn(snapshot, key)).toBe(false);
          }
        }
      }
    };
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: initialConfig,
          ...projections,
          hash: "fixture-hash",
          valid: true,
          issues: [],
        },
      },
    });
    execute(script);

    const { request, send, frames } = gatewayPage.connect();
    await flushMockTimers();

    const expectSnapshot = (
      snapshot: Record<string, unknown>,
      level: string,
      expected: Record<string, unknown>,
    ) => {
      expect(snapshot).toMatchObject(expected);
      expect(snapshot.config).toEqual(config(level));
      expectProjections(snapshot, config(level));
    };
    const writeConfig = async (
      method: string,
      sequence: number,
      updatedRaw: string,
      level: string,
      appliedHash: string,
    ) => {
      const hash = `mock-config-hash-${sequence}`;
      const baseHash = sequence === 1 ? "fixture-hash" : `mock-config-hash-${sequence - 1}`;
      expect(await request(`write-${sequence}`, method, { raw: updatedRaw, baseHash })).toEqual({
        ok: true,
        hash,
        config: config(level),
      });
      expectSnapshot(await request(`read-${sequence}`, "config.get", {}), level, {
        raw: updatedRaw,
        hash,
        configRevisionHash: hash,
        appliedConfigHash: appliedHash,
      });
    };
    expectSnapshot(await request("get-1", "config.get", {}), "info", {
      raw,
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-hash",
    });
    const nextRaw = raw.replace("info", "debug");
    // Acks carry the persisted hash, mirroring the real gateway contract.
    await writeConfig("config.set", 1, nextRaw, "debug", "fixture-hash");
    await writeConfig("config.apply", 2, nextRaw, "debug", "mock-config-hash-2");
    const json5Raw = '{\n  // Keep this comment.\n  logging: { level: "warn", },\n}\n';
    await writeConfig("config.set", 3, json5Raw, "warn", "mock-config-hash-2");

    const gateway = getGateway(gatewayPage.window);
    const replacement = config("error");
    gateway.deferNext("config.patch");
    send("pending-replacement", "config.patch", {
      raw: JSON.stringify(replacement),
      baseHash: "mock-config-hash-3",
    });
    await flushMockTimers();
    const persisted = {
      raw: JSON.stringify(replacement),
      config: replacement,
      hash: "replacement-hash",
      appliedConfigHash: "replacement-applied-hash",
      valid: true,
      issues: [],
    };
    gateway.setMethodResponse("config.get", persisted);
    gateway.resolveDeferred("config.patch", { ok: true, hash: "replacement-hash" });
    expect(frames.find((frame) => frame.id === "pending-replacement")).toMatchObject({
      ok: true,
    });
    // Reload before any read can materialize the acknowledged replacement fixture.
    execute(script);
    const reconnected = gatewayPage.connect();
    await flushMockTimers();
    expect(await reconnected.request("get-replaced", "config.get", {})).toMatchObject(persisted);
    expect(
      await reconnected.request("set-after-replacement", "config.set", {
        raw: JSON.stringify(replacement),
        baseHash: "replacement-hash",
      }),
    ).toMatchObject({ ok: true, hash: "mock-config-hash-4" });
  },
);
it("publishes a catalog adoption only after its deferred response succeeds", async ({
  gatewayPage,
}) => {
  const { execute } = gatewayPage;
  const sessionKey = "agent:main:deferred-catalog-adoption";
  const script = createControlUiMockGatewayInitScript({
    deferredMethods: ["sessions.catalog.continue"],
    methodResponses: {
      "sessions.catalog.continue": { sessionKey },
    },
  });
  execute(script);

  const { frames, send, request } = gatewayPage.connect();
  await flushMockTimers();

  send("deferred-adoption", "sessions.catalog.continue", {
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "thread-1",
  });
  await flushMockTimers();
  expect(frames.find((frame) => frame.id === "deferred-adoption")).toBeUndefined();

  const gateway = getGateway(gatewayPage.window);
  gateway.resolveDeferred("sessions.catalog.continue", { sessionKey });
  await flushMockTimers();
  expect(frames.find((frame) => frame.id === "deferred-adoption")?.payload).toEqual({
    sessionKey,
  });

  expect(
    await request("list-after-deferred-adoption", "sessions.list", {
      agentId: "main",
      search: "deferred-catalog-adoption",
    }),
  ).toMatchObject({
    count: 2,
    sessions: [
      expect.objectContaining({ key: "agent:main:main" }),
      expect.objectContaining({ key: sessionKey }),
    ],
  });
});

it("keeps repeated events scoped after unsubscribe and reconnect without filtering roster messages", async ({
  gatewayPage,
}) => {
  vi.useFakeTimers();
  const { execute } = gatewayPage;
  const sessionKey = "agent:main:sidebar-narration-demo";
  const otherKey = "agent:main:other-session";
  try {
    execute(
      createControlUiMockGatewayInitScript({
        repeatingSessionEvents: {
          intervalMs: 250,
          events: [
            {
              event: "agent",
              payload: {
                sessionKey,
                stream: "assistant",
                data: { text: "Working", replace: true },
              },
            },
            {
              event: "session.tool",
              payload: { sessionKey, stream: "tool", data: { name: "exec" } },
            },
            { event: "session.observer", payload: { sessionKey, headline: "Verifying" } },
          ],
        },
      }),
    );
    const gateway = getGateway(gatewayPage.window);
    const { frames, send } = gatewayPage.connect();
    await vi.advanceTimersByTimeAsync(0);
    send("subscribe", "sessions.messages.subscribe", { key: sessionKey });
    await vi.advanceTimersByTimeAsync(750);
    const repeated = () =>
      frames.filter((frame) => frame.type === "event" && frame.event !== "connect.challenge");
    expect(repeated().map((frame) => frame.event)).toEqual([
      "agent",
      "session.tool",
      "session.observer",
      "agent",
    ]);
    expect(repeated().at(-1)?.payload).toMatchObject({
      sessionKey,
      data: { replace: true, text: "Working" },
    });

    send("keep-timer", "sessions.messages.subscribe", { key: otherKey });
    send("unsubscribe", "sessions.messages.unsubscribe", { key: sessionKey });
    await vi.advanceTimersByTimeAsync(0);
    const before = repeated().length;
    await vi.advanceTimersByTimeAsync(750);
    expect(repeated()).toHaveLength(before);
    send("connect-scoped", "connect", { caps: ["session-scoped-events"] });
    await vi.advanceTimersByTimeAsync(0);
    gateway.emit("session.message", { sessionKey, messageId: "roster-message" });
    expect(repeated().at(-1)).toMatchObject({
      event: "session.message",
      payload: { sessionKey, messageId: "roster-message" },
    });

    gateway.closeLatest();
    const replacement = gatewayPage.connect();
    await vi.advanceTimersByTimeAsync(0);
    replacement.send("replace-other", "sessions.messages.subscribe", { key: otherKey });
    await vi.advanceTimersByTimeAsync(750);
    expect(
      replacement.frames.filter((frame) => frame.type === "event").map((frame) => frame.event),
    ).toEqual(["connect.challenge"]);
  } finally {
    gatewayPage.close();
    vi.useRealTimers();
  }
});
