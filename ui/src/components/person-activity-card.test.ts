/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { i18n } from "../i18n/lib/translate.ts";
import { createSessionsListResult } from "../test-helpers/chat-model.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
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
function input(overrides: Partial<Input> = {}): Input {
  return {
    user: alice,
    sessionData: undefined,
    watchAgentId: "main",
    mainKey: "main",
    globalScope: false,
    routing: { basePath: "/ui", navigate: vi.fn() },
    openSession: vi.fn(),
    ...overrides,
  };
}
function show(overrides: Partial<Input> = {}) {
  updatePersonActivityCard(container, input(overrides));
}
const card = (part: string) => container.querySelector(`.person-activity-card__${part}`);
const links = () => [
  ...container.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"),
];

it("retains loaded selection and focused nodes across pending roster refreshes", async () => {
  const initial = ["one", "two", "three", "four"].map((key, index) => session(key, 3 - index));
  const openSession = vi.fn();
  show();
  expect(links()).toHaveLength(0);
  const first = Promise.withResolvers<Input>();
  const disposeCaller = createRoot((dispose) => {
    updatePersonActivityCard(container);
    updatePersonActivityCard(container, { name: "Alice", read: first.promise });
    return dispose;
  });
  flush();
  expect(getQueriesForElement(container).getByRole("status").textContent).toBe("Loading…");
  expect(container.getAttribute("aria-label")).toBe("Activity for Alice");
  first.resolve(input({ sessionData: data(initial), openSession }));
  await waitForSolid(() => expect(links()).toHaveLength(3));
  expect(links().map((link) => link.textContent)).toEqual(
    ["one", "two", "three"].map((name) => expect.stringContaining(name)),
  );
  const loaded = container.querySelector(".person-activity-card");
  const focused = links()[1]!;
  const title = focused.querySelector(".person-activity-card__session-name")!;
  focused.focus();
  disposeCaller();
  const refresh = Promise.withResolvers<Input>();
  updatePersonActivityCard(container, { name: "Alice", read: refresh.promise });
  flush();
  expect(container.querySelector(".person-activity-card")).toBe(loaded);
  expect(links()[1]).toBe(focused);
  expect(document.activeElement).toBe(focused);
  refresh.resolve(
    input({
      sessionData: data([
        { ...initial[1]!, label: "two updated", updatedAt: 4 },
        initial[2]!,
        initial[3]!,
      ]),
      openSession,
    }),
  );
  await waitForSolid(() => expect(focused.textContent).toContain("two updated"));
  expect(container.querySelector(".person-activity-card")).toBe(loaded);
  expect(links()).toHaveLength(2);
  expect(links()[0]).toBe(focused);
  expect(focused.querySelector(".person-activity-card__session-name")).toBe(title);
  expect(document.activeElement).toBe(focused);
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

it("replaces a failed read without retaining its error or accepting an obsolete result", async () => {
  const failed = Promise.withResolvers<Input>();
  updatePersonActivityCard(container, { name: "Alice", read: failed.promise });
  failed.reject(new Error("Unavailable"));
  await waitForSolid(() =>
    expect(getQueriesForElement(container).getByRole("status").textContent).toBe(
      "Could not load people. Try again.",
    ),
  );

  const obsolete = Promise.withResolvers<Input>();
  updatePersonActivityCard(container, { name: "Alice", read: obsolete.promise });
  flush();
  const current = Promise.withResolvers<Input>();
  updatePersonActivityCard(container, { name: "Bob", read: current.promise });
  flush();
  current.resolve(input({ user: { ...alice, id: "bob", name: "Bob" } }));
  await waitForSolid(() => expect(container.getAttribute("aria-label")).toBe("Activity for Bob"));
  obsolete.resolve(input());
  await obsolete.promise;
  flush();
  expect(container.getAttribute("aria-label")).toBe("Activity for Bob");
  expect(container.querySelector(".person-activity-card")).not.toBeNull();
  expect(getQueriesForElement(container).queryByRole("status")).toBeNull();
});

it("exposes the activity link while presence is offline", () => {
  show({
    user: { ...alice, entries: [] },
    sessionData: data([session("one", 1)]),
  });
  expect(card("status")?.textContent).toContain("Offline");
  expect(card("facts")).toBeNull();
  const link = getQueriesForElement(container).getByRole("link", { name: "View activity" });
  expect(link.getAttribute("href")).toBe("/ui/activity/alice");
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
