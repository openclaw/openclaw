/* @vitest-environment jsdom */
// Exercises the serialized mock gateway exactly as a page would: the init
// script installs MockWebSocket on window, and requests flow over it.
import { describe, expect } from "vitest";
import { setSharedControlUiE2eServerBaseUrl } from "./control-ui-e2e-shared-preview.ts";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
  type ControlUiMockGatewayScenario,
  type ControlUiMockRequestHandler,
} from "./control-ui-e2e.ts";
import { flushMockTimers, mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

type ResponseFrame = {
  event?: string;
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

function waitForMockCycle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
}

it("advertises the leased build in hello while retaining scenario overrides and clearing stale identity", async ({
  gatewayPage,
}) => {
  const buildInfo = { buildId: "prepared-ui-build", version: "2026.9.23" };
  const defaultIdentity = { buildId: "e2e", version: "e2e" };
  const expectHello = async (
    id: string,
    scenario: ControlUiMockGatewayScenario,
    server: typeof buildInfo,
  ) => {
    gatewayPage.execute(createControlUiMockGatewayInitScript(scenario));
    const { request } = gatewayPage.connect();
    await flushMockTimers();
    expect(await request(id, "connect", {})).toMatchObject({ server });
  };

  setSharedControlUiE2eServerBaseUrl(null);
  try {
    await expectHello("ordinary", {}, defaultIdentity);
    setSharedControlUiE2eServerBaseUrl("http://prebuilt-ui/", buildInfo);
    await expectHello("prepared", {}, buildInfo);
    await expectHello(
      "build-override",
      { serverBuildId: " custom-build ", serverVersion: " " },
      { ...buildInfo, buildId: "custom-build" },
    );
    await expectHello(
      "version-override",
      { serverBuildId: " ", serverVersion: " 2026.9.24 " },
      { ...buildInfo, version: "2026.9.24" },
    );

    setSharedControlUiE2eServerBaseUrl("http://prebuilt-ui/", { ...buildInfo, version: null });
    await expectHello("unknown-version", {}, { ...buildInfo, version: "e2e" });
    setSharedControlUiE2eServerBaseUrl("http://ordinary-ui/");
    await expectHello("replacement", {}, defaultIdentity);
    setSharedControlUiE2eServerBaseUrl("http://prebuilt-ui/", buildInfo);
    setSharedControlUiE2eServerBaseUrl(null);
    await expectHello("reset", {}, defaultIdentity);
  } finally {
    setSharedControlUiE2eServerBaseUrl(null);
  }
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

  it("preserves explicit source projections for unchanged raw reads and apply", async ({
    gatewayPage,
  }) => {
    const { execute } = gatewayPage;
    const raw = '{"logging":{"level":"${MOCK_LOG_LEVEL}"}}';
    const sourceConfig = { logging: { level: "debug" } };
    const runtimeConfig = {
      ...sourceConfig,
      agents: { defaults: { thinkingDefault: "low" } },
    };
    execute(
      createControlUiMockGatewayInitScript({
        methodResponses: {
          "config.get": {
            raw,
            config: runtimeConfig,
            sourceConfig,
            resolved: sourceConfig,
            runtimeConfig,
            hash: "projected-source-fixture",
            valid: true,
            issues: [],
          },
        },
      }),
    );
    const { request } = gatewayPage.connect();
    await flushMockTimers();
    const projections = { raw, sourceConfig, resolved: sourceConfig, runtimeConfig };
    expect(await request("get-projected", "config.get", {})).toMatchObject(projections);

    const applied = await request("apply-unchanged", "config.apply", {
      raw,
      baseHash: "projected-source-fixture",
    });
    expect(applied).toMatchObject({ ok: true, hash: "mock-config-hash-1" });
    expect(await request("get-projected-after-apply", "config.get", {})).toMatchObject({
      ...projections,
      hash: applied.hash,
      appliedConfigHash: applied.hash,
    });
  });

  it("preserves configured projections when the raw fixture is unparseable", async ({
    gatewayPage,
  }) => {
    const { execute } = gatewayPage;
    const sourceConfig = { logging: { level: "info" } };
    const runtimeConfig = {
      ...sourceConfig,
      agents: { defaults: { thinkingDefault: "low" } },
    };
    const raw = "{";
    const issues = [{ path: "", message: "Synthetic parse failure" }];
    execute(
      createControlUiMockGatewayInitScript({
        methodResponses: {
          "config.get": {
            raw,
            config: runtimeConfig,
            sourceConfig,
            resolved: sourceConfig,
            runtimeConfig,
            hash: "invalid-raw-fixture",
            valid: false,
            issues,
          },
        },
      }),
    );
    const { request } = gatewayPage.connect();
    await flushMockTimers();
    expect(await request("get-invalid", "config.get", {})).toMatchObject({
      raw,
      valid: false,
      issues,
      config: runtimeConfig,
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig,
    });

    const invalidEdit = "{ still invalid";
    await request("set-invalid", "config.set", {
      raw: invalidEdit,
      baseHash: "invalid-raw-fixture",
    });
    const invalidReloaded = await request("get-invalid-after-edit", "config.get", {});
    expect(invalidReloaded).toMatchObject({
      raw: invalidEdit,
      valid: false,
      issues,
      config: runtimeConfig,
      sourceConfig,
      resolved: sourceConfig,
      runtimeConfig,
    });
    expect(invalidReloaded.sourceConfig).toEqual(sourceConfig);
    expect(invalidReloaded.resolved).toEqual(sourceConfig);
  });

  it("leaves config methods untouched when the scenario has no raw fixture", async ({
    gatewayPage,
  }) => {
    const { execute } = gatewayPage;
    const script = createControlUiMockGatewayInitScript({
      methodResponses: { "config.set": { custom: true } },
    });
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();

    send("set-1", "config.set", {});
    await flushMockTimers();
    const response = frames.find((frame) => frame.type === "res" && frame.id === "set-1");
    expect(response?.payload).toEqual({ custom: true });
  });

  it("hydrates legacy persisted config state without losing revision hashes", async ({
    gatewayPage,
  }) => {
    const { window, execute } = gatewayPage;
    const raw = '{"logging":{"level":"info"}}';
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw,
          config: { logging: { level: "info" } },
          hash: "fixture-hash",
          appliedConfigHash: "fixture-applied-hash",
          valid: true,
          issues: [],
        },
      },
    });
    window.sessionStorage.setItem(
      "openclaw.control-ui-e2e.configState",
      JSON.stringify({ raw, revision: 2 }),
    );
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();
    send("get-1", "config.get", {});
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "get-1")?.payload).toMatchObject({
      hash: "fixture-hash",
      configRevisionHash: "fixture-hash",
      appliedConfigHash: "fixture-applied-hash",
    });
  });
});

