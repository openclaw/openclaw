import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar categorized child sessions", () => {
  it("shows a categorized Discord-spawned dashboard session on a cold sidebar without its parent", async () => {
    const variant = "panel";
    const officeKey = "agent:main:dashboard:office-ha";
    const wakeKey = "agent:main:dashboard:wake-word";
    const archivedKey = "agent:main:dashboard:archived";
    const parentKey = "agent:main:discord:channel:parent";
    const harness = createSessionsHarness("main", [officeKey, wakeKey, archivedKey]);
    const rows = harness.sessions.state.result!.sessions;
    Object.assign(rows[0]!, {
      label: "OFFICE HA",
      category: "HOME ASSISTANT",
      archived: false,
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      createdVia: "spawn",
      createdActor: { type: "agent" },
    });
    Object.assign(rows[1]!, {
      label: "Wake-word training",
      category: "HOME ASSISTANT",
      archived: false,
    });
    Object.assign(rows[2]!, {
      label: "Archived conversation",
      category: "HOME ASSISTANT",
      archived: true,
    });
    harness.publish({ groups: ["HOME ASSISTANT"] });
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
      variant,
    );
    sidebar.sessionKey = wakeKey;
    await sidebar.updateComplete;
    const group = sidebar.querySelector('[data-session-section="category:HOME ASSISTANT"]');
    expect(group?.querySelectorAll(`[data-session-key="${officeKey}"]`)).toHaveLength(1);
    expect(group?.querySelectorAll(`[data-session-key="${wakeKey}"]`)).toHaveLength(1);
    expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
  });

  it("promotes a categorized child loaded through the expanded-parent cache", async () => {
    const parentKey = "agent:main:parent";
    const categorizedKey = "agent:main:cached-categorized-child";
    const ordinaryKey = "agent:main:dashboard:cached-child";
    const archivedKey = "agent:main:cached-archived-child";
    const harness = createSessionsHarness("main", [parentKey]);
    const parent = harness.sessions.state.result?.sessions[0];
    Object.assign(parent ?? {}, {
      childSessions: [categorizedKey, ordinaryKey, archivedKey],
      label: "Parent task",
    });
    harness.list.mockResolvedValue({
      count: 3,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          category: "Research",
          key: categorizedKey,
          kind: "direct",
          label: "Cached categorized child",
          spawnedBy: parentKey,
          updatedAt: 3,
        },
        {
          key: ordinaryKey,
          kind: "direct",
          label: "Cached ordinary child",
          spawnedBy: parentKey,
          updatedAt: 2,
        },
        {
          archived: true,
          category: "Research",
          key: archivedKey,
          kind: "direct",
          label: "Cached archived child",
          spawnedBy: parentKey,
          updatedAt: 1,
        },
      ],
      ts: 1,
    });
    harness.publish({ groups: ["Research"] });

    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());

    const research = sidebar.querySelector('[data-session-section="category:Research"]');
    await waitForFast(() =>
      expect(research?.querySelectorAll(`[data-session-key="${categorizedKey}"]`)).toHaveLength(1),
    );
    expect(
      sidebar.querySelector(
        `[data-session-tree="${parentKey}"] [data-session-key="${ordinaryKey}"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull();

    harness.publishList({
      result: {
        ...harness.sessions.state.result!,
        count: 2,
        sessions: [
          parent!,
          {
            key: categorizedKey,
            kind: "direct",
            label: "Current ordinary child",
            spawnedBy: parentKey,
            updatedAt: 4,
          },
        ],
      },
    });
    await waitForFast(() => {
      const rows = sidebar.querySelectorAll(`[data-session-key="${categorizedKey}"]`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("Current ordinary child");
      expect(rows[0]?.closest(`[data-session-tree="${parentKey}"]`)).not.toBeNull();
    });
    expect(sidebar.textContent).not.toContain("Cached categorized child");
    expect(
      sidebar.querySelector(
        `[data-session-section="category:Research"] [data-session-key="${categorizedKey}"]`,
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        `[data-session-tree="${parentKey}"] [data-session-key="${ordinaryKey}"]`,
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${archivedKey}"]`)).toBeNull();
  });
});
