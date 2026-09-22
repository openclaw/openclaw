import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

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
  it.each([false, true])(
    "retries a failed child load after collapsing and reopening the parent (intervening run: %s)",
    async (interveningRun) => {
      const parentKey = "agent:main:parent";
      const runKey = "agent:main:subagent:delegating-run";
      const childKey = "agent:worker:child";
      const loadParentKey = interveningRun ? runKey : parentKey;
      const run = { ...parentSession(runKey, childKey), spawnedBy: parentKey };
      const gateway = createGateway({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", [parentKey]);
      let attempts = 0;
      harness.list.mockImplementation(async (options) => {
        if (interveningRun && options?.spawnedBy === parentKey) {
          return sessionResult([run]);
        }
        if (options?.spawnedBy !== loadParentKey) {
          throw new Error(`Unexpected child query: ${options?.spawnedBy}`);
        }
        if (attempts++ === 0) {
          throw new Error("temporary list failure");
        }
        return sessionResult([recoveredChild(childKey, loadParentKey, "Recovered child")]);
      });
      const { sidebar } = await mountSidebar(gateway, harness.sessions);
      harness.publishList({
        result: sessionResult([
          parentSession(parentKey, interveningRun ? runKey : childKey),
          ...(interveningRun ? [run] : []),
        ]),
      });
      await sidebar.updateComplete;
      const toggle = () =>
        sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)!;
      toggle().click();
      await waitForFast(() => {
        const alert = sidebar.querySelector(
          `[data-session-tree="${parentKey}"] [data-child-session-error]`,
        );
        expect(alert?.getAttribute("role")).toBe("alert");
        expect(alert?.textContent).toContain("temporary list failure");
      });
      expect(attempts).toBe(1);
      expect(sidebar.querySelector(`[data-session-key="${runKey}"]`)).toBeNull();
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();

      toggle().click();
      await sidebar.updateComplete;
      toggle().click();
      await waitForFast(() =>
        expect(
          sidebar.querySelector(
            `[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`,
          )?.textContent,
        ).toContain("Recovered child"),
      );
      expect(attempts).toBe(2);
      expect(sidebar.querySelector(`[data-session-key="${runKey}"]`)).toBeNull();
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
    },
  );

  it.each([
    {
      failure: "temporary list failure",
      visibleError: "temporary list failure",
    },
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
      await sidebar.updateComplete;
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
      await sidebar.updateComplete;
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

  it("keeps failures and retry state scoped to their parent", async () => {
    const firstParent = "agent:main:first-parent";
    const secondParent = "agent:main:second-parent";
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [firstParent, secondParent]);
    let firstAttempts = 0;
    harness.list.mockImplementation(async (options) => {
      const parentKey = options?.spawnedBy;
      if (parentKey === secondParent || firstAttempts++ === 0) {
        throw new Error(`${parentKey} temporarily unavailable`);
      }
      return sessionResult([
        recoveredChild("agent:worker:first-child", firstParent, "Recovered first child"),
      ]);
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: sessionResult(
        [firstParent, secondParent].map((parentKey) =>
          parentSession(parentKey, `${parentKey}:child`),
        ),
      ),
    });
    await sidebar.updateComplete;
    for (const parentKey of [firstParent, secondParent]) {
      sidebar
        .querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)
        ?.click();
    }
    await waitForFast(() =>
      expect(sidebar.querySelectorAll("[data-child-session-error]")).toHaveLength(2),
    );

    sidebar
      .querySelector<HTMLButtonElement>(`[data-retry-child-sessions="${firstParent}"]`)
      ?.click();

    await waitForFast(() => expect(sidebar.textContent).toContain("Recovered first child"));
    expect(sidebar.querySelector(`[data-child-session-error="${firstParent}"]`)).toBeNull();
    expect(
      sidebar.querySelector(`[data-child-session-error="${secondParent}"]`)?.textContent,
    ).toContain(secondParent);
  });

  it.each(["main", "agent:main:main"])(
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
      expect(sidebar.querySelectorAll(".nav-item--home")).toHaveLength(1);
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
