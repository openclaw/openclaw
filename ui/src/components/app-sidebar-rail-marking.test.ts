/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../plugins/control-ui-contributions.solid.tsx";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

it.each([
  ["path", [], []],
  ["path", ["plugin:workboard/board-b1"], ["plugin:workboard/board-b1"]],
  ["path", ["plugin:workboard/workboard"], ["plugin:workboard/workboard"]],
  [
    "path",
    ["plugin:workboard/workboard", "plugin:workboard/board-b1"],
    ["plugin:workboard/board-b1"],
  ],
  ["path", ["plugin:workboard/board-b2"], []],
  ["query", ["plugin:workboard/workboard"], ["plugin:workboard/workboard"]],
  [
    "query",
    ["plugin:workboard/workboard", "plugin:workboard/board-b1"],
    ["plugin:workboard/board-b1"],
  ],
] as const)("marks one rail item (%s, pins %j)", async (address, pins, marked) => {
  const moreMarked = marked.length === 0;
  // A board's own page is open; only the rail item that shows it is marked.
  const original = window.location.href;
  onTestFinished(() => window.history.replaceState(null, "", original));
  window.history.replaceState(
    null,
    "",
    address === "query" ? "/workboard?board=b1&filter=mine" : "/workboard/b1",
  );
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ selfUser: { id: "self", name: "Self" } });
  const context = createContext(gateway.gateway, createSessionsHarness("main", []).sessions);
  const host = {
    navigation: {
      pageHref: ({ params }: { params?: Record<string, string> }) =>
        params?.board
          ? address === "query"
            ? `/workboard?board=${params.board}`
            : `/workboard/${params.board}`
          : "/workboard",
    },
  };
  const item = (id: string, board?: string) => ({
    key: `workboard/${id}`,
    pluginId: "workboard",
    signal: new AbortController().signal,
    host,
    value: {
      id,
      label: id,
      page: { id: "workboard", ...(board ? { params: { board } } : {}) },
      ...(board ? { parent: "workboard" } : {}),
    },
  });
  const entries = [item("workboard"), item("board-b1", "b1"), item("board-b2", "b2")];
  Object.assign(context.plugins, {
    registrations: (kind: string) => (kind === "navigation" ? entries : []),
  });
  const { sidebar } = await mountSidebarContext(context);
  Object.assign(sidebar, {
    connected: true,
    activeRouteId: "workboard",
    activePluginTabId: "workboard/workboard",
    sidebarEntries: pins,
  });
  await sidebar.updateComplete;
  await waitForSolid(() =>
    expect(sidebar.querySelector("[data-rail-more]")?.classList.contains("nav-item--active")).toBe(
      moreMarked,
    ),
  );
  const markedPins = () =>
    [...sidebar.querySelectorAll(".sidebar-rail [data-sidebar-entry]")]
      .filter((pin) => pin.querySelector('a[aria-current="page"]'))
      .map((pin) => pin.getAttribute("data-sidebar-entry"));
  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(markedPins()).toEqual(marked));
});
