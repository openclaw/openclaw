/* @vitest-environment jsdom */
// Exercises the serialized mock gateway exactly as a page would: the init
// script installs MockWebSocket on window, and requests flow over it.
import { Compile } from "typebox/compile";
import { describe, expect, vi } from "vitest";
import { ChannelsPairingListResultSchema } from "../../../packages/gateway-protocol/src/schema/channel-pairing.ts";
import { ChannelsStatusResultSchema } from "../../../packages/gateway-protocol/src/schema/channels.ts";
import {
  PluginsCatalogBrowseResultSchema,
  PluginsCatalogCategoriesResultSchema,
} from "../../../packages/gateway-protocol/src/schema/plugins.ts";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
  type ControlUiMockRequestHandler,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

type ResponseFrame = {
  event?: string;
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

it("serves protocol-valid empty channel status and pairing defaults", async ({ gatewayPage }) => {
  gatewayPage.execute(createControlUiMockGatewayInitScript());
  const { request } = gatewayPage.connect();
  await flushMockTimers();

  const snapshot = await request("channel-status", "channels.status", { probe: false });

  expect(Compile(ChannelsStatusResultSchema).Check(snapshot)).toBe(true);
  expect(snapshot.channels).toEqual({});
  expect(snapshot.channelAccounts).toEqual({});

  const pairing = await request("channel-pairing", "channels.pairing.list", {});
  expect(Compile(ChannelsPairingListResultSchema).Check(pairing)).toBe(true);
  expect(pairing.accounts).toEqual([]);
  expect(pairing.requests).toEqual([]);
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

it("keeps handler responses and events on the requesting socket", async ({ gatewayPage }) => {
  const { window, execute } = gatewayPage;
  execute(createControlUiMockGatewayInitScript());
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  const pending: Parameters<ControlUiMockRequestHandler>[0][] = [];
  gateway.setRequestHandler("health", (request) => pending.push(request));
  const sockets = [
    new window.WebSocket("ws://mock/first"),
    new window.WebSocket("ws://mock/second"),
  ];
  const frames: ResponseFrame[][] = [[], []];
  for (const [index, socket] of sockets.entries()) {
    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as ResponseFrame;
      if (frame.event !== "connect.challenge") {
        frames[index]!.push(frame);
      }
    });
  }
  await flushMockTimers();
  for (const [index, socket] of sockets.entries()) {
    socket.send(
      JSON.stringify({ type: "req", id: String(index), method: "health", params: { index } }),
    );
  }
  await flushMockTimers();
  expect(pending.map((request) => request.params)).toEqual([{ index: 0 }, { index: 1 }]);
  for (const request of pending.toReversed()) {
    request.respond(request.params);
    request.emit("checked", request.params);
  }
  for (const index of [0, 1]) {
    expect(frames[index]).toMatchObject([
      { type: "res", id: String(index), ok: true, payload: { index } },
      { type: "event", event: "checked", payload: { index } },
    ]);
  }
});

describe("mock gateway stateful config", () => {
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

    const controls = (
      window as typeof window & {
        openclawControlUiE2eGateway?: { setOnline: (online: boolean) => void };
      }
    ).openclawControlUiE2eGateway;
    expect(controls).toBeDefined();
    controls?.setOnline(false);

    expect(passthrough.readyState).toBe(window.WebSocket.OPEN);
    expect(first.readyState).toBe(window.WebSocket.CLOSED);
    expect(second.readyState).toBe(window.WebSocket.CLOSED);
    expect(replacement?.readyState).toBe(window.WebSocket.CONNECTING);

    controls?.setOnline(true);
    expect(replacement?.readyState).toBe(window.WebSocket.OPEN);
  });

  it.for(["absent", "null", "explicit"] as const)(
    "round-trips config.set through config.get with %s source projections and an advancing hash",
    async (projectionShape, { gatewayPage }) => {
      const { execute } = gatewayPage;
      const raw = '{\n  "logging": {\n    "level": "info"\n  }\n}\n';
      const initialConfig = { logging: { level: "info" } };
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
      // Execute the generated init script the way the browser <script> tag does.
      execute(script);

      const { request, send, frames } = gatewayPage.connect();
      await flushMockTimers();

      const initial = await request("get-1", "config.get", {});
      expect(initial).toMatchObject({
        raw,
        hash: "fixture-hash",
        configRevisionHash: "fixture-hash",
        appliedConfigHash: "fixture-hash",
      });
      expect(initial.config).toEqual({ logging: { level: "info" } });
      expectProjections(initial, initialConfig);

      const nextRaw = raw.replace("info", "debug");
      const set = await request("set-1", "config.set", {
        raw: nextRaw,
        baseHash: "fixture-hash",
      });
      // Acks carry the persisted hash, mirroring the real gateway contract.
      expect(set).toEqual({
        ok: true,
        hash: "mock-config-hash-1",
        config: { logging: { level: "debug" } },
      });

      const reloaded = await request("get-2", "config.get", {});
      expect(reloaded).toMatchObject({
        raw: nextRaw,
        hash: "mock-config-hash-1",
        configRevisionHash: "mock-config-hash-1",
        appliedConfigHash: "fixture-hash",
      });
      expect(reloaded.config).toEqual({ logging: { level: "debug" } });
      expectProjections(reloaded, { logging: { level: "debug" } });

      const applied = await request("apply-1", "config.apply", {
        raw: nextRaw,
        baseHash: "mock-config-hash-1",
      });
      expect(applied).toEqual({
        ok: true,
        hash: "mock-config-hash-2",
        config: { logging: { level: "debug" } },
      });
      const afterApply = await request("get-3", "config.get", {});
      expect(afterApply).toMatchObject({
        hash: "mock-config-hash-2",
        configRevisionHash: "mock-config-hash-2",
        appliedConfigHash: "mock-config-hash-2",
      });
      expectProjections(afterApply, { logging: { level: "debug" } });

      const json5Raw = '{\n  // Keep this comment.\n  logging: { level: "warn", },\n}\n';
      const json5Ack = await request("set-json5", "config.set", {
        raw: json5Raw,
        baseHash: "mock-config-hash-2",
      });
      expect(json5Ack).toEqual({
        ok: true,
        hash: "mock-config-hash-3",
        config: { logging: { level: "warn" } },
      });
      const json5Reloaded = await request("get-json5", "config.get", {});
      expect(json5Reloaded).toMatchObject({ raw: json5Raw, hash: "mock-config-hash-3" });
      expect(json5Reloaded.config).toEqual({ logging: { level: "warn" } });
      expectProjections(json5Reloaded, { logging: { level: "warn" } });

      const gateway = (
        gatewayPage.window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
      ).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway was not installed");
      }
      const replacement = { logging: { level: "error" } };
      gateway.deferNext("config.patch");
      send("pending-replacement", "config.patch", {
        raw: JSON.stringify(replacement),
        baseHash: "mock-config-hash-3",
      });
      await flushMockTimers();
      gateway.setMethodResponse("config.get", {
        raw: JSON.stringify(replacement),
        config: replacement,
        hash: "replacement-hash",
        appliedConfigHash: "replacement-applied-hash",
        valid: true,
        issues: [],
      });
      gateway.resolveDeferred("config.patch", { ok: true, hash: "replacement-hash" });
      expect(frames.find((frame) => frame.id === "pending-replacement")).toMatchObject({
        ok: true,
      });
      // Reload before any read can materialize the acknowledged replacement fixture.
      execute(script);
      const reconnected = gatewayPage.connect();
      await flushMockTimers();
      expect(await reconnected.request("get-replaced", "config.get", {})).toMatchObject({
        raw: JSON.stringify(replacement),
        config: replacement,
        hash: "replacement-hash",
        appliedConfigHash: "replacement-applied-hash",
      });
      expect(
        await reconnected.request("set-after-replacement", "config.set", {
          raw: JSON.stringify(replacement),
          baseHash: "replacement-hash",
        }),
      ).toMatchObject({ ok: true, hash: "mock-config-hash-4" });
    },
  );
});

