/* @vitest-environment jsdom */
import { assert, expect, it, vi } from "vitest";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BrowserDocumentContent } from "./browser-document.tsx";
import type { BrowserPanelInputs } from "./browser-panel.ts";

// mock-isolation: The document owns connection feedback and the panel's tab scope, not input.
vi.mock("./browser-panel.ts", () => ({
  BrowserPanelHost: (props: BrowserPanelInputs) => (
    <openclaw-browser-panel data-references={JSON.stringify(props.sessionTabs)} />
  ),
}));

it("references its fixed tab while connection feedback follows the Gateway", async () => {
  const owner = createGatewayHarness(createTestGatewayClient(async () => ({})));
  const hello = owner.gateway.snapshot.hello;
  assert(hello);
  owner.publish({ phase: "connecting", hello: null });
  const tab = { target: "host", profile: "work", targetId: "startup-tab" } as const;
  const value = {
    context: createContext(owner.gateway, createSessions("main", [])),
    target: { kind: "browser", sessionKey: "agent:main:work", tab } as const,
    renderEscape: () => null,
  };
  const view = mountSolid(() => <BrowserDocumentContent value={value} />);
  const references = () =>
    view.container.querySelector("openclaw-browser-panel")?.getAttribute("data-references");
  expect.soft(JSON.parse(references() ?? "null")).toEqual([tab]);
  const unavailable =
    "Browser control is unavailable for this connection. Reconnect with browser access.";
  expect(view.queryByText(unavailable)).toBeNull();
  owner.publish({
    phase: "connected",
    hello: { ...hello, features: { methods: [] }, auth: { role: "operator", scopes: [] } },
  });
  await waitForSolid(() => expect(view.getByText(unavailable)).toBeTruthy());
  expect.soft(JSON.parse(references() ?? "null")).toEqual([tab]);
  owner.publish({ phase: "reconnecting" });
  await waitForSolid(() => expect(view.queryByText(unavailable)).toBeNull());
});
