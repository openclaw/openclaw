import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { sessionList } from "./compact.test-support.ts";
import "../../components/app-sidebar.tsx";

it.each([
  {
    parentKey: "agent:main:parent",
    childKey: "agent:worker:child",
    failure: "OPENAI_API_KEY=sk-1234567890abcdef",
    visible: "OPENAI_API_KEY=sk-123...cdef",
    label: "Recovered child",
  },
  {
    parentKey: "main",
    childKey: "agent:main:dashboard:recovered",
    failure: "main session children temporarily unavailable",
    visible: "main session children temporarily unavailable",
    label: "Recovered main-session child",
  },
])(
  "recovers $parentKey with an accessible, redacted retry action",
  async ({ parentKey, childKey, failure, visible, label }) => {
    const harness = createSessionsHarness("main", [parentKey]);
    const parent = {
      key: parentKey,
      kind: "direct" as const,
      updatedAt: 1,
      childSessions: [childKey],
    };
    harness.list
      .mockRejectedValueOnce(new Error(failure))
      .mockResolvedValueOnce(
        sessionList([{ key: childKey, spawnedBy: parentKey, kind: "direct", label, updatedAt: 2 }]),
      );
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    const find = sidebar.querySelector.bind(sidebar);
    const error = () => find(`[data-child-session-error="${parentKey}"]`);
    harness.publishList({ result: sessionList([parent]) });
    if (parentKey !== "main") {
      await settleLitElement(sidebar);
      expect(find("[data-child-session-toggle]")?.getAttribute("aria-expanded")).toBe("true");
    } else {
      await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
      expect(
        sidebar.querySelectorAll(".sidebar-rail__bottom .sidebar-footer-bar__home"),
      ).toHaveLength(1);
      expect(find(`[data-session-key="${parentKey}"]`)).toBeNull();
    }
    await waitForFast(() =>
      expect({
        role: error()?.getAttribute("role"),
        textContent: error()?.textContent,
      }).toMatchObject({
        role: "alert",
        textContent: expect.stringContaining(visible),
      }),
    );
    if (failure !== visible) {
      const mountedAlert = error();
      harness.publishList({ result: sessionList([{ ...parent, updatedAt: 2 }]) });
      await settleLitElement(sidebar);
      expect(harness.list).toHaveBeenCalledOnce();
      expect(error()).toBe(mountedAlert);
      expect(sidebar.textContent).not.toContain(failure);
    }
    const retry = find<HTMLButtonElement>(`[data-retry-child-sessions="${parentKey}"]`);
    expect(retry?.textContent).toContain("Retry");
    retry?.click();
    await waitForFast(() => {
      expect(harness.list).toHaveBeenCalledTimes(2);
      expect(find("[data-child-session-error]")).toBeNull();
      expect(sidebar.textContent).toContain(label);
      expect(find(`[data-session-key="${childKey}"]`)).not.toBeNull();
    });
    if (parentKey === "main") {
      expect(find(`[data-session-key="${parentKey}"]`)).toBeNull();
    }
  },
);
