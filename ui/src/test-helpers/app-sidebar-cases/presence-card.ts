import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { focusSidebarPersonWithKeyboard, selectSidebarView } from "../app-sidebar-setup.ts";
import { createGatewayHarness, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

await import("../../components/viewer-facepile.ts");

const owner = (id: string) => ({
  actor: { type: "human" as const, id, identity: { type: "profile" as const, id } },
});
const cardElement = () => document.querySelector<HTMLElement>(".person-activity-hovercard");
const escape = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

it("AppSidebar person activity card projects authorized facts and keeps links stable until reopening", async () => {
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
      row.owner = owner("alice");
    }
  });
  sessions.publishList({ result: null });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.connected = true;
  await selectSidebarView(sidebar, "online");
  // Expected label, family, platform, mode, client ID, misleading host; duplicate tabs collapse.
  const devices: [string, string | undefined, string, string, string?, string?][] = [
    ["Mac · Web app", "Mac", "MacIntel", "webchat"],
    ["Mac · Web app", "Mac", "MacIntel", "webchat"],
    ["iPad · Web app", "iPad", "MacIntel", "webchat"],
    ["Mac · ARM · Web app", "Mac", "MacARM64", "webchat"],
    ["Windows · Web app", "Windows", "win32", "webchat"],
    ["Mac · Terminal", "Mac", "macos", "ui", "openclaw-tui", "openclaw-macos"],
    ["Mac · App", "Mac", "macos", "ui", "openclaw-macos", "openclaw-tui"],
    ["Linux · App", undefined, "linux", "ui", undefined, "openclaw-tui"],
    ["FreeBSD · Command line", undefined, "freebsd", "cli"],
  ];
  gateway.publishEvent("presence", {
    presence: devices.map(([, deviceFamily, platform, mode, clientId, host], tab) => ({
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
  await settleLitElement(sidebar);
  const trigger = sidebar.querySelector<HTMLElement>(".sidebar-online__person")!;
  focusSidebarPersonWithKeyboard(trigger);
  await vi.dynamicImportSettled();
  await settleLitElement(sidebar);
  const card = cardElement()!;
  const view = domProbe(card);
  expect(view.query(".person-activity-card__session")).toBeNull();
  sessions.publishList({ result });
  await activityQuery?.refresh();
  await settleLitElement(sidebar);
  expect(view.all("dt")).toHaveLength(2);
  expect(view.text(".person-activity-card__status")?.trim()).toBe("Online");
  const facts = view.all("dd");
  expect([...facts[0]!.querySelectorAll("span")].map((node) => node.textContent)).toEqual(
    [...new Set(devices.map(([label]) => label))].toSorted((a, b) =>
      a === b ? 0 : a < b ? -1 : 1,
    ),
  );
  expect(facts[0]?.querySelector("small")?.textContent).toBe("Reported time zone: Europe/Paris");
  expect(facts[1]?.textContent?.trim()).toBe("Activity unavailable");
  const sections = view.all("section");
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
  expect(view.all("[data-viewer-id]")).toHaveLength(0);

  const links = () =>
    Array.from(cardElement()?.querySelectorAll<HTMLAnchorElement>("section:last-of-type a") ?? []);
  const publish = async (rows: typeof result.sessions, expected = links()) => {
    sessions.publishList({ result: { ...result, sessions: rows } });
    if (cardElement()) {
      await activityQuery?.refresh();
    }
    await settleLitElement(sidebar);
    expect(links()).toEqual(expected);
  };
  const initial = links();
  initial[2]!.focus();
  const updated = structuredClone(result.sessions);
  updated.forEach((row, index) => {
    row.updatedAt = now + index * 1000;
  });
  await publish(updated);
  expect(document.activeElement).toBe(initial[2]);
  expect(initial[2]!.querySelector("time")?.dateTime).toBe(new Date(now + 6000).toISOString());

  await publish(
    updated.filter((row) => row.key !== "agent:research:recent-3"),
    initial.slice(0, 2),
  );
  expect(document.activeElement).toBe(trigger);
  await publish(updated);
  await publish(
    updated.map((row) =>
      row.key === "agent:research:recent-2" ? { ...row, owner: owner("bob") } : row,
    ),
    initial.slice(0, 1),
  );
  await publish(updated);

  const reopen = async () => {
    trigger.blur();
    trigger.focus();
    await activityQuery?.refresh();
    await settleLitElement(sidebar);
  };
  escape();
  expect(cardElement()).toBeNull();
  await publish([]);
  await reopen();
  expect(links()).toHaveLength(0);
  await publish(updated);
  escape();
  await reopen();
  expect(links().map((link) => link.getAttribute("href"))).toEqual(
    [4, 3, 2].map((n) => `/chat/research/recent-${n}`),
  );
});
