import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayHarness, mountSidebar } from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar child session archives", () => {
  it.each([
    { scenario: "archive", coldLoad: false, unrelated: false },
    { scenario: "cold archived load", coldLoad: true, unrelated: false },
    {
      scenario: "completed window excludes a known unrelated row",
      coldLoad: true,
      unrelated: true,
    },
  ])("updates child disclosure after $scenario", async ({ coldLoad, unrelated }) => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:child";
    const parent: GatewaySessionRow = {
      key: parentKey,
      sessionId: "parent-id",
      kind: "direct",
      label: "Parent task",
      updatedAt: 1,
      childSessions: [childKey],
    };
    const child: GatewaySessionRow = {
      key: childKey,
      sessionId: "child-id",
      ...(unrelated ? {} : { parentSessionKey: parentKey }),
      kind: "direct",
      label: "Child task",
      updatedAt: 2,
    };
    let archived = coldLoad && !unrelated;
    let revision = 2;
    const request = createGatewayRequestMock(async (method, params) => {
      const query = isRecord(params) ? params : undefined;
      if (method === "sessions.list") {
        const currentChild = { ...child, archived, updatedAt: revision };
        return sessionsResult(
          query?.spawnedBy === parentKey
            ? archived || unrelated
              ? []
              : [currentChild]
            : archived && query?.archived !== "all"
              ? [parent]
              : [parent, currentChild],
          revision,
        );
      }
      if (method === "sessions.patch") {
        expect(query).toMatchObject({ key: childKey });
        archived = query?.archived === true;
        revision += 1;
        return {
          ok: true,
          key: childKey,
          path: "",
          entry: {
            sessionId: child.sessionId,
            updatedAt: revision,
            ...(archived ? { archivedAt: revision } : {}),
          },
        };
      }
      if (method === "sessions.describe") {
        return {
          session: query?.key === parentKey ? parent : { ...child, archived, updatedAt: revision },
        };
      }
      return {};
    });
    const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
    gatewayHarness.publish({ sessionKey: parentKey });
    const sessions = createTestSessionCapability(gatewayHarness.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar } = await mountSidebar(gatewayHarness.gateway, sessions);
    sidebar.connected = true;
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = parentKey;
    await sidebar.updateComplete;
    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.getAttribute("aria-label")).toBe("Show 1 child sessions for Parent task");
    toggle!.click();
    if (coldLoad) {
      await waitForFast(() =>
        expect(sidebar.sessionData.loadedChildSessionKeys.has(parentKey)).toBe(true),
      );
      expect(sessions.archiveVisibility(childKey)).toBeUndefined();
    } else {
      await waitForFast(() =>
        expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
      );
      const archive = sidebar.querySelector<HTMLButtonElement>(
        `[data-session-key="${childKey}"] [data-sidebar-session-archive]`,
      );
      expect(archive?.disabled).toBe(false);
      archive!.click();
      await waitForFast(() => expect(sessions.archiveVisibility(childKey)).toBe("archived"));
    }
    await sidebar.updateComplete;
    expect(sidebar.querySelector("[data-child-session-toggle]")).toBeNull();
    if (unrelated) {
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull();
      expect(
        sidebar.querySelector(
          `[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`,
        ),
      ).toBeNull();
      return;
    }
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    const selectStatus = async (value: string) => {
      sidebar
        .querySelector<HTMLButtonElement>(".sidebar-session-toolbar .sidebar-session-sort")!
        .click();
      await sidebar.updateComplete;
      sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value } },
        }),
      );
      await sidebar.updateComplete;
    };
    await selectStatus("status:all");
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
    );
    expect(sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-label")).toBe(
      "Hide 1 child sessions for Parent task",
    );
    sidebar
      .querySelector<HTMLButtonElement>(
        `[data-session-key="${childKey}"] [data-sidebar-session-archive]`,
      )!
      .click();
    await waitForFast(() => expect(archived).toBe(false));
    await selectStatus("status:active");
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
    );
    expect(sidebar.querySelector("[data-child-session-toggle]")?.getAttribute("aria-label")).toBe(
      "Hide 1 child sessions for Parent task",
    );
  });
});
