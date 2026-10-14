/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { i18n } from "../i18n/lib/translate.ts";
import { updatePersonActivityCard } from "./person-activity-card.tsx";
import type { PersonActivityData } from "./person-activity-data.ts";

const containers: HTMLElement[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
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
  vi.unstubAllGlobals();
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
  // A portal retains its card after the caller's render scope is replaced.
  const disposeCaller = createRoot((dispose) => {
    updatePersonActivityCard(container);
    show(data(initial));
    return dispose;
  });
  flush();
  const links = () => [
    ...container.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"),
  ];
  expect(links().map((link) => link.textContent)).toEqual([
    expect.stringContaining("one"),
    expect.stringContaining("two"),
    expect.stringContaining("three"),
  ]);
  const focused = links()[1]!;
  const title = focused.querySelector(".person-activity-card__session-name")!;
  focused.focus();
  disposeCaller();
  show(data([{ ...initial[1]!, label: "two updated", updatedAt: 4 }, initial[2]!, initial[3]!]));
  flush();
  expect(links()).toHaveLength(2);
  expect(links()[0]).toBe(focused);
  expect(focused.querySelector(".person-activity-card__session-name")).toBe(title);
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

it("updates localized connection and session labels without replacing the focused link", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const container = createContainer();
  try {
    await i18n.setLocale("en");
    updatePersonActivityCard(container, {
      user: { ...alice, entries: [{ mode: "webchat", ts: 1 }] },
      sessionData: data([{ ...session("cron:daily-check", 1), label: "Daily check" }]),
      watchAgentId: "main",
      mainKey: "main",
      globalScope: false,
      routing: { basePath: "/ui", navigate: vi.fn() },
      openSession: vi.fn(),
    });
    flush();
    const link = container.querySelector<HTMLAnchorElement>(".person-activity-card__session")!;
    const labels = () => [
      container.querySelector(".person-activity-card__facts dd > span")?.textContent,
      link.querySelector(".person-activity-card__session-name")?.textContent,
    ];
    expect(labels()).toEqual(["Web app", "Automation: Daily check"]);
    link.focus();
    await i18n.setLocale("de");
    flush();
    expect(labels()).toEqual(["Web-App", "Automatisierung: Daily check"]);
    expect(container.querySelector(".person-activity-card__session")).toBe(link);
    expect(document.activeElement).toBe(link);
    await i18n.setLocale("en");
    flush();
    expect(labels()).toEqual(["Web app", "Automation: Daily check"]);
    expect(container.querySelector(".person-activity-card__session")).toBe(link);
    expect(document.activeElement).toBe(link);
  } finally {
    updatePersonActivityCard(container);
    await restoreI18n();
    flush();
  }
});
