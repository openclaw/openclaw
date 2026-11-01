/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../../components/session-panel-toggle-buffer.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneView } from "./chat-pane.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

it("replays an initial panel intent through its Solid pane and retires delivery on removal", async () => {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = "agent:main:panel-delivery";
  const toggle = (open: boolean, environmentId?: string) =>
    new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
      detail: { open, sessionKey, ...(environmentId ? { environmentId } : {}) },
    });
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: "panel-delivery", updatedAt: 1 },
  ]);
  const snapshot = fixture.context.gateway.snapshot;
  snapshot.hello = gatewayHelloForMethods([
    ...(snapshot.hello?.features?.methods ?? []),
    "desktop.observe",
    "environments.list",
    "environments.status",
  ]);
  const client = expectDefined(snapshot.client, "native pane Gateway client");
  const originalRequest = client.request.bind(client);
  const request = createGatewayRequestMock(async (method, ...args) => {
    if (method === "environments.status") {
      return { id: "requested-desktop", type: "worker", status: "available", desktop: true };
    }
    if (method === "desktop.observe") {
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=synthetic",
        expiresAtMs: 60_000,
        control: false,
        auth: "vnc-password",
      };
    }
    return originalRequest(method, ...args);
  });
  const testClient = createTestGatewayClient(request);
  client.request = testClient.request.bind(testClient);
  onTestFinished(() => {
    client.request = originalRequest;
  });
  const expectDesktopRequests = (environmentId: string, called: boolean) => {
    const assertion = called ? expect(request) : expect(request).not;
    assertion.toHaveBeenCalledWith("environments.status", { environmentId });
    assertion.toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId },
      control: false,
    });
  };
  rememberSessionPanelToggle("desktop", toggle(true, "requested-desktop"));
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const query = (selector: string) => container.querySelector(selector);
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView paneId="panel-delivery" sessionKey={sessionKey} active />
      </ApplicationProvider>
    ),
    { container },
  );
  await waitForSolid(() => expect(query(".agent-chat__composer-combobox textarea")).not.toBeNull());
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expectDesktopRequests("requested-desktop", true);
    expect(query(".desktop-credentials input[type='password']")).not.toBeNull();
  });
  window.dispatchEvent(toggle(false));
  await waitForSolid(() => expect(query("openclaw-desktop-panel")).toBeNull());

  view.unmount();
  request.mockClear();
  window.dispatchEvent(toggle(true, "retired-desktop"));
  await vi.dynamicImportSettled();
  expectDesktopRequests("retired-desktop", false);
});
