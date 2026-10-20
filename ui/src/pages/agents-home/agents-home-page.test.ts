/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  cleanupAgentsHomePageTest,
  initialSessions,
  listSessions,
  mountAgentsHome,
  roster,
  rosterIdentity,
  session,
  setupAgentsHomePageTest,
} from "./agents-home-page.test-helpers.ts";

function createPage() {
  let sessions = initialSessions();
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "agents.list") {
      return roster;
    }
    if (method === "agent.identity.get") {
      return rosterIdentity(params);
    }
    if (method === "sessions.list") {
      return listSessions(sessions, params);
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const fixture = mountAgentsHome(request, { staticSelection: true });
  return {
    ...fixture,
    ready: () =>
      waitForSolid(() =>
        expect(fixture.page.querySelectorAll(".agents-home__card")).toHaveLength(2),
      ),
    updateSessions: (next: GatewaySessionRow[]) => {
      sessions = next;
    },
  };
}

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

it("disables unavailable agent creation with its capability and recovery reason", async () => {
  const { page, navigate, ready } = createPage();
  await ready();
  const create = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "New agent",
  );

  expect(create).toMatchObject({ disabled: true });
  expect(create?.title).toContain("openclaw.chat");
  expect(create?.title).toContain("operator.admin");
  expect(create?.title).toContain("reconnect");
  create?.click();
  expect(navigate).not.toHaveBeenCalled();
});

it("shows the configured roster, prioritizes work across sessions, and opens the canonical main chat", async () => {
  const { page, request, navigate, ready } = createPage();
  await ready();

  const cards = [...page.querySelectorAll(".agents-home__card")];
  expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual(["Ember", "Harbor"]);
  expect(cards[0]?.textContent).toContain("Builds small tools");
  expect(page.textContent).not.toMatch(
    /example\/model-small|Working now|Active .* ago|No recent activity|System helper|A newer side-task message\./u,
  );
  await waitForSolid(() =>
    expect(cards[0]?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
  );
  expect(cards[1]?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("⚓");
  expect(cards[0]?.querySelector(".agents-home__preview")?.textContent?.trim()).toBe(
    "The main chat summary.",
  );
  expect(request).toHaveBeenCalledWith(
    "sessions.list",
    expect.objectContaining({ includeLastMessage: true, archived: "all", limit: 100 }),
  );

  const openChat = cards[0]?.querySelector<HTMLElement>(".agents-home__open");
  expect(openChat?.textContent).toBe("Open chat");
  expect(cards[0]?.tagName).toBe("A");
  expect(cards[0]?.getAttribute("href")).toBe("/chat/ember");
  expect(cards[0]?.querySelectorAll("a, button, [tabindex]")).toHaveLength(0);
  const modifiedClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  openChat?.dispatchEvent(modifiedClick);
  expect(modifiedClick.defaultPrevented).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  openChat?.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/ember" });
});

it("keeps chats reachable when agents have no messages", async () => {
  vi.useFakeTimers();
  const { page, updateSessions, emitChange, navigate, ready } = createPage();
  await ready();
  updateSessions([]);
  emitChange();
  await vi.advanceTimersByTimeAsync(5_000);
  await waitForSolid(() =>
    expect(
      [...page.querySelectorAll(".agents-home__preview")].map((preview) => preview.textContent),
    ).toEqual(["No messages yet", "No messages yet"]),
  );
  expect(page.textContent).not.toContain("No recent activity");
  page.querySelector<HTMLElement>('[data-agent-id="harbor"]')?.click();
  expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/harbor" });
});

it("shares bounded activity loading between consumers and stops after the last detach", async () => {
  vi.useFakeTimers();
  const fixture = createPage();
  const { page, request } = fixture;
  await fixture.ready();
  const secondView = fixture.mountPage();
  const second = secondView.container;
  await waitForSolid(() => expect(second.querySelectorAll(".agents-home__card")).toHaveLength(2));
  const calls = (method: string) =>
    request.mock.calls.filter(
      ([name, params]) =>
        name === method &&
        (method !== "sessions.list" ||
          (params !== null &&
            typeof params === "object" &&
            "archived" in params &&
            params.archived === "all")),
    );
  expect(calls("sessions.subscribe")).toHaveLength(0);
  expect(calls("sessions.list")).toHaveLength(1);
  expect(fixture.rosterListenerCount()).toBe(0);

  fixture.updateSessions(
    Array.from({ length: 301 }, (_, index) => ({
      key: `agent:harbor:task-${index}`,
      kind: "direct",
      updatedAt: index + 1,
      lastMessagePreview: `Activity ${index}`,
    })),
  );
  request.mockClear();
  fixture.emitChange();
  await vi.advanceTimersByTimeAsync(5_000);
  flush();
  expect(page.textContent).toContain("Activity 299");
  expect(second.textContent).toContain("Activity 299");
  expect(calls("sessions.list")).toHaveLength(3);
  expect(calls("sessions.subscribe")).toHaveLength(0);
  expect(page.textContent).not.toContain("Activity 300");

  fixture.unmount();
  expect(fixture.rosterListenerCount()).toBe(0);
  request.mockClear();
  fixture.emitChange();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls("sessions.list")).toHaveLength(3);
  fixture.emitChange();
  secondView.unmount();
  expect(fixture.rosterListenerCount()).toBe(0);
  request.mockClear();
  fixture.emitChange();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(calls("sessions.list")).toHaveLength(0);
});

it("refreshes previews and activity ordering after session events and gateway reconnect", async () => {
  vi.useFakeTimers();
  const { page, updateSessions, emitChange, setPhase } = createPage();
  await waitForSolid(() => expect(page.textContent).toContain("The main chat summary."));
  updateSessions([session("ember", "The tool is finished.", 7_000)]);
  emitChange();
  emitChange();
  await vi.advanceTimersByTimeAsync(5_000);
  await waitForSolid(() => expect(page.textContent).toContain("The tool is finished."));

  setPhase("reconnecting");
  await waitForSolid(() => expect(page.textContent).toContain("Connect to the Gateway"));
  updateSessions([session("harbor", "The next schedule is ready.", 8_000, { hasActiveRun: true })]);
  setPhase("connected");
  await waitForSolid(() => expect(page.textContent).toContain("The next schedule is ready."));
  expect(page.querySelector(".agents-home__card h2")?.textContent).toBe("Harbor");
});
