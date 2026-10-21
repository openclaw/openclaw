import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import { sessionList } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

const parentKey = "agent:main:parent";
const childKeys = Array.from(
  { length: 6 },
  (_, index) => `agent:main:dashboard:child-${index + 1}`,
);

async function mountChildSessions(extraRows: GatewaySessionRow[] = []) {
  const harness = createSessionsHarness("main", [parentKey]);
  const children = childKeys.map((key, index) => ({
    key,
    spawnedBy: parentKey,
    kind: "direct" as const,
    updatedAt: index + 1,
  }));
  harness.list.mockResolvedValue({
    ...sessionList([...children, ...extraRows], 100_000),
    count: childKeys.length,
  });
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({
    result: sessionList([
      {
        key: parentKey,
        kind: "direct",
        updatedAt: 1,
        childSessions: childKeys,
      },
    ]),
  });
  await sidebar.updateComplete;
  return { sidebar, find: sidebar.querySelector.bind(sidebar) };
}

it("caps visible children until requested and resets the cap after collapse", async () => {
  const { sidebar, find } = await mountChildSessions();
  const expectChildren = (count: number) =>
    waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(count),
    );

  const toggle = find<HTMLButtonElement>("[data-child-session-toggle]");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  await expectChildren(4);
  const showMore = find<HTMLButtonElement>("[data-show-more-children]");
  expect({
    text: showMore?.textContent?.trim(),
    label: showMore?.getAttribute("aria-label"),
  }).toEqual({ text: "Show 2 more", label: "Show 2 more" });

  showMore?.click();
  await expectChildren(6);
  expect(find("[data-show-more-children]")).toBeNull();

  toggle?.click();
  await sidebar.updateComplete;
  toggle?.click();
  await expectChildren(4);
  expect(find("[data-show-more-children]")?.textContent).toContain("Show 2 more");
});

it("keeps live children visible past the cap", async () => {
  const { find } = await mountChildSessions([
    {
      key: "agent:main:dashboard:grandchild",
      spawnedBy: childKeys[5],
      kind: "direct",
      updatedAt: 10,
      status: "running",
      hasActiveRun: true,
    },
  ]);

  expect(find(`[data-child-session-toggle="${parentKey}"]`)?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  await waitForFast(() => expect(find(`[data-session-key="${childKeys[5]}"]`)).not.toBeNull());
  expect(find(`[data-session-key="${childKeys[4]}"]`)).toBeNull();
  expect(find("[data-show-more-children]")?.textContent?.trim()).toBe("Show 1 more");
});
