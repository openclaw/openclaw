import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
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
  it.each(["disconnect", "client replacement"])(
    "retires a child load after %s without latching a missing-result error",
    async (retirement) => {
      const parentKey = "agent:main:parent";
      const childKey = "agent:worker:child";
      const pending = createDeferred<SessionsListResult | null>();
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      const harness = createSessionsHarness("main", [parentKey]);
      harness.list
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(
          sessionResult([recoveredChild(childKey, parentKey, "Recovered child")]),
        );
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      harness.publishList({ result: sessionResult([parentSession(parentKey, childKey)]) });
      await sidebar.updateComplete;
      const load = sidebar.sessionData.loadChildSessions(parentKey);
      sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
      await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
      gateway.publish(
        retirement === "disconnect"
          ? { phase: "reconnecting" }
          : { client: { instanceId: "replacement" } as GatewayBrowserClient },
      );
      pending.resolve(null);
      await load;
      expect(sidebar.sessionData.childSessionErrorsByParent.size).toBe(0);
      expect(sidebar.sessionData.loadingChildSessionKeys.size).toBe(0);
      await sidebar.updateComplete;
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
      if (retirement === "disconnect") {
        await sidebar.sessionData.loadChildSessions(parentKey);
        expect(harness.list).toHaveBeenCalledOnce();
      }
      gateway.publish({ phase: "connected" });
      harness.publishList({ result: sessionResult([parentSession(parentKey, childKey)]) });
      await sidebar.updateComplete;
      await sidebar.sessionData.loadChildSessions(parentKey);
      expect(harness.list).toHaveBeenCalledTimes(2);
      expect(sidebar.sessionData.childSessionErrorsByParent.size).toBe(0);
      expect(sidebar.sessionData.childSessionRowsByParent[parentKey]?.[0]?.label).toBe(
        "Recovered child",
      );
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
        expect(alert?.querySelector("button")?.getAttribute("aria-label")).toBe(
          "Some sessions could not load. Show details",
        );
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
    "surfaces and retries child failures for the hidden %s main session",
    async (parentKey) => {
      const childKey = "agent:main:subagent:recovered";
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
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
      await waitForFast(() => {
        const alert = sidebar.querySelector(`[data-child-session-error="${parentKey}"]`);
        expect(alert?.querySelector("button")?.getAttribute("aria-label")).toBe(
          "Some sessions could not load. Show details",
        );
        expect(alert?.closest(".sidebar-session-toolbar")).not.toBeNull();
        expect(alert?.textContent).toContain("main session children temporarily unavailable");
      });

      sidebar
        .querySelector<HTMLButtonElement>(`[data-retry-child-sessions="${parentKey}"]`)
        ?.click();

      await waitForFast(() =>
        expect(sidebar.textContent).toContain("Recovered main-session child"),
      );
      expect(harness.list).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
    },
  );
});
