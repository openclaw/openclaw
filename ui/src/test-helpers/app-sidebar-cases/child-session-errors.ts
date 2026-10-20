import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { sessionList as sessionResult } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

function parentSession(key: string, childKey: string) {
  return { key, kind: "direct" as const, updatedAt: 1, childSessions: [childKey] };
}

function recoveredChild(key: string, parentKey: string, label: string) {
  return { key, spawnedBy: parentKey, kind: "direct" as const, label, updatedAt: 2 };
}

async function mountRecovery(parentKey: string, childKey: string, failure: string, label: string) {
  const harness = createSessionsHarness("main", [parentKey]);
  harness.list
    .mockRejectedValueOnce(new Error(failure))
    .mockResolvedValueOnce(sessionResult([recoveredChild(childKey, parentKey, label)]));
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({ result: sessionResult([parentSession(parentKey, childKey)]) });
  return { sidebar, harness };
}

describe("AppSidebar child-session load errors", () => {
  it("redacts secrets in load errors with an accessible retry action", async () => {
    const failure = "OPENAI_API_KEY=sk-1234567890abcdef";
    const visibleError = "OPENAI_API_KEY=sk-123...cdef";
    const parentKey = "agent:main:parent";
    const childKey = "agent:worker:child";
    const { sidebar, harness } = await mountRecovery(
      parentKey,
      childKey,
      failure,
      "Recovered child",
    );
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-expanded"),
    ).toBe("true");

    await waitForFast(() => {
      const alert = sidebar.querySelector(`[data-child-session-error="${parentKey}"]`);
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toContain(visibleError);
    });
    const mountedAlert = sidebar.querySelector(`[data-child-session-error="${parentKey}"]`);
    harness.publishList({
      result: sessionResult([{ ...parentSession(parentKey, childKey), updatedAt: 2 }]),
    });
    await settleLitElement(sidebar);
    expect(harness.list).toHaveBeenCalledOnce();
    expect(sidebar.querySelector(`[data-child-session-error="${parentKey}"]`)).toBe(mountedAlert);
    expect(sidebar.textContent).not.toContain(failure);

    const retry = sidebar.querySelector<HTMLButtonElement>(
      `[data-retry-child-sessions="${parentKey}"]`,
    );
    expect(retry?.textContent).toContain("Retry");
    retry?.click();

    await waitForFast(() => expect(sidebar.textContent).toContain("Recovered child"));
    expect(harness.list).toHaveBeenCalledTimes(2);
    expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
  });

  it("keeps Home unique while recovering conversations spawned by main", async () => {
    const parentKey = "main";
    const childKey = "agent:main:dashboard:recovered";
    const { sidebar, harness } = await mountRecovery(
      parentKey,
      childKey,
      "main session children temporarily unavailable",
      "Recovered main-session child",
    );

    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
    expect(
      sidebar.querySelectorAll(".sidebar-rail__bottom .sidebar-footer-bar__home"),
    ).toHaveLength(1);
    expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
    await waitForFast(() => {
      const alert = sidebar.querySelector(`[data-child-session-error="${parentKey}"]`);
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toContain("main session children temporarily unavailable");
    });

    sidebar.querySelector<HTMLButtonElement>(`[data-retry-child-sessions="${parentKey}"]`)?.click();

    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(sidebar.querySelector("[data-child-session-error]")).toBeNull());
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
    );
    expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
    expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
  });
});
