/* @vitest-environment jsdom */
import { assert, expect, it, vi } from "vitest";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BrowserDocumentContent } from "./browser-document.tsx";

// mock-isolation: The document owns connection feedback; browser input is an opaque child.
vi.mock("./browser-panel.ts", () => ({
  BrowserPanelHost: () => document.createElement("openclaw-browser-panel"),
}));
registerEnglishCatalog(registerBrowserEnglish);

it("shows browser access feedback when the Gateway connects after the document mounts", async () => {
  const owner = createGatewayHarness(createTestGatewayClient(async () => ({})));
  const hello = owner.gateway.snapshot.hello;
  assert(hello);
  owner.publish({ phase: "connecting", hello: null });
  const context = createContext(owner.gateway, createSessions("main", []));
  const view = mountSolid(() => (
    <BrowserDocumentContent
      value={{
        context,
        target: {
          kind: "browser",
          sessionKey: "agent:main:work",
          tab: { target: "host", profile: "work", targetId: "existing" },
        },
        renderEscape: () => null,
      }}
    />
  ));
  const unavailable =
    "Browser control is unavailable for this connection. Reconnect with browser access.";
  expect(view.queryByText(unavailable)).toBeNull();
  owner.publish({
    phase: "connected",
    hello: { ...hello, features: { methods: [] }, auth: { role: "operator", scopes: [] } },
  });
  await waitForSolid(() => expect(view.getByText(unavailable)).toBeTruthy());
  owner.publish({ phase: "reconnecting" });
  await waitForSolid(() => expect(view.queryByText(unavailable)).toBeNull());
});
