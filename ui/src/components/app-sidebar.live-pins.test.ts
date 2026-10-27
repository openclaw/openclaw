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

it.each(["pin", "group"] as const)(
  "keeps an off-page personal %s current and releases its observations",
  async (placement) => {
    const key = "agent:main:shared-pin";
    let accessible = true;
    let row = {
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
    const save = (saved: boolean) => {
      if (placement === "pin") {
        sidebar.sidebarEntries = saved ? [`session:${key}`] : [];
      } else {
        mounted.context.navigation.update({
          personalSessionGroups: saved ? [{ id: "focus", label: "Focus", sessionKeys: [key] }] : [],
        });
      }
    };
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
      save(true);
      await waitForFast(() => expect(sidebar.textContent).toContain("Shared research"));
      expect(describe).toHaveBeenCalledTimes(1);
      accessible = false;
      vi.useFakeTimers();
      harness.publishEvent("sessions.changed", {});
      await vi.advanceTimersByTimeAsync(5_000);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain("Shared research");
      if (placement === "pin") {
        expect(sidebar.sidebarEntries).toEqual([`session:${key}`]);
      } else {
        expect(mounted.context.navigation.snapshot.personalSessionGroups).toEqual([
          { id: "focus", label: "Focus", sessionKeys: [key] },
        ]);
      }
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

      // A history response can admit a new generation without a session event.
      row = { ...row, sessionId: "successor-pin", label: "Recreated research", updatedAt: 30 };
      const reconcile = mounted.sessions.captureReconcile();
      expect(reconcile(row, undefined, { archivedFilter: "all" })).toBe(true);
      // The next canonical page excludes the pin again after the supplemental read.
      await mounted.sessions.refresh({ agentId: "main", force: true });
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Recreated research");
      expect(mounted.sessions.state.result?.sessions).toEqual([]);
      expect(describe).toHaveBeenCalledTimes(4);

      save(false);
      await settleLitElement(sidebar);
      released();
      harness.publishEvent("sessions.changed", {});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(describe).toHaveBeenCalledTimes(4);

      save(true);
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Recreated research");
      mounted.provider.remove();
      await vi.advanceTimersByTimeAsync(0);
      released();
    } finally {
      vi.useRealTimers();
      disposeRoster(mounted);
    }
  },
);

it("keeps live pins across query replacement until their descriptors confirm absence", async () => {
  const keys = ["agent:main:mine", "agent:main:other"];
  const entries = keys.map((key) => `session-rail:${key}`);
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", keys);
  const result = sessions.sessions.state.result!;
  result.sessions.forEach((row, index) => {
    Object.assign(row, { label: `Live pin ${index + 1}`, icon: "📝" });
  });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  const pending = createDeferred<Awaited<ReturnType<typeof sessions.sessions.describe>>>();
  const read = vi.spyOn(sessions.sessions, "describe").mockReturnValue(pending.promise);
  sidebar.connected = true;
  sidebar.sidebarEntries = entries;
  await sidebar.updateComplete;
  const rail = (entry: string) =>
    sidebar.querySelector(`.sidebar-rail [data-sidebar-entry="${entry}"]`);
  const pinnedLinks = entries.map((entry) => rail(entry)!.querySelector("a")!);
  expect(pinnedLinks.map((link) => link.getAttribute("aria-label"))).toEqual([
    "Live pin 1",
    "Live pin 2",
  ]);
  expect(read).not.toHaveBeenCalled();

  sessions.publishList({ agentId: "main", result: { ...result, sessions: [] } });
  await settleLitElement(sidebar);
  for (const [index, entry] of entries.entries()) {
    const pinnedLink = pinnedLinks[index]!;
    expect(rail(entry)!.querySelector("a")).toBe(pinnedLink);
    expect(pinnedLink.getAttribute("aria-label")).toBe(`Live pin ${index + 1}`);
    expect(pinnedLink.querySelector(".session-glyph__emoji")?.textContent).toBe("📝");
    expect(read).toHaveBeenCalledWith({ key: keys[index] });
  }
  expect(read).toHaveBeenCalledTimes(2);

  pending.resolve({ session: null });
  await pending.promise;
  await settleLitElement(sidebar);
  expect(entries.map(rail)).toEqual([null, null]);
  expect(sidebar.sidebarEntries).toEqual(entries);
  sidebar.invalidate();
  await sidebar.updateComplete;
  expect(entries.map(rail)).toEqual([null, null]);
  expect(read).toHaveBeenCalledTimes(2);
});
