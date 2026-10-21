/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { i18n } from "../i18n/lib/translate.ts";
import { createSessionsListResult } from "../test-helpers/chat-model.ts";
import { updatePersonActivityCard } from "./person-activity-card.tsx";
import type { PersonActivityData } from "./person-activity-data.ts";

let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", function () {
    return { observe() {}, unobserve() {}, disconnect() {} };
  });
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  updatePersonActivityCard(container);
  container.remove();
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
    createdActor: { type: "human", id: "alice", identity: alice.identity },
  };
}
function data(sessions: GatewaySessionRow[]): PersonActivityData {
  return {
    sessionsResult: {
      ...createSessionsListResult({ defaultsModel: null }),
      sessions,
      count: sessions.length,
    },
    presencePayload: undefined,
  };
}
type Input = Extract<
  NonNullable<Parameters<typeof updatePersonActivityCard>[1]>,
  { user: unknown }
>;
function show(overrides: Partial<Input> = {}) {
  updatePersonActivityCard(container, {
    user: alice,
    sessionData: undefined,
    watchAgentId: "main",
    mainKey: "main",
    globalScope: false,
    routing: { basePath: "/ui", navigate: vi.fn() },
    openSession: vi.fn(),
    ...overrides,
  });
}
const card = (part: string) => container.querySelector(`.person-activity-card__${part}`);
const links = () => [
  ...container.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"),
];

it("retains recent selection and focused nodes while fresh roster facts update", () => {
  const initial = ["one", "two", "three", "four"].map((key, index) => session(key, 3 - index));
  const openSession = vi.fn();
  const refresh = (sessionData?: PersonActivityData) => show({ sessionData, openSession });
  refresh();
  expect(links()).toHaveLength(0);
  // The portal must outlive the caller's render scope.
  const disposeCaller = createRoot((dispose) => {
    updatePersonActivityCard(container);
    refresh(data(initial));
    return dispose;
  });
  flush();
  expect(links().map((link) => link.textContent)).toEqual(
    ["one", "two", "three"].map((name) => expect.stringContaining(name)),
  );
  const focused = links()[1]!;
  const title = focused.querySelector(".person-activity-card__session-name")!;
  focused.focus();
  disposeCaller();
  refresh(data([{ ...initial[1]!, label: "two updated", updatedAt: 4 }, initial[2]!, initial[3]!]));
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
    { pathname: "/ui/chat/main/two" },
  );
  expect(links().some((link) => link.textContent?.includes("four"))).toBe(false);
});

it("exposes activity navigation while presence is offline", () => {
  const navigate = vi.fn();
  show({
    user: { ...alice, entries: [] },
    sessionData: data([session("one", 1)]),
    routing: { basePath: "/ui", navigate },
  });
  expect(card("status")?.textContent).toContain("Offline");
  expect(card("facts")).toBeNull();
  const link = getQueriesForElement(container).getByRole("link", { name: "View activity" });
  const modifiedClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  link.dispatchEvent(modifiedClick);
  expect(modifiedClick.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(navigate).toHaveBeenCalledWith("alice", "Alice");
});

it("localizes connection and session labels without replacing the focused link", async () => {
  const restoreI18n = captureI18nStateForTesting();
  try {
    await i18n.setLocale("en");
    show({
      user: { ...alice, entries: [{ mode: "webchat", ts: 1 }] },
      sessionData: data([{ ...session("cron:daily-check", 1), label: "Daily check" }]),
    });
    flush();
    const link = links()[0]!;
    const labels = () => [card("facts dd > span")?.textContent, card("session-name")?.textContent];
    expect(labels()).toEqual(["Web app", "Automation: Daily check"]);
    link.focus();
    for (const [locale, connection, title] of [
      ["de", "Web-App", "Automatisierung: Daily check"],
      ["en", "Web app", "Automation: Daily check"],
    ] as const) {
      await i18n.setLocale(locale);
      flush();
      expect(labels()).toEqual([connection, title]);
      expect(links()[0]).toBe(link);
      expect(document.activeElement).toBe(link);
    }
  } finally {
    updatePersonActivityCard(container);
    await restoreI18n();
    flush();
  }
});
