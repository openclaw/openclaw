import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import { sessionList } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

it("shows a categorized Discord-spawned dashboard session on a cold sidebar without its parent", async () => {
  const officeKey = "agent:main:dashboard:office-ha";
  const wakeKey = "agent:main:dashboard:wake-word";
  const archivedKey = "agent:main:dashboard:archived";
  const parentKey = "agent:main:discord:channel:parent";
  const harness = createSessionsHarness("main", [officeKey, wakeKey, archivedKey]);
  const rows = harness.sessions.state.result!.sessions;
  rows.forEach((row, index) =>
    Object.assign(row, {
      category: "HOME ASSISTANT",
      archived: index === 2,
    }),
  );
  Object.assign(rows[0]!, {
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    createdVia: "spawn",
    createdActor: { type: "agent" },
  });
  harness.publish({ groups: ["HOME ASSISTANT"] });
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
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
  const parent = harness.sessions.state.result!.sessions[0]!;
  parent.childSessions = [categorizedKey, ordinaryKey, archivedKey];
  const child = (
    key: string,
    label: string,
    updatedAt: number,
    extra: Partial<GatewaySessionRow> = {},
  ) => ({
    key,
    label,
    updatedAt,
    ...extra,
    kind: "direct" as const,
    spawnedBy: parentKey,
  });
  harness.list.mockResolvedValue(
    sessionList(
      [
        child(categorizedKey, "Cached categorized child", 3, { category: "Research" }),
        child(ordinaryKey, "Cached ordinary child", 2),
        child(archivedKey, "Cached archived child", 1, { category: "Research", archived: true }),
      ],
      1,
    ),
  );
  harness.publish({ groups: ["Research"] });

  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  const find = sidebar.querySelector.bind(sidebar);
  const tree = `[data-session-tree="${parentKey}"]`;
  const ordinaryChild = () => find(`${tree} [data-session-key="${ordinaryKey}"]`);
  find<HTMLButtonElement>("[data-child-session-toggle]")?.click();
  await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());

  const researchSelector = '[data-session-section="category:Research"]';
  const research = find(researchSelector);
  await waitForFast(() =>
    expect(research?.querySelectorAll(`[data-session-key="${categorizedKey}"]`)).toHaveLength(1),
  );
  expect(ordinaryChild()).not.toBeNull();
  expect(find(`[data-session-key="${archivedKey}"]`)).toBeNull();

  harness.publishList({
    result: {
      ...harness.sessions.state.result!,
      count: 2,
      sessions: [parent, child(categorizedKey, "Current ordinary child", 4)],
    },
  });
  await waitForFast(() => {
    const rows = sidebar.querySelectorAll(`[data-session-key="${categorizedKey}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Current ordinary child");
    expect(rows[0]?.closest(tree)).not.toBeNull();
  });
  expect(sidebar.textContent).not.toContain("Cached categorized child");
  expect(find(`${researchSelector} [data-session-key="${categorizedKey}"]`)).toBeNull();
  expect(ordinaryChild()).not.toBeNull();
  expect(find(`[data-session-key="${archivedKey}"]`)).toBeNull();
});