describe("mock gateway stateful sessions", () => {
  it("acknowledges broad session observation with the real Gateway response", async ({
    gatewayPage,
  }) => {
    const { execute } = gatewayPage;
    const script = createControlUiMockGatewayInitScript({});
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();

    send("subscribe-events", "sessions.subscribe");
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "subscribe-events")?.payload).toEqual({
      subscribed: true,
    });
  });

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

  it.for(["sessions.catalog.continue", "sessions.create"])(
    "does not publish rejected %s materialization to sessions.list",
    async (method, { gatewayPage }) => {
      const { execute } = gatewayPage;
      const sessionKey = "agent:main:rejected-session";
      execute(
        createControlUiMockGatewayInitScript({
          methodResponses: {
            [method]: {
              __mockError: { code: "INVALID_REQUEST", message: "materialization rejected" },
            },
          },
        }),
      );
      const { frames, send } = gatewayPage.connect();
      await flushMockTimers();
      send(
        "rejected",
        method,
        method === "sessions.create"
          ? { agentId: "main", key: sessionKey }
          : { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      );
      await flushMockTimers();
      send("list-after-rejection", "sessions.list", {
        agentId: "main",
        search: "rejected-session",
      });
      await flushMockTimers();
      const listed = frames.find((frame) => frame.id === "list-after-rejection")?.payload;
      expect(listed).toMatchObject({ count: 1, sessions: [{ key: "agent:main:main" }] });
      expect(JSON.stringify(listed)).not.toContain(sessionKey);
    },
  );

  it("cycles subscription-scoped session events and stops after unsubscribe", async ({
    gatewayPage,
  }) => {
    const { execute } = gatewayPage;
    const sessionKey = "agent:main:sidebar-narration-demo";
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.companion.ask": {
          cases: [
            {
              match: { sessionKey },
              response: {
                answer: "It is rerunning the focused test to verify the latest fix.",
                ts: 1_000,
              },
            },
          ],
        },
      },
      repeatingSessionEvents: {
        intervalMs: 250,
        events: [
          {
            event: "agent",
            payload: {
              data: {
                replace: true,
                text: "Rebasing onto main and rerunning the sidebar suite.",
              },
              sessionKey,
              stream: "assistant",
            },
          },
          {
            event: "session.tool",
            payload: { data: { name: "exec" }, sessionKey, stream: "tool" },
          },
          {
            event: "session.observer",
            payload: {
              headline: "Rerunning focused tests",
              health: "grinding",
              revision: 1,
              runId: "mock-observer-run",
              sessionKey,
              updatedAt: 1_000,
            },
          },
        ],
      },
    });
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();

    send("subscribe-1", "sessions.messages.subscribe", { key: sessionKey });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "subscribe-1")?.payload).toEqual({
      key: sessionKey,
    });
    send("companion-ask-1", "sessions.companion.ask", {
      sessionKey,
      question: "Why is it rerunning that test?",
    });
    await flushMockTimers();
    expect(frames.find((frame) => frame.id === "companion-ask-1")?.payload).toEqual({
      answer: "It is rerunning the focused test to verify the latest fix.",
      ts: 1_000,
    });
    expect(frames.find((frame) => frame.event === "agent")?.payload).toMatchObject({
      sessionKey,
      stream: "assistant",
      data: { text: "Rebasing onto main and rerunning the sidebar suite." },
    });

    await waitForMockCycle();
    expect(frames.find((frame) => frame.event === "session.tool")?.payload).toMatchObject({
      sessionKey,
      stream: "tool",
      data: { name: "exec" },
    });

    await waitForMockCycle();
    expect(frames.find((frame) => frame.event === "session.observer")?.payload).toMatchObject({
      headline: "Rerunning focused tests",
      runId: "mock-observer-run",
      sessionKey,
    });

    // Second assistant cycle must repeat: the replayed snapshot carries
    // replace, so the narration controller re-renders instead of deduping.
    await waitForMockCycle();
    const assistantFrames = frames.filter((frame) => frame.event === "agent");
    expect(assistantFrames.length).toBeGreaterThanOrEqual(2);
    expect(assistantFrames.at(-1)?.payload).toMatchObject({
      sessionKey,
      stream: "assistant",
      data: { replace: true, text: "Rebasing onto main and rerunning the sidebar suite." },
    });

    send("unsubscribe-1", "sessions.messages.unsubscribe", { key: sessionKey });
    await flushMockTimers();
    const eventCount = frames.filter((frame) => frame.type === "event").length;
    await waitForMockCycle();
    expect(frames.filter((frame) => frame.type === "event")).toHaveLength(eventCount);
  });

  it("keeps archive filtering opt-in for static session fixtures", async ({ gatewayPage }) => {
    const { execute } = gatewayPage;
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {},
          path: "",
          sessions: [{ key: "agent:main:research", archived: false }],
          ts: 0,
        },
        "sessions.patch": { ok: true },
      },
    });
    execute(script);

    const { frames, send } = gatewayPage.connect();
    await flushMockTimers();

    send("patch-1", "sessions.patch", { key: "agent:main:research", archived: true });
    await flushMockTimers();
    send("list-1", "sessions.list", {});
    await flushMockTimers();

    expect(frames.find((frame) => frame.id === "list-1")?.payload).toMatchObject({
      count: 1,
      sessions: [
        {
          key: "agent:main:research",
          archived: true,
          archivedAt: expect.any(Number),
          pinned: false,
        },
      ],
    });
  });

  it("moves archive patches between active and archived session lists", async ({ gatewayPage }) => {
    const { execute } = gatewayPage;
    const script = createControlUiMockGatewayInitScript({
      methodResponses: {
        "sessions.list": {
          count: 2,
          defaults: {},
          path: "",
          sessions: [
            { key: "agent:main:research", archived: false },
            { key: "agent:main:launch-notes", archived: true },
          ],
          ts: 0,
        },
        "sessions.patch": { ok: true },
      },
      sessionArchiveFiltering: true,
    });
    execute(script);

    const { request } = gatewayPage.connect();
    await flushMockTimers();

    const keys = (payload: Record<string, unknown>) =>
      (payload.sessions as Array<{ key: string }>).map((row) => row.key);

    expect(keys(await request("list-1", "sessions.list", {}))).toEqual(["agent:main:research"]);
    expect(keys(await request("list-2", "sessions.list", { archived: true }))).toEqual([
      "agent:main:launch-notes",
    ]);
    expect(
      await request("patch-3", "sessions.patch", {
        key: "agent:main:research",
        archived: true,
      }),
    ).toEqual({ ok: true });
    expect(keys(await request("list-4", "sessions.list", {}))).toEqual([]);
    expect(keys(await request("list-5", "sessions.list", { archived: true }))).toEqual([
      "agent:main:research",
      "agent:main:launch-notes",
    ]);

    await request("patch-6", "sessions.patch", {
      key: "agent:main:launch-notes",
      archived: false,
    });
    expect(keys(await request("list-7", "sessions.list", {}))).toEqual(["agent:main:launch-notes"]);
    expect(keys(await request("list-8", "sessions.list", { archived: true }))).toEqual([
      "agent:main:research",
    ]);
  });
});
