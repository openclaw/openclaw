import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  errorShape,
  ErrorCodes,
  type BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerPluginDashboardCapabilities } from "../../plugins/dashboard-capabilities.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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

const target = { sessionKey: "session", name: "plugin-widget" };

async function widgetHarness(
  handlers: Parameters<typeof createWorkboardCapabilityRegistry>[0],
  mode: "ask" | "full" = "full",
) {
  const registry = createWorkboardCapabilityRegistry(handlers);
  setActivePluginRegistry(registry);
  const harness = createBoardHarness(undefined, {}, undefined, {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } }, tools: { exec: { mode } } }),
  });
  const put = await harness.invoke("board.widget.put", {
    ...target,
    content: { kind: "html", html: "plugin" },
    declared: { tools: ["workboard.cards.list", "workboard.dispatch"] },
  });
  const widget = (put.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
  const ticket = async () => {
    const board = await harness.invoke("board.get", { sessionKey: target.sessionKey });
    return (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!.viewTicket;
  };
  return { ...harness, registry, widget, ticket };
}

describe("board plugin capabilities", () => {
  beforeEach(() => resetPluginRuntimeStateForTest());
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each([
    { operation: "read", phase: "start" },
    { operation: "action", phase: "publish" },
  ] as const)(
    "keeps $operation $phase in the authorized read turn",
    async ({ operation, phase }) => {
      const order: string[] = [];
      let started = false;
      const handler: GatewayRequestHandlers[string] = ({ respond }) => {
        started = true;
        order.push("started");
        respond(true, { ok: true });
      };
      const { store, handlers, context, ticket } = await widgetHarness({
        readHandler: handler,
        actionHandler: handler,
      });
      const viewTicket = await ticket();
      const removed = createDeferred();
      let removalScheduled = false;
      const read = store.useWidgetDocument.bind(store);
      vi.spyOn(store, "useWidgetDocument").mockImplementation((session, name, consume) =>
        read(session, name, (document) => {
          if (!removalScheduled && (phase === "start" || started)) {
            removalScheduled = true;
            queueMicrotask(() => {
              order.push("removal");
              void store
                .applyOps(session, [{ kind: "widget_remove", name }])
                .then(() => removed.resolve(), removed.reject);
            });
          }
          return consume(document);
        }),
      );
      const method = operation === "read" ? "board.data.read" : "board.action";
      const params =
        operation === "read"
          ? { ticket: viewTicket, bindingId: "workboard.cards.list" }
          : { ticket: viewTicket, action: "workboard.dispatch", params: { force: true } };
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
    },
  );

  it.each([
    { operation: "read", retired: false },
    { operation: "action", retired: false },
    { operation: "action", retired: true },
  ] as const)(
    "publishes plugin $operation errors only with current authority (retired=$retired)",
    async ({ operation, retired }) => {
      const detail = "private plugin result detail";
      const started = createDeferred();
      const release = createDeferred();
      const handler: GatewayRequestHandlers[string] = async ({ respond }) => {
        started.resolve();
        await release.promise;
        if (operation === "action") {
          throw new Error(detail);
        }
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, detail));
      };
      const { invoke, ticket } = await widgetHarness({
        readHandler: handler,
        actionHandler: handler,
      });
      const viewTicket = await ticket();
      const pending =
        operation === "read"
          ? invoke("board.data.read", { ticket: viewTicket, bindingId: "workboard.cards.list" })
          : invoke("board.action", {
              ticket: viewTicket,
              action: "workboard.dispatch",
              params: { force: true },
            });
      try {
        await started.promise;
        if (retired) {
          await invoke("board.update", {
            sessionKey: target.sessionKey,
            ops: [{ kind: "widget_remove", name: target.name }],
          });
        }
        release.resolve();
        const response = await pending;
        expect(response.mock.calls[0]?.[0]).toBe(false);
        if (retired) {
          expect(JSON.stringify(response.mock.calls)).not.toContain(detail);
        } else {
          expect(response.mock.calls[0]?.[2]).toMatchObject({
            code: operation === "action" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining(detail),
          });
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("routes granted bindings and actions only while their plugin registry is active", async () => {
    const readHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { items: [params.filter ?? "all"] });
    });
    const actionHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
      respond(true, { refreshed: params.force });
    });
    const { invoke, registry, widget, ticket } = await widgetHarness(
      { readHandler, actionHandler },
      "ask",
    );
    expect(widget.declaredSummary).toEqual([
      "Tool access: workboard.cards.list",
      "Tool access: workboard.dispatch",
    ]);
    await invoke("board.widget.grant", {
      ...target,
      decision: "granted",
      revision: widget.revision,
      instanceId: widget.instanceId,
    });
    const viewTicket = await ticket();
    const read = await invoke("board.data.read", {
      ticket: viewTicket,
      bindingId: "workboard.cards.list",
      params: { filter: "ready" },
    });
    expect(read.mock.calls[0]?.[1]).toEqual({ items: ["ready"] });
    expect(readHandler).toHaveBeenCalledOnce();
    const action = (actionTicket: string | undefined, force: boolean | string) =>
      invoke("board.action", {
        ticket: actionTicket,
        action: "workboard.dispatch",
        params: { force },
      });
    expect((await action(viewTicket, "yes")).mock.calls[0]?.[0]).toBe(false);
    expect(actionHandler).not.toHaveBeenCalled();
    expect((await action(viewTicket, true)).mock.calls[0]?.[1]).toEqual({ refreshed: true });
    expect(actionHandler).toHaveBeenCalledOnce();
    setActivePluginRegistry(registry);
    const stale = await action(viewTicket, true);
    expect(stale.mock.calls[0]?.[0]).toBe(false);
    expect(stale.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(actionHandler).toHaveBeenCalledOnce();
    expect((await action(await ticket(), true)).mock.calls[0]?.[1]).toEqual({ refreshed: true });
    expect(actionHandler).toHaveBeenCalledTimes(2);
    setActivePluginRegistry(createEmptyPluginRegistry());
    const unavailable = await invoke("board.data.read", {
      ticket: viewTicket,
      bindingId: "workboard.cards.list",
    });
    expect(unavailable.mock.calls[0]?.[0]).toBe(false);
    expect(unavailable.mock.calls[0]?.[2]?.message).toContain("dashboard unavailable");
  });
});
