import { beforeEach, expect, it, vi } from "vitest";
import {
  errorShape,
  ErrorCodes,
  type BoardSnapshot,
  type BoardWidgetDeclared,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerPluginDashboardCapabilities } from "../../plugins/dashboard-capabilities.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginGatewayMethodDescriptor } from "../methods/descriptor.js";
import { createBoardHarness } from "./board.test-support.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  return () => resetPluginRuntimeStateForTest();
});

async function widgetHarness(
  handlerPair: {
    readHandler: GatewayRequestHandlers[string];
    actionHandler: GatewayRequestHandlers[string];
  },
  mode: "ask" | "full" = "full",
  bound?: { declared: BoardWidgetDeclared; required: string[] },
) {
  const registry = createEmptyPluginRegistry();
  for (const [name, scope, handler] of [
    ["workboard.cards.list", "operator.read", handlerPair.readHandler],
    ["workboard.cards.dispatch", "operator.write", handlerPair.actionHandler],
  ] as const) {
    registry.gatewayHandlers[name] = handler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({ pluginId: "workboard", name, handler, scope }),
    );
  }
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
          ...(bound ? { requiredActionBindingParams: bound.required } : {}),
          paramShape: {
            type: "object",
            properties: { force: { type: "boolean" } },
            required: ["force"],
            additionalProperties: false,
          },
        },
      ],
    },
  });
  registerPluginDashboardCapabilities({ record: plugin, registry });
  registry.plugins.push(plugin);
  setActivePluginRegistry(registry);
  const harness = createBoardHarness(undefined, {}, undefined, {
    getRuntimeConfig: () => ({ agents: { entries: { main: {} } }, tools: { exec: { mode } } }),
  });
  const put = await harness.invoke("board.widget.put", {
    ...target,
    content: { kind: "html", html: "plugin" },
    declared: bound?.declared ?? { tools: ["workboard.cards.list", "workboard.dispatch"] },
  });
  expect(put.mock.calls[0]?.[0], JSON.stringify(put.mock.calls[0])).toBe(true);
  const widget = (put.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
  const ticket = async () => {
    const board = await harness.invoke("board.get", { sessionKey: target.sessionKey });
    return (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!.viewTicket;
  };
  const call = (
    operation: Operation,
    viewTicket: string | undefined,
    params?: Record<string, unknown>,
  ) => {
    const request = widgetRequest(operation, viewTicket, params);
    return harness.invoke(request.method, request.params);
  };
  return { ...harness, registry, widget, ticket, call };
}

const target = { sessionKey: "session", name: "plugin-widget" };
type Operation = "read" | "action";
const requests = {
  read: ["board.data.read", "bindingId", "workboard.cards.list"],
  action: ["board.action", "action", "workboard.dispatch"],
} as const;
function widgetRequest(
  operation: Operation,
  ticket: string | undefined,
  params?: Record<string, unknown>,
) {
  const [method, field, capability] = requests[operation];
  const extra = params ?? (operation === "action" ? { force: true } : undefined);
  return {
    method,
    params: { ticket, [field]: capability, ...(extra ? { params: extra } : {}) },
  };
}

it("presents current plugin permission descriptions without persisting them or losing frame access", async () => {
  const handler: GatewayRequestHandlers[string] = ({ respond }) => respond(true, {});
  const { invoke, store, registry, widget } = await widgetHarness(
    { readHandler: handler, actionHandler: handler },
    "full",
    {
      declared: {
        tools: ["workboard.cards.list"],
        actionBindings: [
          { name: "dispatch", actionId: "workboard.dispatch", params: { force: true } },
        ],
      },
      required: ["force"],
    },
  );
  expect(widget.declaredSummary).toContain("workboard.dispatch: Dispatch fixture cards");
  const read = async () => {
    const result = await invoke("board.get", { sessionKey: target.sessionKey });
    expect(result.mock.calls[0]?.[0]).toBe(true);
    return (result.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
  };
  const presented = await read();
  expect(presented.declaredSummary).toContain("workboard.cards.list: List fixture cards");
  expect(presented.declaredSummary).toContain("workboard.dispatch: Dispatch fixture cards");
  expect(presented.capabilityDescriptions).toMatchObject({
    "workboard.dispatch": "Dispatch fixture cards",
  });
  expect(presented.viewTicket).toEqual(expect.any(String));
  expect(presented.frameUrl).toEqual(expect.any(String));
  const stored = (await store.getSnapshot({ sessionKey: target.sessionKey, agentId: "main" }))
    .widgets[0]!;
  expect(stored.declaredSummary).not.toContain("workboard.dispatch: Dispatch fixture cards");
  expect(stored.capabilityDescriptions).toBeUndefined();
  registry.dashboardActionVerbs.clear();
  const unavailable = await read();
  expect(unavailable.declaredSummary).not.toContain("workboard.dispatch: Dispatch fixture cards");
  expect(unavailable.capabilityDescriptions).not.toHaveProperty("workboard.dispatch");
  expect(unavailable.grantState).toBe(presented.grantState);
});

it.each([
  { operation: "read", phase: "start" },
  { operation: "action", phase: "publish" },
] as const)("keeps $operation $phase in the authorized read turn", async ({ operation, phase }) => {
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
  const { method, params } = widgetRequest(operation, viewTicket);
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
});

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
    const { invoke, ticket, call } = await widgetHarness({
      readHandler: handler,
      actionHandler: handler,
    });
    const viewTicket = await ticket();
    const pending = call(operation, viewTicket);
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
        expect(response.mock.calls[0]).toMatchObject([
          false,
          undefined,
          {
            code: operation === "action" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining(detail),
          },
        ]);
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
  const { invoke, registry, widget, ticket, call } = await widgetHarness(
    { readHandler, actionHandler },
    "ask",
  );
  await invoke("board.widget.grant", {
    ...target,
    decision: "granted",
    revision: widget.revision,
    instanceId: widget.instanceId,
  });
  const viewTicket = await ticket();
  const read = await call("read", viewTicket, { filter: "ready" });
  expect(read.mock.calls[0]?.[1]).toEqual({ items: ["ready"] });
  expect(readHandler).toHaveBeenCalledOnce();
  const action = (actionTicket: string | undefined, force: boolean | string) =>
    call("action", actionTicket, { force });
  expect((await action(viewTicket, "yes")).mock.calls[0]?.[0]).toBe(false);
  expect(actionHandler).not.toHaveBeenCalled();
  expect((await action(viewTicket, true)).mock.calls[0]?.[1]).toEqual({ refreshed: true });
  expect(actionHandler).toHaveBeenCalledOnce();
  setActivePluginRegistry(registry);
  const stale = await action(viewTicket, true);
  expect(stale.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
  expect(actionHandler).toHaveBeenCalledOnce();
  expect((await action(await ticket(), true)).mock.calls[0]?.[1]).toEqual({ refreshed: true });
  expect(actionHandler).toHaveBeenCalledTimes(2);
  setActivePluginRegistry(createEmptyPluginRegistry());
  const unavailable = await call("read", viewTicket);
  expect(unavailable.mock.calls[0]).toMatchObject([
    false,
    undefined,
    { message: expect.stringContaining("dashboard unavailable") },
  ]);
});

it("dispatches named actions only with their approved fixed fields, never legacy or overridden targets", async () => {
  let finalGuard: (() => void) | undefined;
  const actionHandler = vi.fn<GatewayRequestHandlers[string]>(async ({ params, respond }) => {
    const scope = getPluginRuntimeGatewayRequestScope();
    await scope?.revalidate?.();
    finalGuard = scope?.assertSystemOwnerCurrent;
    finalGuard?.();
    respond(true, params);
  });
  const fixture = await widgetHarness({ readHandler: actionHandler, actionHandler }, "full", {
    declared: {
      tools: ["workboard.dispatch"],
      actionBindings: [{ name: "send", actionId: "workboard.dispatch", params: { force: true } }],
    },
    required: ["force"],
  });
  const viewTicket = await fixture.ticket();
  const good = await fixture.invoke("board.action", {
    ticket: viewTicket,
    bindingName: "send",
    params: {},
  });
  expect(good.mock.calls[0]?.[0], JSON.stringify(good.mock.calls[0])).toBe(true);
  expect(actionHandler).toHaveBeenCalledOnce();
  expect(actionHandler.mock.calls[0]?.[0].params).toEqual({ force: true });
  expect(finalGuard).toBeTypeOf("function");
  expect(() => finalGuard!()).toThrow();
  const override = await fixture.invoke("board.action", {
    ticket: viewTicket,
    bindingName: "send",
    params: { force: false },
  });
  expect(override.mock.calls[0]?.[0]).toBe(false);
  const legacy = await fixture.call("action", viewTicket, { force: true });
  expect(legacy.mock.calls[0]?.[0]).toBe(false);
  const missing = await fixture.invoke("board.action", {
    ticket: viewTicket,
    bindingName: "missing",
  });
  expect(missing.mock.calls[0]?.[0]).toBe(false);
  expect(actionHandler).toHaveBeenCalledOnce();
  await fixture.invoke("board.update", {
    sessionKey: target.sessionKey,
    ops: [{ kind: "widget_remove", name: target.name }],
  });
  const revoked = await fixture.invoke("board.action", {
    ticket: viewTicket,
    bindingName: "send",
    params: {},
  });
  expect(revoked.mock.calls[0]?.[0]).toBe(false);
  expect(actionHandler).toHaveBeenCalledOnce();
});

it("rejects named bindings missing a required fixed field", async () => {
  const actionHandler = vi.fn<GatewayRequestHandlers[string]>(({ respond }) => respond(true, {}));
  const fixture = await widgetHarness({ readHandler: actionHandler, actionHandler }, "full", {
    declared: { actionBindings: [{ name: "send", actionId: "workboard.dispatch", params: {} }] },
    required: ["force"],
  });
  const result = await fixture.invoke("board.action", {
    ticket: await fixture.ticket(),
    bindingName: "send",
    params: { force: true },
  });
  expect(result.mock.calls[0]?.[0]).toBe(false);
  expect(actionHandler).not.toHaveBeenCalled();
});

it("revalidates a named action after preparation and retires its deferred authority", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const effect = vi.fn();
  let revalidate: (() => Promise<void>) | undefined;
  const actionHandler: GatewayRequestHandlers[string] = async ({ respond }) => {
    revalidate = getPluginRuntimeGatewayRequestScope()?.revalidate;
    expect(revalidate).toBeTypeOf("function");
    entered.resolve();
    await release.promise;
    await revalidate!();
    effect();
    respond(true, {});
  };
  const fixture = await widgetHarness({ readHandler: actionHandler, actionHandler }, "full", {
    declared: {
      actionBindings: [{ name: "send", actionId: "workboard.dispatch", params: { force: true } }],
    },
    required: ["force"],
  });
  const pending = fixture.invoke("board.action", {
    ticket: await fixture.ticket(),
    bindingName: "send",
    params: {},
  });
  await entered.promise;
  try {
    await fixture.store.applyOps(target, [{ kind: "widget_remove", name: target.name }]);
  } finally {
    release.resolve();
  }
  const result = await pending;
  expect(result.mock.calls[0]?.[0]).toBe(false);
  expect(effect).not.toHaveBeenCalled();
  await expect(revalidate!()).rejects.toThrow();
});
