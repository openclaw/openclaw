import { describe, expect, it, vi } from "vitest";
import {
  errorShape,
  ErrorCodes,
  type BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerPluginDashboardCapabilities } from "../../plugins/dashboard-capabilities.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginGatewayMethodDescriptor } from "../methods/descriptor.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function createWorkboardCapabilityRegistry(params: {
  readHandler: GatewayRequestHandlers[string];
  actionHandler: GatewayRequestHandlers[string];
}) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers["workboard.cards.list"] = params.readHandler;
  registry.gatewayHandlers["workboard.cards.dispatch"] = params.actionHandler;
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "workboard",
      name: "workboard.cards.list",
      handler: params.readHandler,
      scope: "operator.read",
    }),
    createPluginGatewayMethodDescriptor({
      pluginId: "workboard",
      name: "workboard.cards.dispatch",
      handler: params.actionHandler,
      scope: "operator.write",
    }),
  );
  const plugin = createPluginRecord({
    id: "workboard",
    source: "workboard-stub-plugin-fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
    dashboard: {
      dataBindings: [
        {
          id: "cards.list",
          method: "workboard.cards.list",
          description: "List fixture cards",
        },
      ],
      actionVerbs: [
        {
          id: "dispatch",
          method: "workboard.cards.dispatch",
          description: "Dispatch fixture cards",
          paramShape: {
            type: "object",
            additionalProperties: false,
            required: ["force"],
            properties: { force: { type: "boolean" } },
          },
        },
      ],
    },
  });
  registerPluginDashboardCapabilities({ record: plugin, registry });
  registry.plugins.push(plugin);
  return registry;
}

