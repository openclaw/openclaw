import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
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
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
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
import { makeClient } from "../server-broadcast.test-helpers.js";
import { startExactAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createBoardHarness as createHarness } from "./board.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const reviewWidgetApproval = vi.hoisted(() => vi.fn());
const sessionList = vi.hoisted(() => vi.fn());
const cronRun = vi.hoisted(() => vi.fn());
const sessionTarget = { sessionKey: "session", agentId: "main" };
const htmlWidget = (name: string, tools?: string[]) => ({
  sessionKey: "session",
  name,
  content: { kind: "html" as const, html: name },
  declared: { tools },
});
const widgets = async (store: ReturnType<typeof createHarness>["store"]) =>
  (await store.getSnapshot(sessionTarget)).widgets;
function pause() {
  const entered = createDeferred();
  const release = createDeferred();
  const hold = <T extends unknown[], R>(run: (...args: T) => Promise<R>, afterRead = false) => {
    return async (...args: T) => {
      const result = afterRead ? await run(...args) : undefined;
      entered.resolve();
      await release.promise;
      return afterRead ? result! : await run(...args);
    };
  };
  return { entered: entered.promise, release: () => release.resolve(), hold };
}

vi.mock("./sessions-read.js", () => ({
  sessionReadHandlers: { "sessions.list": sessionList },
  sessionsListHandler: sessionList,
}));
vi.mock("./cron.js", () => ({ cronHandlers: { "cron.run": cronRun } }));

vi.mock("../../agents/exec-auto-reviewer.js", () => ({
  createModelExecAutoReviewer: vi.fn(() => reviewWidgetApproval),
}));
async function grantTools(tools: string[], harness = createHarness()) {
  const target = { sessionKey: "session", name: "reader" };
  const put = await harness.invoke("board.widget.put", htmlWidget("reader", tools));
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

function sessionBoard(sessionKey: string, sessionId: string, permissionMode?: "guarded") {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId, updatedAt: 1, ...(permissionMode ? { permissionMode } : {}) },
  );
  const store = new SqliteBoardStore({
    resolveSession: () => ({ agentId: "main", sessionKey, path: database.path }),
  });
  return { database, store };
}

