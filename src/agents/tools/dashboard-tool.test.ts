import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import {
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "../../gateway/server-methods/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDashboardTool } from "./dashboard-tool.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

afterEach(() => vi.restoreAllMocks());

const snapshot: BoardSnapshot = {
  sessionKey: "agent:main:main",
  revision: 3,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};
const pluginContent = () => ({ pluginKind: "workboard:card", props: { cardId: "card-123" } });
function inGateway(context: GatewayRequestContext, run: () => Promise<void>) {
  return withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, run);
}

function recorder(boardSnapshot: BoardSnapshot = snapshot) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const commands: unknown[] = [];
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    if (method === "sessions.describe") {
      return { session: null } as T;
    }
    if (method === "sessions.patch") {
      return { key: params.key, entry: { boardPresentation: params.boardPresentation } } as T;
    }
    return boardSnapshot as T;
  };
  vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockImplementation(callGateway);
  return {
    tool: createDashboardTool({
      agentSessionKey: snapshot.sessionKey,
    }),
    calls,
    commands,
  };
}

function createGatewayAffinityHarness(revision: number) {
  const requests: GatewayRequestHandlerOptions["req"][] = [];
  const broadcastToConnIds = vi.fn();
  const handlers: GatewayRequestHandlers = {
    "board.get": ({ req, respond }) => {
      requests.push(req);
      respond(true, { ...snapshot, revision });
    },
    "sessions.describe": ({ req, respond }) => {
      requests.push(req);
      respond(true, { session: { boardPresentation: "expanded" } });
    },
    "sessions.patch": ({ req, params, respond }) => {
      requests.push(req);
      respond(true, { key: params.key, entry: { boardPresentation: params.boardPresentation } });
    },
  };
  const descriptors = createGatewayMethodDescriptorsFromHandlers({
    handlers,
    owner: { kind: "core", area: "dashboard-affinity-test" },
    defaultScope: "operator.read",
  });
  const methodRegistry = createGatewayMethodRegistry(descriptors);
  const context = {
    trackExecution: trackAsyncWork,
    broadcastToConnIds,
    getClientConnIds: () => new Set([`control-ui-${revision}`]),
    getGatewayMethodRegistry: () => methodRegistry,
    getRuntimeConfig: () => ({}),
    resolveGatewayContext: () => context,
  } as unknown as GatewayRequestContext;
  return { broadcastToConnIds, context, requests };
}

it("declares dashboard actions without overriding widget placement", () => {
  const tool = createDashboardTool();
  const accepts = (args: Record<string, unknown>, valid = true) =>
    expect(Value.Check(tool.parameters, args)).toBe(valid);
  const directoryDescription = tool.description.slice(0, 177);
  expect(tool.requiredClientCaps).toBeUndefined();
  expect(tool.description).toContain("stable names");
  expect(tool.description).toContain("sm=3x3");
  expect(directoryDescription).not.toMatch(/keep .*inline/i);
  expect(directoryDescription).toMatch(/widget_put.*plugin.*only/i);
  expect(tool.description).not.toMatch(/show_widget|widget_code|\bpin\b/);
  expect(tool.parameters).toMatchObject({ additionalProperties: false });
  expect(tool.parameters).toHaveProperty(
    "properties.action.enum",
    "read capability_describe tab_create tab_update tab_delete tabs_reorder widget_put widget_read widget_move widget_resize widget_remove focus_tab set_presentation set_default_presentation".split(
      " ",
    ),
  );
  accepts({ action: "widget_move", name: "status" });
  accepts({ action: "widget_put", name: "work-item", ...pluginContent() });
  accepts({ action: "unknown" }, false);
  accepts({ action: "set_presentation", presentation: "expanded" });
  accepts({ action: "tab_update", tabId: "main", chatDock: "left" }, false);
  accepts({ action: "set_presentation", dock: "left" }, false);
  accepts({ action: "set_default_presentation", presentation: "expanded" });
  accepts({ action: "set_default_presentation", presentation: "fullscreen" }, false);
});

