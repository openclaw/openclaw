import { describe, expect, it, vi } from "vitest";
import type {
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../../src/plugin-sdk/control-ui.js";
import { createControlUiPluginHost } from "../../plugins/control-ui-host.ts";
import {
  type ControlUiPluginOwner,
  ControlUiPluginRuntime,
} from "../../plugins/control-ui-runtime.ts";
import {
  createContext,
  createGateway,
  createSessionsHarness,
  createSessionState,
  mountSidebarContext,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { toggleRoster } from "./roster.test-support.ts";
import "../../components/app-sidebar.ts";
import "../../plugins/control-ui-view.runtime.ts";

describe("AppSidebar session-list replacement", () => {
  it("keeps host sessions current across chip and team modes without mounting the built-in list", async () => {
    const client = createTestGatewayClient(async () => ({}));
    const sessions = createSessionsHarness("main", ["agent:main:main", "agent:main:first"]);
    const context = createContext(createGateway(client), sessions.sessions, TWO_AGENTS);
    const runtime = new ControlUiPluginRuntime(() => context);
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor: {
        pluginId: "session-list-fixture",
        name: "Session list fixture",
        revision: "one",
        entryUrl: "/fixture.js",
        styles: [],
      },
      client,
      abort: new AbortController(),
      disposers: new Set(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        accessories: new Map(),
        widgets: new Map(),
        replacements: new Map(),
      },
      selections: new Map(),
    };
    runtime.start();
    const host = createControlUiPluginHost(() => context, runtime, owner);
    const replacement: ControlUiReplacement<"session-list"> = {
      id: "sessions",
      label: "Sessions",
      surface: "session-list",
      mount(container, initial) {
        const update = ({ props }: ControlUiViewContext<ControlUiSurfaceProps["session-list"]>) => {
          container.replaceChildren(
            ...props.sessions.map((session) => {
              const row = document.createElement("div");
              row.dataset.pluginSessionKey = session.key;
              row.textContent = session.label ?? session.key;
              return row;
            }),
          );
        };
        update(initial);
        return { update };
      },
    };
    vi.spyOn(context.plugins, "selectedReplacement").mockImplementation((surface) =>
      surface === "session-list"
        ? {
            key: "session-list-fixture/sessions",
            pluginId: "session-list-fixture",
            value: replacement,
            host,
            signal: owner.abort.signal,
          }
        : undefined,
    );
    try {
      const { sidebar } = await mountSidebarContext(context);
      const keys = () =>
        [...sidebar.querySelectorAll<HTMLElement>("[data-plugin-session-key]")].map(
          (row) => row.dataset.pluginSessionKey,
        );
      await vi.waitFor(() => expect(keys()).toEqual(["agent:main:main", "agent:main:first"]));
      await toggleRoster(sidebar);
      await vi.waitFor(() =>
        expect(sidebar.querySelector(".sidebar-workspace-header")).not.toBeNull(),
      );
      expect(keys()).toEqual(["agent:main:main", "agent:main:first"]);
      expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();

      sessions.publishList(createSessionState("main", ["agent:main:main", "agent:main:next"]));
      await vi.waitFor(() => expect(keys()).toEqual(["agent:main:main", "agent:main:next"]));
      await toggleRoster(sidebar);
      await vi.waitFor(() =>
        expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull(),
      );
      expect(keys()).toEqual(["agent:main:main", "agent:main:next"]);
    } finally {
      owner.abort.abort();
      runtime.dispose();
    }
  });
});
