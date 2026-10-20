import { createSignal, Show } from "solid-js";
import { describe, expect, it } from "vitest";
import { createApplicationConfigCapability } from "../app/config.ts";
import { createGatewayStoreTestStore } from "../app/gateway-store.test-support.ts";
import { ShellLayoutOwner } from "../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../app/shell-layout-traits-solid.tsx";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import { createNavigationPreferencesFixture } from "../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { ActivityPage } from "./activity/activity-page.ts";
import { pageContext } from "./agents/agents-page.test-support.ts";
import { AgentsPage } from "./agents/agents-page.tsx";

describe("native session pages", () => {
  it.each(["agents", "activity"] as const)(
    "%s retains its host and releases inherited shell layout traits on unmount",
    async (page) => {
      const { gateway } = createGatewayStoreTestStore();
      const agents = createAgentCapability(gateway);
      const channels = createChannelCapability(gateway);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const sessions = createTestSessionCapability(gateway);
      const context = Object.assign(pageContext(gateway, agents, { sessions }), {
        basePath: "",
        config: createApplicationConfigCapability({ resourceBasePath: "" }),
        channels,
        runtimeConfig,
        navigation: createNavigationPreferencesFixture(),
      });
      const provider = createSolidApplicationContextProvider(context);
      const content = document.createElement("main");
      content.className = "content";
      document.body.append(content);
      const layout = new ShellLayoutOwner();
      layout.contentRef(content);
      const [visible, setVisible] = createSignal(true);
      const mounted = mountSolid(
        () => (
          <ShellLayoutProvider value={{ owner: layout, host: content }}>
            <Show when={visible()}>
              {page === "agents" ? (
                <AgentsPage />
              ) : (
                <ActivityPage
                  routeLocation={{ pathname: "/activity", search: "?view=live", hash: "" }}
                />
              )}
            </Show>
          </ShellLayoutProvider>
        ),
        { container: content, wrapper: provider.wrapper },
      );
      try {
        await waitForSolid(() =>
          expect(content.classList.contains("content--toolbar-header")).toBe(true),
        );
        const host = content.querySelector(`openclaw-${page}-page`);
        expect(host).not.toBeNull();
        expect(host?.querySelector(".content-header")).not.toBeNull();
        expect(content.classList.contains("content--toolbar-header")).toBe(true);
        expect(content.classList.contains("content--settings-workspace")).toBe(true);
        if (page === "activity") {
          expect(content.classList.contains("content--activity-page")).toBe(true);
          expect(host?.querySelector("#activity-live-panel")).not.toBeNull();
        }
        setVisible(false);
        await waitForSolid(() => expect(content.querySelector(`openclaw-${page}-page`)).toBeNull());
        expect(content.className).toBe("content");
      } finally {
        mounted.unmount();
        sessions.dispose();
        agents.dispose();
        channels.dispose();
        runtimeConfig.dispose();
        gateway.stop();
        content.remove();
      }
    },
  );
});
