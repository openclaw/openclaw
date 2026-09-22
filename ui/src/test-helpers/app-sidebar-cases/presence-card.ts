import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar person activity card", () => {
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
    sidebar.querySelector<HTMLElement>(".sidebar-online__person")!.focus();
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
    expect(facts[1]?.textContent?.trim()).toBe("Not observed yet");
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
