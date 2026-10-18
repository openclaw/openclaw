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
import "../../components/app-sidebar.tsx";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

describe("AppSidebar session-list replacement", () => {
  it.each([false, true])(
    "keeps host sessions current across modes (delegates built-in: %s)",
    async (delegates) => {
      const client = createTestGatewayClient(async () => ({}));
      const sessions = createSessionsHarness("main", ["agent:main:main", "agent:main:first"]);
      const context = createContext(createGateway(client), sessions.sessions, TWO_AGENTS);
      const reportError = vi.fn();
      Object.assign(context.plugins, { reportError });
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
          const rows = document.createElement("div");
          container.append(rows);
          const update = ({
            props,
          }: ControlUiViewContext<ControlUiSurfaceProps["session-list"]>) => {
            rows.replaceChildren(
              ...props.sessions.map((session) => {
                const row = document.createElement("div");
                row.dataset.pluginSessionKey = session.key;
                row.textContent = session.label ?? session.key;
                return row;
              }),
            );
          };
          update(initial);
          let stopDefault: (() => void) | undefined;
          if (delegates) {
            const target = document.createElement("div");
            container.append(target);
            stopDefault = initial.mountDefault(target);
          }
          return { update, dispose: () => stopDefault?.() };
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
        expect(reportError).not.toHaveBeenCalled();
        const keys = () =>
          [...sidebar.querySelectorAll<HTMLElement>("[data-plugin-session-key]")].map(
            (row) => row.dataset.pluginSessionKey,
          );
        await vi.waitFor(() => expect(keys()).toEqual(["agent:main:main", "agent:main:first"]));
        await toggleRoster(sidebar);
        await vi.waitFor(() =>
          expect(sidebar.querySelector(".sidebar-session-toolbar")).not.toBeNull(),
        );
        expect(keys()).toEqual(["agent:main:main", "agent:main:first"]);
        await vi.waitFor(() =>
          expect(Boolean(sidebar.querySelector(".sidebar-agent-roster"))).toBe(delegates),
        );

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
    },
  );
});
