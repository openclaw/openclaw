/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { disposeRoster, mountRoster } from "./app-sidebar-freshness.test-support.ts";

it("keeps off-page personal pins current and releases their observations", async () => {
  const key = "agent:main:shared-pin";
  let accessible = true;
  const row = {
    key,
    sessionId: "shared-pin",
    kind: "direct" as const,
    label: "Shared research",
    updatedAt: 10,
  };
  const describe = vi.fn(() => ({
    session: accessible ? row : null,
  }));
  const mounted = await mountRoster((method) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return sessionsResult([]);
    }
    return method === "sessions.describe" ? describe() : {};
  });
  const { sidebar, harness } = mounted;
  const observations = vi.spyOn(mounted.sessions, "observeRow");
  const released = () => {
    expect(observations.mock.results.length).toBeGreaterThan(0);
    for (const result of observations.mock.results) {
      if (result.type === "return") {
        expect(result.value.isCurrent()).toBe(false);
      }
    }
  };
  try {
    sidebar.connected = true;
    sidebar.sidebarEntries = [`session:${key}`];
    await waitForFast(() => expect(sidebar.textContent).toContain("Shared research"));
    expect(describe).toHaveBeenCalledTimes(1);
    accessible = false;
    vi.useFakeTimers();
    harness.publishEvent("sessions.changed", {});
    await vi.advanceTimersByTimeAsync(5_000);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).not.toContain("Shared research");
    expect(sidebar.sidebarEntries).toEqual([`session:${key}`]);
    expect(describe).toHaveBeenCalledTimes(2);

    accessible = true;
    harness.publishEvent("sessions.changed", {});
    await vi.advanceTimersByTimeAsync(5_000);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Shared research");
    expect(describe).toHaveBeenCalledTimes(3);

    harness.publishEvent("sessions.changed", {
      agentId: "main",
      sessionKey: key,
      reason: "patch",
      session: { ...row, label: "Updated research", updatedAt: 20 },
      ancestorSessions: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Updated research");
    expect(describe).toHaveBeenCalledTimes(3);

    sidebar.sidebarEntries = [];
    await settleLitElement(sidebar);
    released();
    harness.publishEvent("sessions.changed", {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(describe).toHaveBeenCalledTimes(3);

    sidebar.sidebarEntries = [`session:${key}`];
    await vi.advanceTimersByTimeAsync(0);
    await settleLitElement(sidebar);
    expect(sidebar.textContent).toContain("Shared research");
    mounted.provider.remove();
    await vi.advanceTimersByTimeAsync(0);
    released();
  } finally {
    vi.useRealTimers();
    disposeRoster(mounted);
  }
});

it("keeps a live pin across query replacement until its descriptor confirms absence", async () => {
  const key = "agent:main:mine";
  const entry = `session-rail:${key}`;
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", [key]);
  const result = sessions.sessions.state.result!;
  Object.assign(result.sessions[0]!, { label: "Live pin", icon: "📝" });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
  const read = vi.spyOn(sessions.sessions, "describe").mockReturnValue(pending.promise);
  sidebar.connected = true;
  sidebar.sidebarEntries = [entry];
  await sidebar.updateComplete;
  const rail = () => sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="${entry}"]`);
  const pinnedLink = rail()!.querySelector("a")!;
  expect(pinnedLink.getAttribute("aria-label")).toBe("Live pin");
  expect(read).not.toHaveBeenCalled();

  sessions.publishList({ agentId: "main", result: { ...result, sessions: [] } });
  await settleLitElement(sidebar);
  expect(rail()!.querySelector("a")).toBe(pinnedLink);
  expect(pinnedLink.getAttribute("aria-label")).toBe("Live pin");
  expect(pinnedLink.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
  expect(read).toHaveBeenCalledExactlyOnceWith({ key });

  pending.resolve({ session: null });
  await pending.promise;
  await settleLitElement(sidebar);
  expect(rail()).toBeNull();
  expect(sidebar.sidebarEntries).toEqual([entry]);
  sidebar.invalidate();
  await sidebar.updateComplete;
  expect(rail()).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
});
