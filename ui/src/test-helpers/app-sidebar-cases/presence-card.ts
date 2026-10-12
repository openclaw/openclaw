import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { focusSidebarPersonWithKeyboard, selectSidebarView } from "../app-sidebar-setup.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar person activity card", () => {
  it("projects authorized facts and keeps recent links stable until reopening", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness("research", [
      "watched",
      "global",
      "agent:research:ambiguous",
      "agent:research:robot",
      ...[1, 2, 3, 4].map((n) => `agent:research:recent-${n}`),
    ]);
    const observeList = sessions.sessions.observeList;
    let activityQuery: ReturnType<typeof observeList> | undefined;
    vi.spyOn(sessions.sessions, "observeList").mockImplementation((query, listener) => {
      const observation = observeList(query, listener);
      if (query.source === "activity") {
        activityQuery = observation;
      }
      return observation;
    });
    const result = sessions.sessions.state.result!;
    const now = Date.now();
    result.sessions.forEach((row, index) => {
      row.agentId = "research";
      row.label = row.key === "global" ? "Research global" : `Visible ${index}`;
      row.updatedAt = now - index * 60_000;
      if (index === 2) {
        row.participants = [{ identity: { type: "profile", id: "alice" }, label: "Alice" }];
      }
      if (index === 3) {
        row.createdActor = { type: "agent", id: "alice" };
      }
      if (index >= 4) {
        row.owner = {
          actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
        };
      }
    });
    sessions.publishList({ result: null });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    await selectSidebarView(sidebar, "online");
    gateway.publishEvent("presence", {
      presence: [
        // Family, platform, mode, client ID, misleading host. Duplicate tabs collapse.
        ["Mac", "MacIntel", "webchat"],
        ["Mac", "MacIntel", "webchat"],
        ["iPad", "MacIntel", "webchat"],
        ["Mac", "MacARM64", "webchat"],
        ["Windows", "win32", "webchat"],
        ["Mac", "macos", "ui", "openclaw-tui", "openclaw-macos"],
        ["Mac", "macos", "ui", "openclaw-macos", "openclaw-tui"],
        [undefined, "linux", "ui", undefined, "openclaw-tui"],
        [undefined, "freebsd", "cli"],
      ].map(([deviceFamily, platform, mode, clientId, host], tab) => ({
        ts: Date.now() - 500_000,
        lastInputSeconds: 3,
        instanceId: `private-tab-${tab}`,
        ip: "192.0.2.12",
        host: host ?? "internal-host",
        deviceFamily,
        platform,
        mode,
        clientId,
        timeZone: "Europe/Paris",
        user: { id: "alice", identity: { type: "profile" as const, id: "alice" }, name: "Alice" },
        watchedSessions: [
          "AGENT:research:watched",
          "agent:research:watched",
          "agent:private:secret-title",
          "global",
        ],
      })),
    });
    await sidebar.updateComplete;
    const trigger = sidebar.querySelector<HTMLElement>(".sidebar-online__person")!;
    focusSidebarPersonWithKeyboard(trigger);
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(card.querySelector(".person-activity-card__session")).toBeNull();
    sessions.publishList({ result });
    await activityQuery?.refresh();
    await settleLitElement(sidebar);
    expect(card.querySelectorAll("dt")).toHaveLength(2);
    expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe("Online");
    const facts = card.querySelectorAll("dd");
    expect([...facts[0]!.querySelectorAll("span")].map((node) => node.textContent)).toEqual([
      "FreeBSD · Command line",
      "Linux · App",
      "Mac · ARM · Web app",
      "Mac · App",
      "Mac · Terminal",
      "Mac · Web app",
      "Windows · Web app",
      "iPad · Web app",
    ]);
    expect(facts[0]?.querySelector("small")?.textContent).toBe("Reported time zone: Europe/Paris");
    expect(facts[1]?.textContent?.trim()).toBe("Activity unavailable");
    const sections = card.querySelectorAll("section");
    expect(sections[0]?.querySelectorAll("a")).toHaveLength(1);
    expect(sections[0]?.textContent).toContain("Visible 0");
    expect(sections[0]?.querySelector("a")?.getAttribute("href")).toBe("/chat/research/watched");
    expect(sections[1]?.querySelectorAll("a")).toHaveLength(3);
    expect(sections[1]?.textContent).not.toContain("Session updated");
    expect(sections[1]?.querySelectorAll(".person-activity-card__session-age")).toHaveLength(3);
    for (const hidden of [
      "secret-title",
      "private-tab",
      "internal-host",
      "openclaw-tui",
      "openclaw-macos",
      "192.0.2.12",
      "Research global",
      "Visible 2",
      "Visible 3",
      "Visible 7",
    ]) {
      expect(card.outerHTML).not.toContain(hidden);
    }
    expect(card.querySelectorAll("[data-viewer-id]")).toHaveLength(0);

    const links = () =>
      Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          ".person-activity-hovercard section:last-of-type a",
        ),
      );
    const publish = async (rows: typeof result.sessions) => {
      sessions.publishList({ result: { ...result, sessions: rows } });
      if (document.querySelector(".person-activity-hovercard")) {
        await activityQuery?.refresh();
      }
      await settleLitElement(sidebar);
    };
    const initial = links();
    initial[2]!.focus();
    const updated = structuredClone(result.sessions);
    updated.forEach((row, index) => {
      row.updatedAt = now + index * 1000;
    });
    await publish(updated);
    expect(links()).toEqual(initial);
    expect(document.activeElement).toBe(initial[2]);
    expect(initial[2]!.querySelector("time")?.dateTime).toBe(new Date(now + 6000).toISOString());

    await publish(updated.filter((row) => row.key !== "agent:research:recent-3"));
    expect(links()).toEqual(initial.slice(0, 2));
    expect(document.activeElement).toBe(trigger);
    await publish(updated);
    expect(links()).toEqual(initial.slice(0, 2));
    await publish(
      updated.map((row) =>
        row.key === "agent:research:recent-2"
          ? {
              ...row,
              owner: {
                actor: { type: "human", id: "bob", identity: { type: "profile", id: "bob" } },
              },
            }
          : row,
      ),
    );
    expect(links()).toEqual(initial.slice(0, 1));
    await publish(updated);
    expect(links()).toEqual(initial.slice(0, 1));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();
    await publish([]);
    trigger.blur();
    trigger.focus();
    await activityQuery?.refresh();
    await settleLitElement(sidebar);
    expect(links()).toHaveLength(0);
    await publish(updated);
    expect(links()).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    trigger.blur();
    trigger.focus();
    await activityQuery?.refresh();
    await settleLitElement(sidebar);
    expect(links().map((link) => link.getAttribute("href"))).toEqual(
      [4, 3, 2].map((n) => `/chat/research/recent-${n}`),
    );
  });
});
