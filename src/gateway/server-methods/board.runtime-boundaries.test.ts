import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "../../../packages/gateway-client/src/index.js";
import {
  PROTOCOL_VERSION,
  type BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetBoardEventNoticeStateForTest } from "../../boards/board-notices.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest } from "../../process/gateway-work-admission.test-helpers.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { handleGatewayRequest } from "../server-methods.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());
const sessionList = vi.hoisted(() => vi.fn());
const cronRun = vi.hoisted(() => vi.fn());

vi.mock("./sessions-read.js", () => ({
  sessionReadHandlers: { "sessions.list": sessionList },
  sessionsListHandler: sessionList,
}));
vi.mock("./cron.js", () => ({ cronHandlers: { "cron.run": cronRun } }));

vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: vi.fn(() => reviewWidgetApproval),
}));
vi.mock("./sessions.runtime.js", () => ({
  performGatewaySessionReset: vi.fn(async ({ key, reason }: { key: string; reason: string }) => ({
    ok: true,
    key,
    agentId: "main",
    entry: { sessionId: `reset-${reason}` },
    resolved: {},
  })),
}));

async function grantTools(tools: string[], harness = createHarness()) {
  const target = { sessionKey: "session", name: "reader" };
  const put = await harness.invoke("board.widget.put", {
    ...target,
    content: { kind: "html", html: "reader" },
    declared: { tools },
  });
  const widget = (put.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
  await harness.invoke("board.widget.grant", {
    ...target,
    decision: "granted",
    revision: widget.revision,
    instanceId: widget.instanceId,
  });
  const board = await harness.invoke("board.get", { sessionKey: "session" });
  return { ...harness, ticket: (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!.viewTicket };
}

describe("board gateway runtime boundaries", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetBoardEventNoticeStateForTest();
    resetSystemEventsForTest();
    reviewWidgetApproval.mockReset();
    sessionList.mockReset();
    cronRun.mockReset();
  });

  it.each(["agent:main:guarded"])(
    "reads current permission mode from its session owner: %s",
    async (sessionKey) => {
      const database = openOpenClawAgentDatabase({
        agentId: "main",
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath: database.path },
        { sessionId: "guarded-widget", updatedAt: 1, permissionMode: "guarded" },
      );
      const cfg = { tools: { exec: { mode: "auto" as const } } };
      const store = new SqliteBoardStore({
        resolveSession: () => ({ agentId: "main", sessionKey, path: database.path }),
      });
      const harness = createHarness(undefined, undefined, store, {
        getRuntimeConfig: () => cfg,
      });
      const response = await harness.invoke("board.widget.put", {
        sessionKey,
        name: "health",
        content: { kind: "html", html: "<p>health</p>" },
        declared: { tools: ["health"] },
      });
      expect(response).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ widgets: [expect.objectContaining({ grantState: "pending" })] }),
      );
      expect(reviewWidgetApproval).not.toHaveBeenCalled();
    },
  );

  afterEach(async () => {
    resetGatewayWorkAdmission();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("registers every contract method with its required scope", () => {
    expect(
      Object.fromEntries(
        [
          "board.get",
          "board.update",
          "board.widget.put",
          "board.widget.grant",
          "board.widget.appView",
          "board.event",
          "board.prompt.authorize",
          "board.data.read",
          "board.action",
        ].map((method) => [method, resolveCoreOperatorGatewayMethodScope(method)]),
      ),
    ).toEqual({
      "board.get": "operator.read",
      "board.update": "operator.write",
      "board.widget.put": "operator.write",
      "board.widget.grant": "operator.approvals",
      "board.widget.appView": "operator.read",
      "board.event": "operator.write",
      "board.prompt.authorize": "operator.read",
      "board.data.read": "operator.read",
      "board.action": "operator.write",
    });
  });

  it.each(["commit", "retired"] as const)(
    "waits for board persistence before publishing a %s result",
    async (outcome) => {
      const harness = createHarness();
      const started = createDeferred();
      const release = createDeferred();
      const applyOps = harness.store.applyOps.bind(harness.store);
      vi.spyOn(harness.store, "applyOps").mockImplementationOnce(async (...args) => {
        started.resolve();
        await release.promise;
        return await applyOps(...args);
      });
      let responded = false;
      const pending = harness
        .invoke("board.update", {
          sessionKey: "session",
          ops: [{ kind: "tab_create", tabId: "work", title: "Work" }],
        })
        .then((response) => {
          responded = true;
          return response;
        });
      await started.promise;
      expect(responded).toBe(false);
      expect(harness.broadcast).not.toHaveBeenCalled();
      if (outcome === "retired") {
        harness.context.resolveGatewayContext = () => undefined;
      }
      release.resolve();
      const response = await pending;
      const snapshot = await harness.store.getSnapshot({ sessionKey: "session", agentId: "main" });
      expect(response.mock.calls[0]?.[0]).toBe(outcome === "commit");
      expect(snapshot.tabs).toHaveLength(outcome === "commit" ? 1 : 0);
      if (outcome === "commit") {
        expect(harness.broadcast).toHaveBeenCalledWith(
          "board.changed",
          { sessionKey: "agent:main:session", revision: snapshot.revision },
          { sessionKeys: ["agent:main:session"], agentId: "main" },
        );
      } else {
        expect(harness.broadcast).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for a board snapshot and rejects publication after its Gateway retires", async () => {
    const harness = createHarness();
    const started = createDeferred();
    const release = createDeferred();
    const read = harness.store.getSnapshotWithHtmlViewMetadata.bind(harness.store);
    vi.spyOn(harness.store, "getSnapshotWithHtmlViewMetadata").mockImplementationOnce(
      async (...args) => {
        const snapshot = await read(...args);
        started.resolve();
        await release.promise;
        return snapshot;
      },
    );
    let responded = false;
    const pending = harness.invoke("board.get", { sessionKey: "session" }).then((response) => {
      responded = true;
      return response;
    });
    await started.promise;
    expect(responded).toBe(false);
    harness.context.resolveGatewayContext = () => undefined;
    release.resolve();
    const response = await pending;
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("fences awaited board mutation through Gateway dispatch when its root retires", async () => {
    const documentStarted = createDeferred();
    const releaseDocument = createDeferred<{ html: string; cspSandbox: "scripts" }>();
    const harness = createHarness(async () => {
      documentStarted.resolve();
      return await releaseDocument.promise;
    });
    const handler = harness.handlers["board.widget.put"];
    if (!handler) {
      throw new Error("board.widget.put handler missing");
    }
    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({ "board.widget.put": handler }),
    );
    const events: string[] = [];
    const connected = createDeferred();
    const gatewayClients = new GatewayClientRegistry();
    const { broadcast } = createGatewayBroadcaster({ clients: gatewayClients });
    const gatewayContext = {
      broadcast,
      getGatewayMethodRegistry: () => methodRegistry,
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({
        agents: { entries: { main: {} } },
        tools: { exec: { mode: "ask" } },
      }),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    gatewayContext.resolveGatewayContext = () => gatewayContext;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      let gatewayClient: GatewayWsClient | null = null;
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "board-authority-proof", ts: Date.now() },
        }),
      );
      socket.on("message", (data) => {
        const request = JSON.parse(rawDataToString(data)) as {
          id: string;
          method: string;
          params?: unknown;
          type: "req";
        };
        if (request.method === "connect") {
          gatewayClient = {
            socket,
            connect: {
              role: "operator",
              scopes: ["operator.admin"],
            } as GatewayWsClient["connect"],
            connId: "board-authority-proof",
            usesSharedGatewayAuth: false,
          };
          gatewayClients.add(gatewayClient);
          socket.send(
            JSON.stringify({
              type: "res",
              id: request.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: PROTOCOL_VERSION,
                server: { version: "board-authority-proof", connId: "board-authority-proof" },
                features: { methods: ["board.widget.put"], events: ["board.changed"] },
                snapshot: {
                  presence: [],
                  health: {},
                  stateVersion: { presence: 1, health: 1 },
                  uptimeMs: 1,
                },
                auth: { role: "operator", scopes: ["operator.admin"] },
                policy: {
                  maxPayload: 512 * 1024,
                  maxBufferedBytes: 1024 * 1024,
                  tickIntervalMs: 60_000,
                },
              },
            }),
          );
          return;
        }
        void handleGatewayRequest({
          req: request,
          respond: (ok, payload, error) => {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok,
                ...(payload === undefined ? {} : { payload }),
                ...(error === undefined ? {} : { error }),
              }),
            );
          },
          client: gatewayClient,
          isWebchatConnect: () => false,
          context: gatewayContext,
          methodRegistry,
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("board authority proof server did not get a TCP address");
    }
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      onEvent: (event) => events.push(event.event ?? ""),
      onHelloOk: () => connected.resolve(),
      onConnectError: (error) => connected.reject(error),
    });
    try {
      client.start();
      await connected.promise;
      const request = client.request(
        "board.widget.put",
        {
          sessionKey: "session",
          name: "canvas",
          content: { kind: "canvas-doc", docId: "canvas-doc" },
        },
        { timeoutMs: null },
      );
      const requestOutcome = request.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await documentStarted.promise;

      resetGatewayWorkAdmission();
      releaseDocument.resolve({ html: "<p>canvas</p>", cspSandbox: "scripts" });

      const { error } = await requestOutcome;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("dashboard unavailable");
      expect(
        (await harness.store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets,
      ).toEqual([]);
      expect(events).not.toContain("board.changed");

      await client.request("board.widget.put", {
        sessionKey: "session",
        name: "live",
        content: { kind: "canvas-doc", docId: "live-canvas-doc" },
      });
      expect(
        (await harness.store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets,
      ).toMatchObject([{ name: "live" }]);
      expect(events).toContain("board.changed");
    } finally {
      client.stop();
      gatewayClients.clear();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("fences automatic widget approval to the current plugin authority", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    markPluginRegistryActive(pluginRegistry);
    reviewWidgetApproval.mockImplementationOnce(async () => {
      markPluginRegistryRetired(pluginRegistry);
      markPluginRegistryActive(pluginRegistry);
      return { decision: "allow-once", risk: "low", rationale: "approved before plugin reload" };
    });
    const harness = createHarness(undefined, undefined, undefined, {
      getRuntimeConfig: () => ({
        agents: { entries: { main: {} } },
        tools: { exec: { mode: "auto" } },
      }),
    });
    const response = await withPluginRuntimeGatewayRequestScope(
      { isWebchatConnect: () => false, pluginRegistry },
      () =>
        runWithGatewayRootWorkAdmissionForTest(() =>
          harness.invoke("board.widget.put", {
            sessionKey: "session",
            name: "approval",
            content: { kind: "html", html: "approval" },
            declared: { netOrigins: ["https://example.com"] },
          }),
        ),
    );
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(
      (await harness.store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets,
    ).toMatchObject([{ name: "approval", grantState: "pending" }]);
  });

  it("rejects unknown data bindings inside the gateway allowlist boundary", async () => {
    const { invoke, ticket } = await grantTools(["secrets.dump"]);
    const response = await invoke("board.data.read", {
      ticket,
      bindingId: "secrets.dump",
    });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not allowed") }),
    );
  });

  it("runs only the exact granted cron job capability", async () => {
    cronRun.mockImplementation(
      async ({ params, respond }: { params: { id: string }; respond: RespondFn }) =>
        respond(true, { ok: true, jobId: params.id }),
    );
    const { invoke, ticket } = await grantTools(["cron.trigger:job-1"]);

    const denied = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-2",
    });
    expect(denied.mock.calls[0]?.[0]).toBe(false);
    expect(cronRun).not.toHaveBeenCalled();

    const allowed = await invoke("board.action", {
      ticket,
      action: "cron.trigger",
      jobId: "job-1",
    });
    expect(allowed.mock.calls[0]?.[1]).toEqual({ ok: true, jobId: "job-1" });
    expect(cronRun).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: "job-1", mode: "force" } }),
    );
  });

  it("caps board.event payloads and preserves Unicode at the notice boundary", async () => {
    const { invoke } = createHarness();
    await invoke("board.widget.put", {
      sessionKey: "session",
      name: "counter",
      content: { kind: "html", html: "ok" },
    });
    const clippedCodeUnits = 500 - "[dashboard] ".length - " on widget counter".length - 1;
    // JSON's opening quote places the emoji across the legacy slice boundary.
    const payload = `${"x".repeat(clippedCodeUnits - 2)}😀tail`;
    await invoke("board.event", { sessionKey: "session", widget: "counter", payload });
    const unicodeNotice = peekSystemEvents("agent:main:session")[0] ?? "";
    expect(unicodeNotice.length).toBeLessThanOrEqual(500);
    expect(unicodeNotice).not.toContain(String.fromCharCode(0xd83d));
    expect(unicodeNotice).toMatch(/… on widget counter$/u);
    await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(1_000),
    });
    expect(peekSystemEvents("agent:main:session")[1]).toHaveLength(500);
    const oversized = await invoke("board.event", {
      sessionKey: "session",
      widget: "counter",
      payload: "x".repeat(8_193),
    });
    expect(oversized.mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps board state across the real sessions.reset handler", async () => {
    const sessionKey = "agent:main:board-reset-proof";
    const stateDir = tempDirs.make("openclaw-board-reset-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey, storePath: database.path },
      { sessionId: "board-reset-proof", updatedAt: Date.now() },
    );
    const boardStore = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", sessionKey }),
      env,
    });
    await boardStore.putWidget({
      sessionKey,
      name: "status",
      content: { kind: "html", html: "ok" },
    });
    const respond = vi.fn<RespondFn>();
    await sessionMutationHandlers["sessions.reset"]!({
      req: { type: "req", id: "reset", method: "sessions.reset", params: {} },
      params: { key: sessionKey, reason: "reset" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        broadcast: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect((await boardStore.getSnapshot({ sessionKey })).widgets).toHaveLength(1);
  });
});
