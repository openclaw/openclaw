/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { PersonActivityCard } from "./person-activity-card-solid.tsx";
import type { PersonActivityData } from "./person-activity-data.ts";

const alice = {
  id: "alice",
  name: "Alice",
  identity: { type: "profile", id: "alice" } as const,
  watchedSessions: [],
};
function session(key: string, updatedAt: number): GatewaySessionRow {
  return {
    key: `agent:main:${key}`,
    label: key,
    kind: "direct",
    updatedAt,
    createdActor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
  };
}
function data(rows: GatewaySessionRow[]): PersonActivityData {
  return {
    sessionsResult: {
      sessions: rows,
      ts: 1,
      path: "",
      count: rows.length,
      defaults: { model: null, modelProvider: null, contextTokens: null },
    },
    presencePayload: undefined,
  };
}

it("retains the open card's recent selection and focused link while fresh roster facts update", () => {
  const initial = [session("one", 3), session("two", 2), session("three", 1), session("four", 0)];
  const [roster, setRoster] = createSignal<PersonActivityData>();
  const openSession = vi.fn();
  const view = mountSolid(() => (
    <PersonActivityCard
      user={alice}
      sessionData={roster()}
      watchAgentId="main"
      mainKey="main"
      globalScope={false}
      routing={{ basePath: "/ui", navigate: vi.fn() }}
      openSession={openSession}
    />
  ));
  expect(view.container.querySelectorAll(".person-activity-card__session")).toHaveLength(0);
  setRoster(data(initial));
  flush();
  const links = () => [
    ...view.container.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"),
  ];
  expect(links().map((link) => link.textContent)).toEqual([
    expect.stringContaining("one"),
    expect.stringContaining("two"),
    expect.stringContaining("three"),
  ]);
  const focused = links()[1]!;
  focused.focus();
  setRoster(
    data([{ ...initial[1]!, label: "two updated", updatedAt: 4 }, initial[2]!, initial[3]!]),
  );
  flush();
  expect(links()).toHaveLength(2);
  expect(links()[0]).toBe(focused);
  expect(document.activeElement).toBe(focused);
  expect(focused.textContent).toContain("two updated");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  focused.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(openSession).toHaveBeenCalledWith(
    expect.objectContaining({ key: "agent:main:two", label: "two updated" }),
    "main",
  );
  expect(links().some((link) => link.textContent?.includes("four"))).toBe(false);
});

it("keeps native modified-click navigation and exposes activity when presence is offline", () => {
  const navigate = vi.fn();
  const openSession = vi.fn();
  const view = mountSolid(() => (
    <PersonActivityCard
      user={{ ...alice, entries: [] }}
      sessionData={data([session("one", 1)])}
      watchAgentId="main"
      mainKey="main"
      globalScope={false}
      routing={{ basePath: "/ui", navigate }}
      openSession={openSession}
    />
  ));
  expect(view.container.querySelector(".person-activity-card__status")?.textContent).toContain(
    "Offline",
  );
  expect(view.container.querySelector(".person-activity-card__facts")).toBeNull();
  const link = view.getByRole("link", { name: "View activity" });
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  link.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(navigate).toHaveBeenCalledWith("alice", "Alice");
});
