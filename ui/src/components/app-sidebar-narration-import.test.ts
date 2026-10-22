/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

const narration = vi.hoisted(() => ({ create: vi.fn() }));

// mock-isolation: fail optional narration initialization without replacing the sidebar owner.
vi.mock("./app-sidebar-session-narration.ts", async (original) => {
  const module = await original<typeof import("./app-sidebar-session-narration.ts")>();
  narration.create
    .mockImplementationOnce(() => {
      throw new Error("Narration chunk unavailable");
    })
    .mockImplementation(module.createSidebarNarration);
  return { ...module, createSidebarNarration: narration.create };
});

it("keeps navigation usable after narration fails and retries on live-activity reactivation", async () => {
  const { sidebar } = await mountSidebar(
    createGateway(createTestGatewayClient(vi.fn().mockResolvedValue({}))),
    createSessions("main", ["agent:main:main"]),
  );
  await waitForSolid(() => expect(narration.create).toHaveBeenCalledTimes(1));
  const row = sidebar.querySelector('[data-session-key="agent:main:main"]');
  expect(row).not.toBeNull();
  expect(sidebar.narration).toBeNull();
  sidebar.sidebarLiveActivity = false;
  await sidebar.updateComplete;
  sidebar.sidebarLiveActivity = true;
  await waitForSolid(() => expect(sidebar.narration).not.toBeNull());
  expect(narration.create).toHaveBeenCalledTimes(2);
  expect(sidebar.querySelector('[data-session-key="agent:main:main"]')).toBe(row);
});
