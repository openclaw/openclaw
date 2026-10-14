import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

function sessionResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 2,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function parentSession(key: string, childKey: string) {
  return { key, kind: "direct" as const, updatedAt: 1, childSessions: [childKey] };
}

function recoveredChild(key: string, parentKey: string, label: string) {
  return { key, spawnedBy: parentKey, kind: "direct" as const, label, updatedAt: 2 };
}

describe("AppSidebar child-session load errors", () => {
  it.each([
    {
      failure: "OPENAI_API_KEY=sk-1234567890abcdef",
      visibleError: "OPENAI_API_KEY=sk-123...cdef",
    },
  ])(
    "surfaces $visibleError with an accessible retry action",
    async ({ failure, visibleError }) => {
      const parentKey = "agent:main:parent";
      const childKey = "agent:worker:child";
      const gateway = createGateway({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", [parentKey]);
      harness.list
        .mockRejectedValueOnce(new Error(failure))
        .mockResolvedValueOnce(
          sessionResult([recoveredChild(childKey, parentKey, "Recovered child")]),
        );
      const { sidebar } = await mountSidebar(gateway, harness.sessions);
      harness.publishList({ result: sessionResult([parentSession(parentKey, childKey)]) });
      await settleLitElement(sidebar);
      sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();

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
      if (failure !== visibleError) {
        expect(sidebar.textContent).not.toContain(failure);
      }

      const retry = sidebar.querySelector<HTMLButtonElement>(
        `[data-retry-child-sessions="${parentKey}"]`,
      );
      expect(retry?.textContent).toContain("Retry");
      retry?.click();

      await waitForFast(() => expect(sidebar.textContent).toContain("Recovered child"));
      expect(harness.list).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
    },
  );

  it.each(["main"])(
    "keeps Home unique while recovering conversations spawned by %s",
    async (parentKey) => {
      const childKey = "agent:main:dashboard:recovered";
      const gateway = createGateway({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", [parentKey]);
      harness.list
        .mockRejectedValueOnce(new Error("main session children temporarily unavailable"))
        .mockResolvedValueOnce(
          sessionResult([recoveredChild(childKey, parentKey, "Recovered main-session child")]),
        );
      const { sidebar } = await mountSidebar(gateway, harness.sessions);
      harness.publishList({ result: sessionResult([parentSession(parentKey, childKey)]) });

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

      sidebar
        .querySelector<HTMLButtonElement>(`[data-retry-child-sessions="${parentKey}"]`)
        ?.click();

      await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(sidebar.querySelector("[data-child-session-error]")).toBeNull(),
      );
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
      );
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
    },
  );
});
