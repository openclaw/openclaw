// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { publishPanelEmbedState, subscribePanelEmbedLinks } from "./bridge.ts";
import { panelEmbedLayout, type PanelEmbedTarget } from "./target.ts";

afterEach(() => vi.unstubAllGlobals());

it("hands task detail selection to the native dock without reopening the initial target or synthetic Chat", () => {
  const postMessage = vi.fn();
  vi.stubGlobal("window", { __OPENCLAW_NATIVE_PANEL__: { postMessage } });
  const target: PanelEmbedTarget = {
    agentId: "main",
    sessionKey: "agent:main:one",
    panel: { id: "tasks", slot: "tasks" },
    resourceAutoOpenDismissed: false,
  };
  const layout = panelEmbedLayout(target);
  const initial = publishPanelEmbedState(target, [], layout, "");
  expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ openPanels: [], revealedSlots: [] });
  publishPanelEmbedState(target, [], layout, initial);
  expect(postMessage).toHaveBeenCalledTimes(1);

  const column = layout.columns[0]!;
  column.panels[0]!.taskId = "task-selected";
  column.panels.push({ id: "conversation", slot: "conversation" });
  column.activePanelId = "conversation";
  publishPanelEmbedState(target, [], layout, initial);
  expect(postMessage.mock.calls[1]?.[0]).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:one",
    openPanels: [{ slot: "tasks", taskId: "task-selected" }],
    activeSlot: "tasks",
    revealedSlots: [],
  });
});

it("classifies native picker links using the current plugin owner and drops retired or cross-session requests", () => {
  const postMessage = vi.fn();
  const host = Object.assign(new EventTarget(), { __OPENCLAW_NATIVE_PANEL__: { postMessage } });
  vi.stubGlobal("window", host);
  const snapshot: ApplicationGatewaySnapshot = {
    phase: "connected",
    client: createTestGatewayClient(vi.fn()),
    hello: gatewayHelloForMethods(["forge.item"], ["operator.read"]),
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:one",
    lastError: null,
    lastErrorCode: null,
    pluginCapabilities: {
      ok: true,
      descriptors: [],
      methods: ["forge.item"],
      controlUiLinkReaders: [
        {
          pluginId: "forge",
          id: "items",
          label: "Forge",
          linkReader: {
            hosts: ["forge.example"],
            pathPattern: "^/items/[1-9][0-9]*$",
            detailMethod: "forge.item",
          },
        },
      ],
    },
  };
  const target: PanelEmbedTarget = {
    agentId: "main",
    sessionKey: "agent:main:one",
    panel: null,
    resourceAutoOpenDismissed: false,
  };
  let live = true;
  const dispose = subscribePanelEmbedLinks(target, () => (live ? snapshot : null));
  const request = {
    receiver: "picker",
    agentId: "main",
    sessionKey: "agent:main:one",
    requestId: "request-1",
    url: "https://forge.example/items/123",
  };
  const send = (detail: unknown = request) =>
    host.dispatchEvent(new CustomEvent("openclaw:native-panel-link", { detail }));
  try {
    send({ ...request, sessionKey: "agent:main:other" });
    send({ ...request, receiver: "panel" });
    expect(postMessage).not.toHaveBeenCalled();
    send();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "openclaw-panel-link",
      agentId: "main",
      sessionKey: "agent:main:one",
      requestId: "request-1",
      url: request.url,
      reader: true,
    });
    snapshot.pluginCapabilities!.methods = [];
    send();
    expect(postMessage.mock.calls.at(-1)?.[0].reader).toBe(false);
    live = false;
    send();
    expect(postMessage).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
  send();
  expect(postMessage).toHaveBeenCalledTimes(2);
});
