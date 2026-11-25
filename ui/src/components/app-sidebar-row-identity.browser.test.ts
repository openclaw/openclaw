import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar session row DOM identity", () => {
  it("retains session row DOM and focus through insertion and activity reordering", async () => {
    await import("./app-sidebar.tsx");
    const { createGatewayHarness, createSessionsHarness, createSessionState, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const alphaKey = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
    const harness = createSessionsHarness("main", [alphaKey, "agent:main:beta"]);
    Object.assign(harness.sessions.state.result!.sessions[0]!, {
      displayName: "Release Board",
      boardFace: "dashboard",
    });
    const { provider, sidebar, context } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      harness.sessions,
    );
    sidebar.style.cssText = "display:block;width:320px;height:600px";
    provider.setContext({ ...context, basePath: "/control" });
    sidebar.basePath = "/control";
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!.style.cssText =
      "height:500px;flex:none;overflow:auto";

    const rowFor = (key: string) =>
      sidebar.querySelector<HTMLElement>(`[data-session-tree="${key}"]`);
    await waitForSolid(() => {
      expect(rowFor(alphaKey)).not.toBeNull();
      expect(rowFor("agent:main:beta")).not.toBeNull();
    });
    const alphaBefore = rowFor(alphaKey);
    const betaBefore = rowFor("agent:main:beta");
    expect(alphaBefore).not.toBeNull();
    expect(betaBefore).not.toBeNull();
    expect(alphaBefore?.querySelector("a")?.getAttribute("href")).toBe(
      "/control/dashboard/main/release-board-11111111111141118111111111111111",
    );

    // A newly created session sorts first (createdAt desc) and shifts every
    // existing row's position; keyed reuse must move their DOM, not rebuild it.
    const next = createSessionState("main", [alphaKey, "agent:main:beta", "agent:main:gamma"]);
    Object.assign(next.result!.sessions[0]!, {
      displayName: "Renamed Board",
      boardFace: "chat",
    });
    const gamma = next.result?.sessions.find((row) => row.key === "agent:main:gamma");
    if (gamma) {
      gamma.createdAt = Date.now();
    }
    harness.publishList(next);
    await waitForSolid(() => {
      const rowKeys = Array.from(sidebar.querySelectorAll("[data-session-tree]")).map((row) =>
        row.getAttribute("data-session-tree"),
      );
      expect(rowKeys[0]).toBe("agent:main:gamma");
      expect(rowFor(alphaKey)).toBe(alphaBefore);
      expect(rowFor("agent:main:beta")).toBe(betaBefore);
      expect(alphaBefore?.querySelector("a")?.getAttribute("href")).toBe(
        "/control/chat/main/renamed-board-11111111111141118111111111111111",
      );
      expect(betaBefore?.querySelector("a")?.getAttribute("href")).toBe("/control/chat/main/beta");
    });
    // Unlike insertion, moving the focused row itself can blur the same DOM link.
    sidebar.setSessionSortMode("updated");
    await sidebar.updateComplete;
    const order = () =>
      [...sidebar.querySelectorAll<HTMLElement>("[data-session-tree]")].map(
        (row) => row.dataset.sessionTree,
      );
    const movedKey = order().at(-1)!;
    const moved = rowFor(movedKey)!.querySelector("a")!;
    moved.focus();
    const current = next.result!.sessions.find((row) => row.key === movedKey)!;
    const refreshed = { ...current, lastActivityAt: Date.now() + 1000 };
    harness.publishList({
      ...next,
      result: {
        ...next.result!,
        sessions: next.result!.sessions.map((row) => (row === current ? refreshed : row)),
      },
    });
    await waitForSolid(() => expect(order()[0]).toBe(movedKey));
    expect(document.activeElement).toBe(moved);
  });
});
