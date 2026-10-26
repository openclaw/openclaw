import { expect, it, vi } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { getAppSidebarOwner } from "./app-sidebar.tsx";
import { publishSidebarSessionList } from "./session-data-events.ts";
import "../test-helpers/load-styles.ts";

setupSidebarTest();

it("keeps unrelated publications out of mounted row access and subtitle preparation", async () => {
  const keys = Array.from({ length: 80 }, (_, i) => `agent:main:work-${i}`);
  const sessions = createSessionsHarness("main", keys);
  Object.assign(sessions.sessions.state.result!.sessions[0]!, {
    lastMessagePreview: "Row subtitle probe",
    sharingRole: "owner",
  });
  const client = createTestGatewayClient(vi.fn(async () => ({ questions: [] })));
  const gateway = createGatewayHarness(client);
  gateway.publish({
    hello: gatewayHelloForMethods(["sessions.patch", "sessions.groups.put"], ["operator.write"]),
  });
  const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
  sidebar.style.cssText = "display:block;width:320px;height:600px";
  const viewport = sidebar.querySelector<HTMLElement>(".sidebar-shell__body")!;
  viewport.style.cssText = "height:500px;flex:none;overflow:auto";
  sidebar.connected = true;
  sidebar.sessionsShowPreview = true;
  const owner = getAppSidebarOwner(sidebar.hostElement)!;
  owner.setVisibleSessionLimit("ungrouped", 80);
  await waitForSolid(() => {
    const rows = sidebar.querySelectorAll("[data-session-key]");
    expect(rows.length).toBeLessThan(40);
    expect(rows.item(rows.length - 1)?.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
  });
  await settleLitElement(sidebar);
  const publishList = (result: SessionsListResult) => {
    sessions.publishList({ result });
    publishSidebarSessionList(owner.sessionData, {
      result,
      agentId: "main",
      loading: false,
      error: null,
    });
    owner.sessionData.requestSessionDataUpdate();
  };
  const access = vi.spyOn(owner, "readSessionMutationAccess");
  // oxlint-disable-next-line typescript/unbound-method -- Replay with the intercepted string receiver below.
  const trim = String.prototype.trim;
  let subtitlePreparations = 0;
  vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
    if (this === "Row subtitle probe") {
      subtitlePreparations++;
    }
    return trim.call(this);
  });
  const first = sidebar.querySelector(`[data-session-key="${keys[0]}"]`)!;
  for (const [index, update] of [
    () => {
      sidebar.devGitBranch = "cosmetic-update";
    },
    () => {
      const result = sessions.sessions.state.result!;
      publishList({
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === keys[1] ? Object.assign({}, row, { label: "Changed other row" }) : row,
        ),
      });
    },
  ].entries()) {
    access.mockClear();
    subtitlePreparations = 0;
    update();
    await waitForSolid(() =>
      expect(sidebar.textContent).toContain(index === 0 ? "cosmetic-update" : "Changed other row"),
    );
    await settleLitElement(sidebar);
    expect(sidebar.querySelector(`[data-session-key="${keys[0]}"]`)).toBe(first);
    expect
      .soft(access)
      .not.toHaveBeenCalledWith(
        expect.objectContaining({ session: expect.objectContaining({ key: keys[0] }) }),
      );
    expect
      .soft(access.mock.calls.filter(([request]) => request.method === "sessions.groups.put"))
      .toHaveLength(0);
    expect.soft(subtitlePreparations).toBe(0);
  }

  expect(sidebar.textContent).toContain("Changed other row");
  const link = first.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link")!;
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
  await settleLitElement(sidebar);
  expect(sidebar.selectedSessionKeys.has(keys[0]!)).toBe(true);
  expect(first.classList.contains("sidebar-recent-session--selected")).toBe(true);
  sidebar.onNavigate = vi.fn();
  link.click();
  expect(sidebar.onNavigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main/work-0" });

  const currentRow = () => sidebar.querySelector(`[data-session-key="${keys[0]}"]`)!;
  const archive = () =>
    currentRow().querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!;
  expect(archive().disabled).toBe(false);
  const publishFirst = (fields: {
    sharingRole?: "owner" | "viewer";
    lastMessagePreview?: string;
  }) => {
    const result = sessions.sessions.state.result!;
    publishList({
      ...result,
      sessions: result.sessions.map((row) =>
        row.key === keys[0] ? Object.assign({}, row, fields) : row,
      ),
    });
  };
  publishFirst({ sharingRole: "viewer" });
  await waitForSolid(() => expect(archive().disabled).toBe(true));
  publishFirst({ sharingRole: "owner", lastMessagePreview: "Updated preview" });
  await waitForSolid(() => {
    expect(archive().disabled).toBe(false);
    expect(currentRow().textContent).toContain("Updated preview");
  });
  gateway.publish({
    hello: gatewayHelloForMethods(["sessions.patch", "sessions.groups.put"], ["operator.read"]),
  });
  // Direct action reads must see revoked authority even before a presentation flush.
  expect(
    owner.readSessionMutationAccess({
      method: "sessions.patch",
      params: { archived: true },
      sessionScope: true,
      session: { sharingRole: "owner" },
    }).allowed,
  ).toBe(false);
  await settleLitElement(sidebar);
  expect(archive().disabled).toBe(true);
  gateway.publish({
    hello: gatewayHelloForMethods(["sessions.patch", "sessions.groups.put"], ["operator.write"]),
  });
  sidebar.sessionsShowPreview = false;
  await settleLitElement(sidebar);
  expect(currentRow().textContent).not.toContain("Updated preview");
});
