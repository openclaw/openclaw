import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { focusSidebarPersonWithKeyboard } from "../app-sidebar-setup.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar person activity card", () => {
  it("holds recent links and focus through activity, retires missing links, and refreshes on reopen", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness(
      "research",
      [1, 2, 3, 4].map((n) => `agent:research:recent-${n}`),
    );
    const result = sessions.sessions.state.result!;
    const now = Date.now();
    result.sessions.forEach((row, index) => {
      row.label = `Task ${index + 1}`;
      row.updatedAt = now - index * 1000;
      row.owner = {
        actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
      };
    });
    sessions.publishList({ result });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    gateway.publishEvent("presence", {
      presence: [
        {
          instanceId: "alice-tab",
          mode: "webchat",
          ts: now,
          user: { id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
          watchedSessions: [],
        },
      ],
    });
    await settleLitElement(sidebar);
    const trigger = sidebar.querySelector<HTMLElement>(".sidebar-online__person")!;
    focusSidebarPersonWithKeyboard(trigger);
    await vi.dynamicImportSettled();
    await settleLitElement(sidebar);
    const links = () =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(".person-activity-card__session"));
    const initial = links();
    expect(initial.map((link) => link.getAttribute("href"))).toEqual(
      [1, 2, 3].map((n) => `/chat/research/recent-${n}`),
    );
    initial[2]!.focus();
    const updated = result.sessions.map((row, index) => ({
      ...row,
      updatedAt: now + index * 1000,
    }));
    sessions.publishList({ result: { ...result, sessions: updated } });
    await settleLitElement(sidebar);
    expect(links()).toEqual(initial);
    expect(document.activeElement).toBe(initial[2]);
    expect(initial[2]!.querySelector("time")?.dateTime).toBe(new Date(now + 2000).toISOString());

    // Missing authorized roster members disappear; new activity must not fill their places.
    sessions.publishList({
      result: {
        ...result,
        sessions: updated.filter((row) => row.key !== "agent:research:recent-3"),
      },
    });
    await settleLitElement(sidebar);
    expect(links()).toEqual(initial.slice(0, 2));
    expect(document.activeElement).toBe(trigger);
    sessions.publishList({ result: { ...result, sessions: updated } });
    await settleLitElement(sidebar);
    expect(links()).toEqual(initial.slice(0, 2));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".person-activity-hovercard")).toBeNull();
    trigger.blur();
    trigger.focus();
    await settleLitElement(sidebar);
    expect(links().map((link) => link.getAttribute("href"))).toEqual(
      [4, 3, 2].map((n) => `/chat/research/recent-${n}`),
    );
  });

  it.each([false, true])(
    "waits for loading, but preserves a known empty selection (loaded: %s)",
    async (loaded) => {
      const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
      const sessions = createSessionsHarness("research", ["agent:research:new"]);
      const result = sessions.sessions.state.result!;
      const row = {
        ...result.sessions[0]!,
        owner: {
          actor: {
            type: "human" as const,
            id: "alice",
            identity: { type: "profile" as const, id: "alice" },
          },
        },
      };
      sessions.publishList({ result: loaded ? { ...result, sessions: [] } : null });
      const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
      sidebar.connected = true;
      gateway.publishEvent("presence", {
        presence: [
          {
            instanceId: "alice-tab",
            mode: "webchat",
            ts: Date.now(),
            user: { id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
            watchedSessions: [],
          },
        ],
      });
      await settleLitElement(sidebar);
      const trigger = sidebar.querySelector<HTMLElement>(".sidebar-online__person")!;
      focusSidebarPersonWithKeyboard(trigger);
      await vi.dynamicImportSettled();
      await settleLitElement(sidebar);
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull();
      expect(document.querySelector(".person-activity-card__session")).toBeNull();
      sessions.publishList({ result: { ...result, sessions: [row] } });
      await settleLitElement(sidebar);
      expect(document.querySelectorAll(".person-activity-card__session")).toHaveLength(
        loaded ? 0 : 1,
      );
      if (loaded) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        trigger.blur();
        trigger.focus();
        await settleLitElement(sidebar);
      }
      expect(document.querySelector(".person-activity-card__session")?.getAttribute("href")).toBe(
        "/chat/research/new",
      );
      sessions.publishList({
        result: {
          ...result,
          sessions: [
            {
              ...row,
              owner: {
                actor: { ...row.owner.actor, id: "bob", identity: { type: "profile", id: "bob" } },
              },
            },
          ],
        },
      });
      await settleLitElement(sidebar);
      expect(document.querySelector(".person-activity-card__session")).toBeNull();
    },
  );

  it("projects only visible sessions and reported facts without guessing timing or devices", async () => {
    const gateway = createGatewayHarness({ instanceId: "self" } as GatewayBrowserClient);
    const sessions = createSessionsHarness("research", [
      "watched",
      "global",
      "agent:research:ambiguous",
      "agent:research:robot",
      ...[1, 2, 3, 4].map((n) => `agent:research:recent-${n}`),
    ]);
    const result = sessions.sessions.state.result!;
    result.sessions.forEach((row, index) => {
      row.label = row.key === "global" ? "Research global" : `Visible ${index}`;
      row.updatedAt = Date.now() - index * 60_000;
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
    sessions.publishList({ result });
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    sidebar.connected = true;
    gateway.publishEvent("presence", {
      presence: [
        { deviceFamily: "Mac", platform: "MacIntel", mode: "webchat" },
        { deviceFamily: "Mac", platform: "MacIntel", mode: "webchat" },
        { deviceFamily: "iPad", platform: "MacIntel", mode: "webchat" },
        { deviceFamily: "Mac", platform: "MacARM64", mode: "webchat" },
        { deviceFamily: "Windows", platform: "win32", mode: "webchat" },
        {
          deviceFamily: "Mac",
          platform: "macos",
          mode: "ui",
          clientId: "openclaw-tui",
          host: "openclaw-macos",
        },
        {
          deviceFamily: "Mac",
          platform: "macos",
          mode: "ui",
          clientId: "openclaw-macos",
          host: "openclaw-tui",
        },
        { platform: "linux", mode: "ui", host: "openclaw-tui" },
        { platform: "freebsd", mode: "cli" },
      ].map(({ deviceFamily, platform, mode, clientId, host }, tab) => ({
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
    focusSidebarPersonWithKeyboard(sidebar.querySelector<HTMLElement>(".sidebar-online__person")!);
    // Focus loads its interaction owner before the card can render.
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(document.querySelector(".person-activity-hovercard")).not.toBeNull(),
    );
    const card = document.querySelector<HTMLElement>(".person-activity-hovercard")!;
    expect(card.querySelectorAll("dt")).toHaveLength(2);
    expect(card.querySelector(".person-activity-card__status")?.textContent?.trim()).toBe("Online");
    const facts = card.querySelectorAll("dd");
    expect([...facts[0]!.querySelectorAll("span")].map((node) => node.textContent)).toEqual([
      "FreeBSD · Command line",
      "Linux · App",
      "Mac · ARM · Web",
      "Mac · App",
      "Mac · Terminal",
      "Mac · Web",
      "Windows · Web",
      "iPad · Web",
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
  });
});