describe("board gateway runtime boundaries", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetSystemEventsForTest();
    reviewWidgetApproval.mockReset();
    sessionList.mockReset();
    cronRun.mockReset();
  });

  it("reads current permission mode from its session owner", async () => {
    const sessionKey = "agent:main:guarded";
    const { store } = sessionBoard(sessionKey, "guarded-widget", "guarded");
    const harness = createHarness(undefined, undefined, store, {
      getRuntimeConfig: () => ({ tools: { exec: { mode: "auto" } } }),
    });
    const response = await harness.invoke("board.widget.put", {
      ...htmlWidget("health", ["health"]),
      sessionKey,
    });
    expect(response.mock.calls[0]).toMatchObject([true, { widgets: [{ grantState: "pending" }] }]);
    expect(reviewWidgetApproval).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("serves board.data.read while a transcript-only database writer is held", async ({
    signal,
  }) => {
    const sessionKey = "agent:main:session";
    const { database, store } = sessionBoard(sessionKey, "board-concurrent-reader");
    const { invoke, ticket } = await grantTools(
      ["sessions.list"],
      createHarness(undefined, undefined, store),
    );
    sessionList.mockImplementation(({ respond }) => respond(true, { sessions: [] }));
    const entered = createDeferred();
    const release = createDeferred();
    const writer = runOpenClawAgentWorkerWrite(
      { agentId: "main", path: database.path },
      async () => {
        database.db.exec("BEGIN IMMEDIATE");
        entered.resolve();
        try {
          await release.promise;
        } finally {
          database.db.exec("ROLLBACK");
        }
      },
      undefined,
      undefined,
      undefined,
      undefined,
      "transcript-only",
    );
    await entered.promise;
    const read = invoke("board.data.read", { ticket, bindingId: "sessions.list" });
    try {
      const response = await withinTest(read, signal);
      expect(database.db.isTransaction).toBe(true);
      expect(response).toHaveBeenCalledWith(true, { sessions: [] });
    } finally {
      release.resolve();
      await Promise.allSettled([writer, read]);
    }
  });

  it("registers every contract method with its required scope", () => {
    for (const [scope, methods] of [
      [
        "operator.read",
        ["board.get", "board.widget.appView", "board.prompt.authorize", "board.data.read"],
      ],
      ["operator.write", ["board.update", "board.widget.put", "board.event", "board.action"]],
      ["operator.approvals", ["board.widget.grant"]],
    ] as const) {
      for (const method of methods) {
        expect(resolveCoreOperatorGatewayMethodScope(method)).toBe(scope);
      }
    }
  });

  it.each(["board.update", "board.get"])(
    "does not publish %s after its Gateway retires",
    async (method) => {
      const harness = createHarness();
      const gate = pause();
      if (method === "board.get") {
        vi.spyOn(harness.store, "getSnapshotWithHtmlViewMetadata").mockImplementationOnce(
          gate.hold(harness.store.getSnapshotWithHtmlViewMetadata.bind(harness.store), true),
        );
      } else {
        vi.spyOn(harness.store, "applyOps").mockImplementationOnce(
          gate.hold(harness.store.applyOps.bind(harness.store)),
        );
      }
      let responded = false;
      const pending = harness
        .invoke(method, {
          sessionKey: "session",
          ...(method === "board.update"
            ? { ops: [{ kind: "tab_create", tabId: "work", title: "Work" }] }
            : {}),
        })
        .then((response) => {
          responded = true;
          return response;
        });
      try {
        await gate.entered;
        expect(responded).toBe(false);
        expect(harness.broadcast).not.toHaveBeenCalled();
        harness.context.resolveGatewayContext = () => undefined;
        gate.release();
        const response = await pending;
        const snapshot = await harness.store.getSnapshot({
          sessionKey: "session",
          agentId: "main",
        });
        expect(response.mock.calls[0]?.[0]).toBe(false);
        expect(snapshot.tabs).toHaveLength(0);
        expect(harness.broadcast).not.toHaveBeenCalled();
        if (method === "board.get") {
          expect(response.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
        }
      } finally {
        gate.release();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("fences awaited board mutation through Gateway dispatch when its root retires", async () => {
    const documentStarted = createDeferred();
    const releaseDocument = createDeferred<{ html: string; cspSandbox: "scripts" }>();
    const harness = createHarness(async () => {
      documentStarted.resolve();
      return await releaseDocument.promise;
    });
    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors({
        "board.widget.put": harness.handlers["board.widget.put"]!,
      }),
    );
    const { client, socket } = makeClient("board-authority-proof", "operator", ["operator.admin"]);
    const gatewayClients = new GatewayClientRegistry();
    gatewayClients.add(client);
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
    const putCanvas = (name: string) =>
      startExactAuthorizationRequest(
        "board.widget.put",
        { sessionKey: "session", name, content: { kind: "canvas-doc", docId: "canvas-doc" } },
        { client, context: gatewayContext, methodRegistry },
      );
    const pending = putCanvas("canvas");
    try {
      await documentStarted.promise;
      resetGatewayWorkAdmission();
      releaseDocument.resolve({ html: "<p>canvas</p>", cspSandbox: "scripts" });
      await pending.request;
      expect(pending.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("dashboard unavailable"),
        }),
      );
      expect(await widgets(harness.store)).toEqual([]);
      expect(socket.events).not.toContain("board.changed");

      const live = putCanvas("live");
      await live.request;
      expect(live.respond.mock.calls[0]?.[0]).toBe(true);
      expect(await widgets(harness.store)).toMatchObject([{ name: "live" }]);
      expect(socket.events).toContain("board.changed");
    } finally {
      releaseDocument.resolve({ html: "<p>canvas</p>", cspSandbox: "scripts" });
      await Promise.allSettled([pending.request]);
      gatewayClients.clear();
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
            ...htmlWidget("approval"),
            declared: { netOrigins: ["https://example.com"] },
          }),
        ),
    );
    expect(response.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
    expect(await widgets(harness.store)).toMatchObject([
      { name: "approval", grantState: "pending" },
    ]);
  });

  it("rejects unknown data bindings inside the gateway allowlist boundary", async () => {
    const { invoke, ticket } = await grantTools(["secrets.dump"]);
    const response = await invoke("board.data.read", {
      ticket,
      bindingId: "secrets.dump",
    });
    expect(response.mock.calls[0]).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("not allowed") },
    ]);
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
    const sessionKey = `notice-${randomUUID()}`;
    const { invoke } = createHarness();
    await invoke("board.widget.put", { ...htmlWidget("counter"), sessionKey });
    const clippedCodeUnits = 500 - "[dashboard] ".length - " on widget counter".length - 1;
    // JSON's opening quote places the emoji across the legacy slice boundary.
    const payload = `${"x".repeat(clippedCodeUnits - 2)}😀tail`;
    await invoke("board.event", { sessionKey, widget: "counter", payload });
    const unicodeNotice = peekSystemEvents(`agent:main:${sessionKey}`)[0] ?? "";
    expect(unicodeNotice.length).toBeLessThanOrEqual(500);
    expect(unicodeNotice).not.toContain(String.fromCharCode(0xd83d));
    expect(unicodeNotice).toMatch(/… on widget counter$/u);
    const event = (text: string) =>
      invoke("board.event", { sessionKey, widget: "counter", payload: text });
    await event("x".repeat(1_000));
    expect(peekSystemEvents(`agent:main:${sessionKey}`)[1]).toHaveLength(500);
    const oversized = await event("x".repeat(8_193));
    expect(oversized.mock.calls[0]?.[0]).toBe(false);
  });
});
