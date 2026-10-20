import { describe, expect, it } from "vitest";
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
    label: `Child ${index + 1}`,
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
        label: "Parent task",
        updatedAt: 1,
        childSessions: childKeys,
      },
    ]),
  });
  await sidebar.updateComplete;
  return sidebar;
}

describe("AppSidebar spawned session cap", () => {
  it("caps visible children until requested and resets the cap after collapse", async () => {
    const sidebar = await mountChildSessions();
    const expectChildren = (count: number) =>
      waitForFast(() =>
        expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(count),
      );

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await expectChildren(4);
    const showMore = sidebar.querySelector<HTMLButtonElement>("[data-show-more-children]");
    expect(showMore?.textContent?.trim()).toBe("Show 2 more");
    expect(showMore?.getAttribute("aria-label")).toBe("Show 2 more");

    showMore?.click();
    await expectChildren(6);
    expect(sidebar.querySelector("[data-show-more-children]")).toBeNull();

    toggle?.click();
    await sidebar.updateComplete;
    toggle?.click();
    await expectChildren(4);
    expect(sidebar.querySelector("[data-show-more-children]")?.textContent).toContain(
      "Show 2 more",
    );
  });

  it("keeps live children visible past the cap", async () => {
    // Quiet child beyond the cap with a running grandchild must bypass it.
    const sidebar = await mountChildSessions([
      {
        key: "agent:main:dashboard:grandchild",
        spawnedBy: childKeys[5],
        kind: "direct",
        label: "Grandchild session",
        updatedAt: 10,
        status: "running",
        hasActiveRun: true,
      },
    ]);

    expect(
      sidebar
        .querySelector('[data-child-session-toggle="agent:main:parent"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-session-key="agent:main:dashboard:child-6"]'),
      ).not.toBeNull(),
    );
    expect(sidebar.querySelector('[data-session-key="agent:main:dashboard:child-5"]')).toBeNull();
    expect(sidebar.querySelector("[data-show-more-children]")?.textContent?.trim()).toBe(
      "Show 1 more",
    );
  });
});
