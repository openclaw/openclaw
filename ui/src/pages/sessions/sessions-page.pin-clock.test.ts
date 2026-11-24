/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  sessionRow,
} from "./sessions-page.test-support.ts";

const deadline = 100_000;
const target = sessionRow("target", { label: "Target", snoozedUntil: deadline, updatedAt: 1 });
const recent = sessionRow("recent", { label: "Recent", updatedAt: 50 });
const anchor = sessionRow("anchor", { label: "Anchor", updatedAt: 10, pinned: true });
const entries = (...rows: { key: string }[]) => rows.map((row) => `session:${row.key}`);
const result = (awake: boolean) =>
  sessionsResult([{ ...target, pinned: awake }, recent, anchor], awake ? deadline : deadline - 1);
// The paired browser follows its writable profile, not a native capability advertisement.
const signed = gatewayHelloForMethods(["sessions.list"]);
const negotiated = {
  ...signed,
  features: { methods: ["users.prefs.set"], capabilities: ["personal-session-pins"] },
};
const selfUser = { id: "reader" };

async function mount(connection: Partial<ApplicationGatewaySnapshot>, awake = false) {
  const { gateway, emit } = createGateway();
  emit(connection);
  const context = createContext(gateway, createSessions());
  context.navigation.update({ sidebarEntries: entries(target, anchor) });
  const page = await createRenderedPage(context, result(awake), "all");
  const order = () =>
    [...page.querySelectorAll(".session-key-cell__primary")].map((el) => el.textContent);
  return { page, order, emit, navigation: context.navigation };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

it.each([-60_000, 60_000])(
  "uses the signed roster's snooze boundary with browser offset %i ms",
  async (offset) => {
    vi.useFakeTimers();
    vi.setSystemTime(deadline - 1 + offset);
    const { page, order } = await mount({ hello: signed, selfUser });
    expect(order()).toEqual(["Anchor", "Recent", "Target"]);
    page.result = result(true);
    await page.updateComplete;
    expect(order()).toEqual(["Target", "Anchor", "Recent"]);
  },
);

it("adopts a verified profile in place and keeps local edits live before the next roster read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(deadline - 60_000);
  const { page, order, emit, navigation } = await mount(
    { hello: signed, selfUser: undefined },
    true,
  );
  expect(order()).toEqual(["Anchor", "Recent", "Target"]);
  emit({ selfUser });
  await page.updateComplete;
  expect(order()).toEqual(["Target", "Anchor", "Recent"]);

  const archived = sessionRow("archived", { label: "Archived", archived: true });
  const nested = sessionRow("child", { label: "Child", spawnedBy: anchor.key });
  page.result = sessionsResult([...result(true).sessions, archived, nested], deadline);
  page.onSortChange("key", "asc");
  page.onToggleSelect(target.key);
  // Pin Recent and unpin Target before a roster reply; neither row's pinned flag has changed.
  navigation.update({ sidebarEntries: entries(archived, nested, recent, anchor) });
  await page.updateComplete;
  expect(order()).toEqual(["Recent", "Anchor", "Archived", "Child", "Target"]);
  navigation.update({ sidebarEntries: entries(anchor, recent) });
  await page.updateComplete;
  expect(order()).toEqual(["Anchor", "Recent", "Archived", "Child", "Target"]);
  expect(page.querySelector("thead [aria-sort='ascending']")?.textContent).toContain("Session");
  expect(page.querySelector("tbody input:checked")?.getAttribute("aria-label")).toContain(
    target.key,
  );
});

it.each([
  { name: "profileless", hello: negotiated, selfUser: null },
  {
    name: "session-only writer",
    hello: { ...negotiated, auth: { role: "operator", scopes: ["operator.sessions.write"] } },
    selfUser,
  },
  {
    name: "read-only",
    hello: { ...negotiated, auth: { role: "operator", scopes: ["operator.read"] } },
    selfUser,
  },
])(
  "keeps $name pins on the device clock, even when the roster marks the row pinned",
  async ({ hello, selfUser: identity }) => {
    vi.useFakeTimers();
    vi.setSystemTime(deadline - 1_000);
    const { page, order } = await mount({ hello, selfUser: identity }, true);
    expect(order()).toEqual(["Anchor", "Recent", "Target"]);
    vi.advanceTimersByTime(1_001);
    await page.updateComplete;
    expect(order()).toEqual(["Target", "Anchor", "Recent"]);
  },
);