describe("board plugin capabilities", () => {
  it.each([
    { operation: "read", phase: "start" },
    { operation: "action", phase: "start" },
    { operation: "read", phase: "publish" },
    { operation: "action", phase: "publish" },
  ] as const)(
    "keeps $operation $phase in the authorized read turn",
    async ({ operation, phase }) => {
      const previousRegistry = getActivePluginRegistry();
      const order: string[] = [];
      let started = false;
      const handler: GatewayRequestHandlers[string] = ({ respond }) => {
        started = true;
        order.push("started");
        respond(true, { ok: true });
      };
      setActivePluginRegistry(
        createWorkboardCapabilityRegistry({ readHandler: handler, actionHandler: handler }),
      );
      try {
        const { invoke, store, handlers, context } = createBoardHarness(undefined, {}, undefined, {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: "main" }] },
            tools: { exec: { mode: "full" } },
          }),
        });
        await invoke("board.widget.put", {
          sessionKey: "session",
          name: "handoff",
          content: { kind: "html", html: "handoff" },
          declared: { tools: ["workboard.cards.list", "workboard.dispatch"] },
        });
        const board = await invoke("board.get", { sessionKey: "session" });
        const ticket = (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!.viewTicket;
        const removed = createDeferred();
        let removalScheduled = false;
        const read = store.useWidgetDocument.bind(store);
        vi.spyOn(store, "useWidgetDocument").mockImplementation((target, name, consume) =>
          read(target, name, (document) => {
            if (!removalScheduled && (phase === "start" || started)) {
              removalScheduled = true;
              queueMicrotask(() => {
                order.push("removal");
                void store
                  .applyOps(target, [{ kind: "widget_remove", name }])
                  .then(() => removed.resolve(), removed.reject);
              });
            }
            return consume(document);
          }),
        );
        const method = operation === "read" ? "board.data.read" : "board.action";
        const params =
          operation === "read"
            ? { ticket, bindingId: "workboard.cards.list" }
            : { ticket, action: "workboard.dispatch", params: { force: true } };
        const respond = vi.fn<RespondFn>((ok) => {
          if (ok) {
            order.push("published");
          }
        });
        await handlers[method]!({
          req: { type: "req", id: "handoff", method, params },
          params,
          respond,
          context,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(removalScheduled).toBe(true);
        await removed.promise;
        expect(order).toEqual(
          phase === "start" ? ["started", "removal"] : ["started", "published", "removal"],
        );
        expect(respond.mock.calls[0]?.[0]).toBe(phase === "publish");
      } finally {
        resetPluginRuntimeStateForTest();
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        }
      }
    },
  );

  it.each([
    { operation: "read", outcome: "success", scope: "retired" },
    { operation: "read", outcome: "failure", scope: "retired" },
    { operation: "read", outcome: "throw", scope: "retired" },
    { operation: "action", outcome: "success", scope: "retired" },
    { operation: "action", outcome: "failure", scope: "retired" },
    { operation: "action", outcome: "throw", scope: "retired" },
    { operation: "read", outcome: "failure", scope: "current" },
    { operation: "action", outcome: "throw", scope: "current" },
  ] as const)(
    "$scope widget authority controls plugin $operation $outcome publication",
    async ({ operation, outcome, scope }) => {
      const previousRegistry = getActivePluginRegistry();
      const started = createDeferred();
      const release = createDeferred();
      const privateDetail = "private plugin result detail";
      const handler: GatewayRequestHandlers[string] = async ({ respond }) => {
        started.resolve();
        await release.promise;
        if (outcome === "throw") {
          throw new Error(privateDetail);
        }
        if (outcome === "failure") {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, privateDetail));
        } else {
          respond(true, { detail: privateDetail });
        }
      };
      setActivePluginRegistry(
        createWorkboardCapabilityRegistry({ readHandler: handler, actionHandler: handler }),
      );
      try {
        const { invoke } = createBoardHarness(undefined, {}, undefined, {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: "main" }] },
            tools: { exec: { mode: "full" } },
          }),
        });
        const widget = {
          sessionKey: "session",
          name: "plugin-widget",
          content: { kind: "html", html: "original" },
          declared: { tools: ["workboard.cards.list", "workboard.dispatch"] },
        };
        await invoke("board.widget.put", widget);
        const board = await invoke("board.get", { sessionKey: "session" });
        const ticket = (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!.viewTicket;
        const pending =
          operation === "read"
            ? invoke("board.data.read", { ticket, bindingId: "workboard.cards.list" })
            : invoke("board.action", {
                ticket,
                action: "workboard.dispatch",
                params: { force: true },
              });
        await started.promise;
        if (scope === "retired" && operation === "read") {
          await invoke("board.widget.put", {
            ...widget,
            content: { kind: "html", html: "replacement" },
          });
        } else if (scope === "retired") {
          await invoke("board.update", {
            sessionKey: "session",
            ops: [{ kind: "widget_remove", name: "plugin-widget" }],
          });
        }
        release.resolve();
        const response = await pending;
        expect(response.mock.calls[0]?.[0]).toBe(false);
        if (scope === "retired") {
          expect(JSON.stringify(response.mock.calls)).not.toContain(privateDetail);
        } else {
          expect(response.mock.calls[0]?.[2]).toMatchObject({
            code: outcome === "throw" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining(privateDetail),
          });
        }
      } finally {
        release.resolve();
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        } else {
          resetPluginRuntimeStateForTest();
        }
      }
    },
  );
  it("routes granted bindings and actions only while their plugin registry is active", async () => {
    const previousRegistry = getActivePluginRegistry();
    const readHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { items: [params.filter ?? "all"] });
    });
    const actionHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { refreshed: params.force });
    });
    const registry = createWorkboardCapabilityRegistry({ readHandler, actionHandler });
    setActivePluginRegistry(registry);

    try {
      const { invoke, store } = createBoardHarness();
      const put = await invoke("board.widget.put", {
        sessionKey: "session",
        name: "plugin-widget",
        content: { kind: "html", html: "plugin" },
        declared: { tools: ["workboard.cards.list", "workboard.dispatch"] },
      });
      expect(put.mock.calls[0]?.[1]).toMatchObject({
        widgets: [
          {
            declaredSummary: [
              "Tool access: workboard.cards.list",
              "Tool access: workboard.dispatch",
            ],
          },
        ],
      });
      await invoke("board.widget.grant", {
        sessionKey: "session",
        name: "plugin-widget",
        decision: "granted",
        revision: 1,
        instanceId: (await store.getSnapshot({ sessionKey: "session", agentId: "main" })).widgets[0]
          ?.instanceId,
      });
      const board = await invoke("board.get", { sessionKey: "session" });
      const snapshot = board.mock.calls[0]?.[1] as BoardSnapshot;
      const ticket = snapshot.widgets[0]?.viewTicket;

      const read = await invoke("board.data.read", {
        ticket,
        bindingId: "workboard.cards.list",
        params: { filter: "ready" },
      });
      expect(read.mock.calls[0]?.[1]).toEqual({ items: ["ready"] });
      expect(readHandler).toHaveBeenCalledOnce();

      const invalidAction = await invoke("board.action", {
        ticket,
        action: "workboard.dispatch",
        params: { force: "yes" },
      });
      expect(invalidAction.mock.calls[0]?.[0]).toBe(false);
      expect(actionHandler).not.toHaveBeenCalled();

      const action = await invoke("board.action", {
        ticket,
        action: "workboard.dispatch",
        params: { force: true },
      });
      expect(action.mock.calls[0]?.[1]).toEqual({ refreshed: true });
      expect(actionHandler).toHaveBeenCalledOnce();

      setActivePluginRegistry(registry);
      const staleAction = await invoke("board.action", {
        ticket,
        action: "workboard.dispatch",
        params: { force: true },
      });
      expect(staleAction.mock.calls[0]?.[0]).toBe(false);
      expect(staleAction.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
      expect(actionHandler).toHaveBeenCalledOnce();

      const refreshedBoard = await invoke("board.get", { sessionKey: "session" });
      const refreshedSnapshot = refreshedBoard.mock.calls[0]?.[1] as BoardSnapshot;
      const refreshedAction = await invoke("board.action", {
        ticket: refreshedSnapshot.widgets[0]?.viewTicket,
        action: "workboard.dispatch",
        params: { force: true },
      });
      expect(refreshedAction.mock.calls[0]?.[1]).toEqual({ refreshed: true });
      expect(actionHandler).toHaveBeenCalledTimes(2);

      setActivePluginRegistry(createEmptyPluginRegistry());
      const unavailable = await invoke("board.data.read", {
        ticket,
        bindingId: "workboard.cards.list",
      });
      expect(unavailable.mock.calls[0]?.[0]).toBe(false);
      expect(unavailable.mock.calls[0]?.[2]?.message).toContain("dashboard unavailable");
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
