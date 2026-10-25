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
