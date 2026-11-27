/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderCurrentWork } from "./current-work-view.tsx";
import { sessionActivityListing } from "./session-activity-controller.test-support.ts";
import { mountSolid } from "./session-activity-view.test-harness.ts";

function renderWork(
  container: HTMLElement,
  sessions: NonNullable<Parameters<typeof renderCurrentWork>[0]["result"]>["sessions"],
  loading = false,
) {
  mountSolid(renderCurrentWork)(
    {
      basePath: "/control",
      fallbackAgentId: "main",
      mainKey: "main",
      globalScope: false,
      navigate: vi.fn(),
      connected: true,
      loading,
      incomplete: false,
      onRetry: vi.fn(),
      result: sessionActivityListing(sessions),
    },
    container,
  );
}

let container: HTMLDivElement;
beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.replaceChildren(container);
});

it("keeps raw global status visible without linking to another session outside global scope", async () => {
  renderWork(container, [
    {
      key: "global",
      agentId: "work",
      kind: "global",
      label: "Existing global work",
    },
    {
      key: "agent:work:global",
      agentId: "work",
      kind: "direct",
    },
  ]);
  const raw = container.querySelector('[data-session-key="global"]');
  expect(raw?.textContent).toContain("Existing global work");
  expect(raw?.tagName).toBe("DIV");
  expect(raw?.hasAttribute("href")).toBe(false);
  expect(
    container.querySelector('a[data-session-key="agent:work:global"]')?.getAttribute("href"),
  ).toBe("/control/chat/work/~key/global");
});

it("shows a normal empty snapshot during refresh", () => {
  renderWork(container, [], true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("No active sessions.");
  expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
});
