/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";

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