it("dispatches through the admitted Gateway and fences replacement or retirement", async () => {
  const admitted = createGatewayAffinityHarness(11);
  const replacement = createGatewayAffinityHarness(22);
  let current: GatewayRequestContext | undefined = admitted.context;
  const tool = createDashboardTool({ agentSessionKey: "agent:main:main" });
  const execute = (args: Record<string, unknown>) => tool.execute("dashboard", args);
  const unavailable = (args: Record<string, unknown>) =>
    expect(execute(args)).rejects.toThrow(/dashboard|Gateway|gateway|unavailable/u);

  await inGateway(
    replacement.context,
    async () =>
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => current,
        },
        async () => {
          expect((await execute({ action: "read" })).details).toMatchObject({
            revision: 11,
            defaultPresentation: "expanded",
          });
          expect((await execute({ action: "focus_tab", tabId: "main" })).details).toEqual({
            ok: true,
            delivered: 1,
          });
          const saved = await execute({
            action: "set_default_presentation",
            presentation: "expanded",
          });
          expect(saved.details).toEqual({
            ok: true,
            sessionKey: "agent:main:main",
            defaultPresentation: "expanded",
          });

          current = replacement.context;
          await unavailable({ action: "set_default_presentation", presentation: "split" });
          await unavailable({ action: "read" });
          current = undefined;
          await unavailable({ action: "focus_tab", tabId: "main" });
        },
      ),
  );

  expect(admitted.requests).toHaveLength(3);
  expect(admitted.requests.slice(0, 2)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "req",
        id: expect.stringMatching(/^plugin-subagent-/u),
        method: "board.get",
        params: expect.objectContaining({ sessionKey: "agent:main:main" }),
      }),
      expect.objectContaining({
        method: "sessions.describe",
        params: expect.objectContaining({ key: "agent:main:main" }),
      }),
    ]),
  );
  expect(admitted.requests[2]).toEqual(
    expect.objectContaining({
      method: "sessions.patch",
      params: {
        key: "agent:main:main",
        boardFace: "dashboard",
        boardPresentation: "expanded",
      },
    }),
  );
  expect(replacement.requests).toEqual([]);
  expect(admitted.broadcastToConnIds).toHaveBeenCalledOnce();
  expect(replacement.broadcastToConnIds).not.toHaveBeenCalled();
});

it("returns content ownership and valid update paths in model-visible snapshot details", async () => {
  type Widget = BoardSnapshot["widgets"][number];
  const ownership = [
    { name: "custom-html", contentOwner: "html" },
    { name: "trusted-plugin", contentOwner: "plugin" },
    { name: "mcp-app", contentOwner: "mcp-app" },
    { name: "retired", contentOwner: "registered" },
  ] as const;
  const widget = (fields: (typeof ownership)[number]): Widget => ({
    tabId: "main",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    contentKind: fields.contentOwner === "registered" ? "plugin" : fields.contentOwner,
    ...fields,
  });
  const harness = recorder({ ...snapshot, widgets: ownership.map(widget) });
  const result = await harness.tool.execute("read", { action: "read" });

  expect(result.details).toMatchObject({
    widgets: ownership,
    contentUpdatePaths: {
      html: expect.stringMatching(/authoring.*tool catalog.*same name/i),
      plugin: expect.stringMatching(/widget_put.*same name.*pluginKind/i),
      "mcp-app": expect.stringMatching(/MCP app/i),
      registered: expect.stringMatching(/retired.*recreate.*HTML/i),
    },
  });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining('"contentOwner":"html"'),
  });
  expect(JSON.stringify(result.details)).not.toMatch(/show_widget|widget_code|\bpin\b/);
});

it.each([
  [{ action: "focus_tab", tabId: "Invalid Tab" }, "lowercase slug"],
  [{ action: "set_presentation", presentation: "left" }, "presentation must be split or expanded"],
  [{ action: "set_presentation" }, "presentation required"],
])("rejects invalid presentation command %j before broadcasting", async (args, message) => {
  const harness = recorder();
  await expect(harness.tool.execute("command", args)).rejects.toThrow(message);
  expect(harness.commands).toEqual([]);
  expect(harness.calls).toEqual([]);
});

it.each([
  ["tab_create", { tabId: "notes", title: "Notes" }],
  ["tab_update", { tabId: "notes", title: "New", position: 0 }],
  ["tab_delete", { tabId: "notes" }],
  ["tabs_reorder", { tabIds: ["two", "one"] }],
  ["widget_move", { name: "status", tabId: "notes", after: "clock" }],
  ["widget_resize", { name: "status", sizeW: 8, sizeH: 6 }],
  ["widget_remove", { name: "status" }],
])("maps %s to one board.update op", async (action, args) => {
  const harness = recorder();
  await harness.tool.execute("mutate", { action, ...args });
  expect(harness.calls).toEqual([
    ["board.update", { sessionKey: "agent:main:main", ops: [{ kind: action, ...args }] }],
  ]);
});

it("creates a plugin widget through board.widget.put", async () => {
  const harness = recorder();
  const placement = { tabId: "main", size: "sm" };
  const identity = { name: "work-item", title: "Work item" };
  await harness.tool.execute("put", {
    action: "widget_put",
    ...identity,
    ...pluginContent(),
    ...placement,
  });
  expect(harness.calls).toEqual([
    [
      "board.widget.put",
      {
        sessionKey: "agent:main:main",
        ...identity,
        content: { kind: "plugin", ...pluginContent() },
        placement,
      },
    ],
  ]);
});

