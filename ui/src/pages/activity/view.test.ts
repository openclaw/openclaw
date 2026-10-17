/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderCurrentWork } from "./current-work-view.tsx";
import { mountSolid } from "./session-activity-view.test-harness.ts";

const renderCurrentWorkSolid = mountSolid(renderCurrentWork);
function renderWork(
  container: HTMLElement,
  sessions: NonNullable<Parameters<typeof renderCurrentWork>[0]["result"]>["sessions"],
  loading = false,
) {
  renderCurrentWorkSolid(
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
      result: {
        ts: 1,
        path: "",
        count: sessions.length,
        sessions,
        defaults: { model: null, modelProvider: null, contextTokens: null },
      },
    },
    container,
  );
}

describe("renderCurrentWork", () => {
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
        sessionId: "raw-global",
        kind: "global",
        label: "Existing global work",
        hasActiveRun: true,
      },
      {
        key: "agent:work:global",
        agentId: "work",
        sessionId: "literal-global",
        kind: "direct",
        hasActiveRun: true,
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
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "No active sessions.",
    );
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
  });
});