describe("mock gateway stateful sessions", () => {
  it("publishes a catalog adoption only after its deferred response succeeds", async ({
    gatewayPage,
  }) => {
    const { window, execute } = gatewayPage;
    const sessionKey = "agent:main:deferred-catalog-adoption";
    const script = createControlUiMockGatewayInitScript({
      deferredMethods: ["sessions.catalog.continue"],
      methodResponses: {
        "sessions.catalog.continue": { sessionKey },
      },
    });
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();

    send("deferred-adoption", "sessions.catalog.continue", {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "deferred-adoption")).toBeUndefined();

    const gateway = (
      window as unknown as {
        openclawControlUiE2eGateway?: {
          resolveDeferred: (method: string, payload?: unknown) => void;
        };
      }
    ).openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Mock Gateway was not installed");
    }
    gateway.resolveDeferred("sessions.catalog.continue", { sessionKey });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "deferred-adoption")?.payload).toEqual({
      sessionKey,
    });

    send("list-after-deferred-adoption", "sessions.list", {
      agentId: "main",
      search: "deferred-catalog-adoption",
    });
    await flushMockTimers();
    expect(
      frames.find((frame) => frame.id === "list-after-deferred-adoption")?.payload,
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
    const { execute, window } = gatewayPage;
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
      const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
        .openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway was not installed");
      }
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
});
