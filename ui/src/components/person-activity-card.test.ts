/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { updatePersonActivityCard } from "./person-activity-card.ts";
import type { PersonActivityData } from "./person-activity-data.ts";

const containers: HTMLElement[] = [];
function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}
afterEach(() => {
  for (const container of containers.splice(0)) {
    updatePersonActivityCard(container);
    container.remove();
  }
});

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
  const openSession = vi.fn();
  const container = createContainer();
  const show = (sessionData?: PersonActivityData) =>
    updatePersonActivityCard(container, {
      user: alice,
      sessionData,
      watchAgentId: "main",
      mainKey: "main",
      globalScope: false,
      routing: { basePath: "/ui", navigate: vi.fn() },
      openSession,
    });
  show();
  expect(container.querySelectorAll(".person-activity-card__session")).toHaveLength(0);
  show(data(initial));
  const links = () => [
    ...container.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"),
  ];
  expect(links().map((link) => link.textContent)).toEqual([
    expect.stringContaining("one"),
    expect.stringContaining("two"),
    expect.stringContaining("three"),
  ]);
  const focused = links()[1]!;
  focused.focus();
  show(data([{ ...initial[1]!, label: "two updated", updatedAt: 4 }, initial[2]!, initial[3]!]));
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
  const container = createContainer();
  updatePersonActivityCard(container, {
    user: { ...alice, entries: [] },
    sessionData: data([session("one", 1)]),
    watchAgentId: "main",
    mainKey: "main",
    globalScope: false,
    routing: { basePath: "/ui", navigate },
    openSession,
  });
  expect(container.querySelector(".person-activity-card__status")?.textContent).toContain(
    "Offline",
  );
  expect(container.querySelector(".person-activity-card__facts")).toBeNull();
  const link = getQueriesForElement(container).getByRole("link", { name: "View activity" });
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  link.dispatchEvent(modified);
  expect(modified.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(navigate).toHaveBeenCalledWith("alice", "Alice");
});
