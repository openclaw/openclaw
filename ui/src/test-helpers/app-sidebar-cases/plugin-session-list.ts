import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiReplacement } from "../../../../src/plugin-sdk/control-ui.js";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import { getAppSidebarOwner } from "../../components/app-sidebar.tsx";
import { createControlUiPluginHost } from "../../plugins/control-ui-host.ts";
import {
  type ControlUiPluginOwner,
  ControlUiPluginRuntime,
} from "../../plugins/control-ui-runtime.ts";
import * as S from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { patchRows, settleRoster, toggleRoster } from "./roster.test-support.ts";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

function div(parent: HTMLElement, data: Record<string, string> = {}, text = "") {
  const element = document.createElement("div");
  Object.assign(element.dataset, data);
  element.textContent = text;
  parent.append(element);
  return element;
}

it.each([false, true])("AppSidebar replacement sessions (delegates: %s)", async (delegates) => {
  const client = createTestGatewayClient(async () => ({}));
  const initialKeys = ["agent:main:main", "agent:main:first"];
  const nextKeys = ["agent:main:main", "agent:main:next"];
  const sessions = S.createSessionsHarness("main", initialKeys);
  const context = S.createContext(S.createGateway(client), sessions.sessions, S.TWO_AGENTS);
  const reportError = vi.fn();
  Object.assign(context.plugins, { reportError });
  const pluginListeners = new Set<() => void>();
  vi.spyOn(context.plugins, "subscribe").mockImplementation((listener) => {
    pluginListeners.add(listener);
    return () => pluginListeners.delete(listener);
  });
  const runtime = new ControlUiPluginRuntime(() => context);
  const owner: Omit<ControlUiPluginOwner, "host"> = {
    descriptor: { pluginId: "f", name: "F", revision: "1", entryUrl: "/f.js", styles: [] },
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
  onTestFinished(() => {
    owner.abort.abort();
    runtime.dispose();
  });
  const host = createControlUiPluginHost(() => context, runtime, owner);
  const createReplacement = (id: string): ControlUiReplacement<"session-list"> => ({
    id,
    label: "Sessions",
    surface: "session-list",
    mount(container, initial) {
      const rows = div(container, { pluginReplacement: id });
      const update = ({ props }: typeof initial) => {
        rows.replaceChildren();
        for (const session of props.sessions) {
          div(rows, { pluginSessionKey: session.key }, session.label ?? session.key);
        }
      };
      update(initial);
      return { update, dispose: delegates ? initial.mountDefault(div(container)) : () => {} };
    },
  });
  let replacement = createReplacement("sessions");
  let selected = false;
  vi.spyOn(context.plugins, "selectedReplacement").mockImplementation((surface) =>
    selected && surface === "session-list"
      ? {
          key: `f/${replacement.id}`,
          pluginId: "f",
          value: replacement,
          host,
          signal: owner.abort.signal,
        }
      : undefined,
  );
  const { sidebar } = await S.mountSidebarContext(context);
  const find = (selector: string) => sidebar.querySelector(selector);
  expect(reportError).not.toHaveBeenCalled();
  const keys = () =>
    Array.from(
      sidebar.querySelectorAll<HTMLElement>("[data-plugin-session-key]"),
      (row) => row.dataset.pluginSessionKey,
    );
  await settleRoster(sidebar);
  expect(keys()).toEqual([]);
  selected = true;
  pluginListeners.forEach((notify) => notify());
  await settleRoster(sidebar);
  await vi.waitFor(() => expect(keys()).toEqual(initialKeys));
  const firstReplacement = find('[data-plugin-replacement="sessions"]');
  expect(firstReplacement).not.toBeNull();
  const prepare = vi.spyOn(getAppSidebarOwner(sidebar.hostElement)!, "prepareRender");
  replacement = createReplacement("other-sessions");
  pluginListeners.forEach((notify) => notify());
  await settleRoster(sidebar);
  expect(find('[data-plugin-replacement="other-sessions"]')).not.toBeNull();
  await settleRoster(sidebar);
  expect(firstReplacement?.isConnected).toBe(false);
  expect(keys()).toEqual(initialKeys);
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  await toggleRoster(sidebar);
  await vi.waitFor(() => expect(find(".sidebar-session-toolbar")).not.toBeNull());
  expect(keys()).toEqual(initialKeys);
  await vi.waitFor(() => expect(Boolean(find(".sidebar-agent-roster"))).toBe(delegates));

  sessions.publishList(S.createSessionState("main", nextKeys));
  await vi.waitFor(() => expect(keys()).toEqual(nextKeys));
  await toggleRoster(sidebar);
  await vi.waitFor(() => expect(find(".sidebar-agent-card__main")).not.toBeNull());
  expect(keys()).toEqual(nextKeys);
  const wide = S.createSessionState("main", [
    "agent:main:main",
    ...Array.from({ length: SIDEBAR_SESSION_PAGE_SIZE + 3 }, (_, i) => `agent:main:work-${i}`),
  ]);
  wide.result!.sessions.forEach((row, index) => {
    row.updatedAt = 100 - index;
  });
  sessions.publishList(wide);
  await settleRoster(sidebar);
  const last = wide.result!.sessions.at(-1)!;
  expect(find(`[data-session-key="${last.key}"]`)).toBeNull();
  const lastPluginRow = () => find(`[data-plugin-session-key="${last.key}"]`);
  expect(lastPluginRow()).not.toBeNull();
  sessions.publishList({
    ...wide,
    result: {
      ...wide.result!,
      sessions: patchRows(wide.result!.sessions, last.key, { label: "Latest replacement row" }),
    },
  });
  await settleRoster(sidebar);
  expect(lastPluginRow()?.textContent).toBe("Latest replacement row");
  selected = false;
  pluginListeners.forEach((notify) => notify());
  await settleRoster(sidebar);
  expect(keys()).toEqual([]);
});