it.each([
  ["set_presentation", { presentation: "split" }, { kind: "set_chat_dock", dock: "right" }],
  ["set_presentation", { presentation: "expanded" }, { kind: "set_chat_dock", dock: "hidden" }],
])("emits board.command for %s", async (action, args, command) => {
  const harness = recorder();
  const gateway = createGatewayAffinityHarness(0);
  gateway.context.getClientConnIds = () => new Set(["control-ui-1", "control-ui-2"]);
  gateway.broadcastToConnIds.mockImplementation((_event: string, payload: unknown) => {
    harness.commands.push(payload);
  });
  await inGateway(gateway.context, async () => {
    const result = await harness.tool.execute("command", { action, ...args });
    expect(harness.calls).toEqual([]);
    expect(harness.commands).toEqual([{ sessionKey: "agent:main:main", command }]);
    expect(result.details).toEqual({ ok: true, delivered: 2 });
  });
});

it("reports commands as unavailable when no Control UI is connected", async () => {
  const context = {
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
  };
  await inGateway(context as never, async () => {
    const tool = createDashboardTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("command", { action: "focus_tab", tabId: "notes" });
    expect(result.details).toEqual({
      status: "unavailable",
      code: "UNAVAILABLE",
      message: "Connect Control UI and retry.",
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/Control UI.*retry/i),
    });
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "board.command",
      expect.any(Object),
      new Set(),
    );
  });
});

it("reads source only for the admitted dashboard session and returns its source revision", async () => {
  const source = {
    sessionKey: snapshot.sessionKey,
    name: "scene",
    revision: 3,
    sha256: "a".repeat(64),
    html: "<p>scene</p>",
    offset: 0,
    totalLength: 12,
  };
  const requests = vi.fn();
  const callGateway: InProcessGatewayCaller = async <T>(
    ...args: Parameters<InProcessGatewayCaller>
  ): Promise<T> => {
    requests(...args);
    return source as T;
  };
  const tool = createDashboardTool({
    agentSessionKey: snapshot.sessionKey,
    agentId: "main",
    callGateway,
  });
  const result = await tool.execute("read-scene", {
    action: "widget_read",
    name: "scene",
    expectedRevision: 3,
    offset: 0,
    limit: 100,
  });
  expect(requests).toHaveBeenCalledWith(
    "board.widget.source",
    {
      sessionKey: snapshot.sessionKey,
      agentId: "main",
      name: "scene",
      expectedRevision: 3,
      offset: 0,
      limit: 100,
    },
    undefined,
  );
  expect(result.details).toEqual(source);
  await expect(tool.execute("invalid", { action: "widget_read" })).rejects.toThrow("name");
  expect(requests).toHaveBeenCalledTimes(1);
});

it("discovers contracts without Gateway calls or board mutations and honors target retirement", async () => {
  const callGateway = vi.fn(async () => {
    throw new Error("Metadata discovery must not call the Gateway");
  });
  const assertTargetCurrent = vi.fn();
  const tool = createDashboardTool({
    agentSessionKey: snapshot.sessionKey,
    callGateway,
    assertTargetCurrent,
  });
  const result = await tool.execute("contract", {
    action: "capability_describe",
    capabilityId: "sessions.list",
  });
  expect(result.details).toMatchObject({ id: "sessions.list", resultCoverage: "partial" });
  expect(callGateway).not.toHaveBeenCalled();
  expect(assertTargetCurrent).toHaveBeenCalledTimes(1);
  assertTargetCurrent.mockImplementation(() => {
    throw new Error("retired");
  });
  await expect(
    tool.execute("retired", { action: "capability_describe", capabilityId: "agents.list" }),
  ).rejects.toThrow("retired");
});

it("uses each admitted registry at execution time, including component conversations", async () => {
  const registry = createEmptyPluginRegistry();
  const handler = vi.fn();
  registry.dashboardDataBindings.set("fixture.read", {
    id: "read",
    capabilityId: "fixture.read",
    pluginId: "fixture",
    method: "fixture.read",
    description: "Scoped fixture",
    handler,
  });
  const callGateway = vi.fn(async () => {
    throw new Error("Metadata discovery must not call the Gateway");
  });
  const tool = createDashboardTool({
    agentSessionKey:
      "agent:main:lobby-11111111-1111-1111-1111-111111111111:component:sample:11111111111111111111111111111111",
    callGateway,
  });
  const args = { action: "capability_describe", capabilityId: "fixture.read" };
  const first = await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: registry, isWebchatConnect: () => false },
    () => tool.execute("first", args),
  );
  expect(first.details).toMatchObject({ owner: "fixture", description: "Scoped fixture" });
  const next = await withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: createEmptyPluginRegistry(), isWebchatConnect: () => false },
    () => tool.execute("next", args),
  );
  expect(next.details).toMatchObject({ status: "unknown_or_inactive" });
  expect(handler).not.toHaveBeenCalled();
  expect(callGateway).not.toHaveBeenCalled();
});
