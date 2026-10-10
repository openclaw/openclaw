/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createGatewayHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.ts";

function drag(
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

it("drags a nested conversation into the top level and keeps its history identity", async () => {
  const parent: GatewaySessionRow = {
    key: "agent:main:parent",
    sessionId: "parent-id",
    kind: "direct",
    label: "Public thread access",
    updatedAt: 1,
    childSessions: ["agent:main:child"],
  };
  let child: GatewaySessionRow = {
    key: "agent:main:child",
    sessionId: "child-id",
    kind: "direct",
    label: "Reconcile short URLs",
    updatedAt: 2,
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
  };
  const request = createGatewayRequestMock(async (method, params) => {
    const query = isRecord(params) ? params : undefined;
    if (method === "sessions.list") {
      return sessionsResult(
        query?.spawnedBy === parent.key ? [child] : [parent, child],
        child.updatedAt ?? 1,
      );
    }
    if (method === "sessions.describe") {
      return { session: query?.key === parent.key ? parent : child };
    }
    if (method === "sessions.patch") {
      expect(query).toMatchObject({
        key: child.key,
        expectedSessionId: child.sessionId,
        sidebarRoot: true,
      });
      child = { ...child, sidebarRoot: true, updatedAt: 3 };
      return { ok: true, key: child.key, path: "", entry: { ...child } };
    }
    return {};
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({ sessionKey: parent.key });
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions);
  sidebar.connected = true;
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = parent.key;
  await sidebar.updateComplete;
  sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
  await waitForFast(() =>
    expect(sidebar.querySelector(".sidebar-recent-session--child")).not.toBeNull(),
  );
  const row = sidebar.querySelector<HTMLElement>(".sidebar-recent-session--child")!;
  expect(row.getAttribute("draggable")).toBe("true");
  const data = createDataTransferStub();
  drag(row, "dragstart", data);
  await sidebar.updateComplete;
  const drop = sidebar.querySelector("[data-session-root-drop]");
  expect(drop?.textContent).toContain("Move to top level");
  drag(drop!, "dragover", data);
  drag(drop!, "drop", data);
  await waitForFast(() => expect(child.sidebarRoot).toBe(true));
  await waitForFast(() =>
    expect(
      sidebar
        .querySelector('[data-session-key="agent:main:child"]')
        ?.classList.contains("sidebar-recent-session--child"),
    ).toBe(false),
  );
  expect(child).toMatchObject({
    sessionId: "child-id",
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
  });
  expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
});
