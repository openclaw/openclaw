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
  const requestClient = createTestGatewayClient(request);
  client.request = requestClient.request.bind(requestClient);
  onTestFinished(() => {
    client.request = originalRequest;
  });
  rememberSessionPanelToggle(
    "desktop",
    new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
      detail: { open: true, environmentId: "requested-desktop", sessionKey },
    }),
  );
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView paneId="panel-delivery" sessionKey={sessionKey} active />
      </ApplicationProvider>
    ),
    { container },
  );
  await waitForSolid(() => {
    expect(view.container.querySelector(".agent-chat__composer-combobox textarea")).not.toBeNull();
  });
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith("environments.status", {
      environmentId: "requested-desktop",
    });
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: "requested-desktop" },
      control: false,
    });
    expect(
      view.container.querySelector(".desktop-credentials input[type='password']"),
    ).not.toBeNull();
  });
  window.dispatchEvent(
    new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: false, sessionKey } }),
  );
  await waitForSolid(() => {
    expect(view.container.querySelector("openclaw-desktop-panel")).toBeNull();
  });

  view.unmount();
  request.mockClear();
  window.dispatchEvent(
    new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, {
      detail: { open: true, environmentId: "retired-desktop", sessionKey },
    }),
  );
  await vi.dynamicImportSettled();
  expect(request).not.toHaveBeenCalledWith("environments.status", {
    environmentId: "retired-desktop",
  });
  expect(request).not.toHaveBeenCalledWith("desktop.observe", {
    source: { kind: "environment", environmentId: "retired-desktop" },
    control: false,
  });
});
