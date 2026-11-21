import { expect, it, vi } from "vitest";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import {
  mountRoster,
  roster,
  session,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import { parseSidebarSnapshot } from "./sidebar-snapshot-model.ts";
import { sidebarSnapshot } from "./sidebar-snapshot.test-support.ts";

setupSidebarTest();

it("tracks unread conversations on regular and pinned agents until the last unread is read", async () => {
  const { sidebar, context, gatewayHarness } = await mountRoster(roster, [
    session("main", 100),
    session("main", 110, { key: "agent:main:work", isMain: false }),
    session("main", 120, { key: "agent:main:other", isMain: false }),
    session("recent", 130, { key: "agent:recent:archive", archived: true, unread: true }),
    session("working", 140, { unread: true, hasActiveRun: true }),
  ]);
  context.navigation.update({ pinnedAgentIds: ["working"] });
  sidebar.sidebarAgentsMode = "roster";
  await settleRoster(sidebar);
  const dot = (id: string) =>
    sidebar.querySelector(`[data-agent-id="${id}"] .session-glyph__badge--unread`);
  const update = async (key: string, unread: boolean, updatedAt: number) => {
    gatewayHarness.publishEvent("session.message", {
      agentId: "main",
      session: { key, unread, updatedAt },
    });
    await settleRoster(sidebar);
  };
  await waitForSolid(() => expect(dot("working")).not.toBeNull());
  expect(
    sidebar.querySelector(".sidebar-pinned-agent__link")?.getAttribute("aria-label"),
  ).toContain("Unread");
  expect(dot("main")).toBeNull();
  expect(dot("recent")).toBeNull();
  const main = sidebar.querySelector('.sidebar-agent-roster__row[data-agent-id="main"]');
  // A reply in another conversation must update the active agent without a host render.
  await update("agent:main:work", true, 200);
  await waitForSolid(() => expect(dot("main")).not.toBeNull());
  expect(main?.textContent).toContain("Unread");
  await update("agent:main:other", true, 210);
  const owner = getAppSidebarOwner(sidebar.hostElement)!;
  const settled = vi.spyOn(owner, "sidebarSnapshotSettled").mockReturnValue(false);
  const saved = parseSidebarSnapshot({
    ...sidebarSnapshot,
    cards: rosterActivityStore(context).snapshot.cards,
  });
  expect(saved).not.toBeNull();
  owner.restoreSidebarSnapshot(saved!);
  owner.invalidate();
  await settleRoster(sidebar);
  expect(owner.sidebarSnapshot).toBe(saved);
  expect(dot("main")).not.toBeNull();
  expect(dot("working")).not.toBeNull();
  owner.releaseSidebarSnapshot();
  owner.invalidate();
  settled.mockRestore();
  await settleRoster(sidebar);
  await update("agent:main:work", false, 220);
  expect(dot("main")).not.toBeNull();
  await update("agent:main:other", false, 230);
  await waitForSolid(() => expect(dot("main")).toBeNull());
  expect(sidebar.querySelector('.sidebar-agent-roster__row[data-agent-id="main"]')).toBe(main);
  expect(dot("working")).not.toBeNull();
});
