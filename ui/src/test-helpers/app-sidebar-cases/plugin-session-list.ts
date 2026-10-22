import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiReplacement } from "../../../../src/plugin-sdk/control-ui.js";
import type { GatewaySessionRow as Row } from "../../api/types.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import { createControlUiPluginHost } from "../../plugins/control-ui-host.ts";
import {
  type ControlUiPluginOwner,
  ControlUiPluginRuntime,
} from "../../plugins/control-ui-runtime.ts";
import * as S from "../app-sidebar.ts";
import { createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import { mountSidebarFixture, sessionList } from "./compact.test-support.ts";
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
  const replacement: ControlUiReplacement<"session-list"> = {
    id: "sessions",
    label: "Sessions",
    surface: "session-list",
    mount(container, initial) {
      const rows = div(container, { pluginReplacement: "sessions" });
      const update = ({ props }: typeof initial) => {
        rows.replaceChildren();
        for (const session of props.sessions) {
          div(rows, { pluginSessionKey: session.key }, session.label ?? session.key);
        }
      };
      update(initial);
      return { update, dispose: delegates ? initial.mountDefault(div(container)) : () => {} };
    },
  };
  vi.spyOn(context.plugins, "selectedReplacement").mockImplementation((surface) =>
    surface === "session-list"
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
  const keys = () =>
    Array.from(
      sidebar.querySelectorAll<HTMLElement>("[data-plugin-session-key]"),
      (row) => row.dataset.pluginSessionKey,
    );
  await settleRoster(sidebar);
  await vi.waitFor(() => expect(keys()).toEqual(initialKeys));
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
});

const rowSelector = (key: string) => `[data-session-key="${key}"]`;

it("shows categorized dashboard children on a cold sidebar without their parent", async () => {
  const office = "agent:main:dashboard:office-ha";
  const wake = "agent:main:dashboard:wake-word";
  const archived = "agent:main:dashboard:archived";
  const parent = "agent:main:discord:channel:parent";
  const h = S.createSessionsHarness("main", [office, wake, archived]);
  const rows = h.sessions.state.result!.sessions;
  rows.forEach((row, index) =>
    Object.assign(row, {
      category: "HOME ASSISTANT",
      archived: index === 2,
    }),
  );
  Object.assign(rows[0]!, {
    spawnedBy: parent,
    parentSessionKey: parent,
    createdVia: "spawn",
    createdActor: { type: "agent" },
  });
  h.publish({ groups: ["HOME ASSISTANT"] });
  const { q, update } = await mountSidebarFixture(undefined, h.sessions);
  await update({ sessionKey: wake });
  const group = q('[data-session-section="category:HOME ASSISTANT"]');
  expect(group?.querySelectorAll(rowSelector(office))).toHaveLength(1);
  expect(group?.querySelectorAll(rowSelector(wake))).toHaveLength(1);
  expect(q(rowSelector(archived))).toBeNull();
  expect(q(rowSelector(parent))).toBeNull();
});

it("promotes cached categorized children and lets current rows replace their placement", async () => {
  const parentKey = "agent:main:parent";
  const categorized = "agent:main:cached-categorized-child";
  const ordinary = "agent:main:dashboard:cached-child";
  const archived = "agent:main:cached-archived-child";
  const h = S.createSessionsHarness("main", [parentKey]);
  const result = h.sessions.state.result!;
  const parent = result.sessions[0]!;
  parent.childSessions = [categorized, ordinary, archived];
  const child = (key: string, updatedAt: number, extra: Partial<Row> = {}) => ({
    key,
    updatedAt,
    ...extra,
    kind: "direct" as const,
    spawnedBy: parentKey,
  });
  h.list.mockResolvedValue(
    sessionList(
      [
        child(categorized, 3, { category: "Research", label: "Cached child" }),
        child(ordinary, 2),
        child(archived, 1, { category: "Research", archived: true }),
      ],
      1,
    ),
  );
  h.publish({ groups: ["Research"] });
  const { sidebar, q } = await mountSidebarFixture(undefined, h.sessions);
  const tree = `[data-session-tree="${parentKey}"]`;
  const group = '[data-session-section="category:Research"]';
  const rows = (key: string, scope = "") =>
    sidebar.querySelectorAll(`${scope} ${rowSelector(key)}`);
  const ordinaryChild = () => q(`${tree} ${rowSelector(ordinary)}`);
  q<HTMLButtonElement>("[data-child-session-toggle]")?.click();
  await waitForFast(() => expect(h.list).toHaveBeenCalledOnce());
  await waitForFast(() => expect(rows(categorized, group)).toHaveLength(1));
  expect(ordinaryChild()).not.toBeNull();
  expect(q(rowSelector(archived))).toBeNull();
  h.publishList({
    result: {
      ...result,
      count: 2,
      sessions: [parent, child(categorized, 4, { label: "Current child" })],
    },
  });
  await waitForFast(() => {
    const current = rows(categorized);
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Current child");
    expect(current[0]?.closest(tree)).not.toBeNull();
  });
  expect(sidebar.textContent).not.toContain("Cached child");
  expect(rows(categorized, group)).toHaveLength(0);
  expect(ordinaryChild()).not.toBeNull();
  expect(q(rowSelector(archived))).toBeNull();
});
