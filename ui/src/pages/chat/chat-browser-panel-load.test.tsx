/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { sidebarPanelFixtureParams } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { preserveDocumentStyle } from "../../test-helpers/preserve-document-style.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { SidebarPanelLauncher } from "./components/chat-sidebar-region-header.tsx";

afterEach(cleanupSolid);

it.each(["pointerenter", "focus", "click"])(
  "starts just the scoped tab read on %s",
  async (event) => {
    preserveDocumentStyle();
    const request = vi.fn(async () => ({ running: true, tabs: [] }));
    const { state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
    });
    state.browserPanelAvailable = true;
    state.hello = gatewayHelloForMethods(["browser.request"]);
    const definitions = sidebarPanelDefinitions(sidebarPanelFixtureParams(state));
    const open = vi.fn();
    const view = mountSolid(() => <SidebarPanelLauncher definitions={definitions} onOpen={open} />);
    const option = view.getByRole("button", { name: /Browser/ });
    request.mockClear();
    option.dispatchEvent(new Event(event, { bubbles: true }));
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledExactlyOnceWith("browser.request", {
        method: "GET",
        path: "/tabs",
        tabScope: { sessionKey: state.sessionKey, referencedTabs: [] },
      });
    });
    if (event !== "click") {
      expect(open).not.toHaveBeenCalled();
      option.click();
      expect(request).toHaveBeenCalledTimes(1);
    }
    expect(open).toHaveBeenCalledExactlyOnceWith("browser");
  },
);
