/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { AppSidebarOwner, type AppSidebarElement } from "./app-sidebar.tsx";
import { captureSidebarSnapshotModel } from "./sidebar-snapshot-capture.ts";

it("captures only stable boot-row display fields without persisting live authority", () => {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
    { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  );
  const roster = captureBootRoster({
    agentId: "main",
    groups: [],
    groupSettings: [],
    sectionOrder: [],
    loading: false,
    error: null,
    result: sessionsResult(
      [
        {
          key: "agent:main:cedar",
          kind: "direct",
          displayName: "Cedar",
          boardFace: "dashboard",
          sharingRole: "owner",
          hasActiveRun: true,
          activeRunIds: ["must-not-persist"],
          owner: { actor: { type: "human", id: "operator", label: "Riley" } },
        },
      ],
      1,
    ),
  });
  vi.spyOn(context.sessions, "captureBootRoster").mockReturnValue(roster);
  // SAFETY: importing app-sidebar registers this typed custom element.
  const props = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  props.sidebarAgentsMode = "chip";
  const host = new AppSidebarOwner(
    { dashboards: null, loadMoreDashboards() {} },
    props,
    context,
    props,
  );
  host.sidebarPluginSnapshot = { entries: [], plugins: [] };
  const captured = captureSidebarSnapshotModel(host, context, [], []);
  expect(captured?.roster?.result.sessions).toEqual([
    {
      key: "agent:main:cedar",
      kind: "direct",
      displayName: "Cedar",
      boardFace: "dashboard",
      owner: { actor: { type: "human", id: "operator", label: "Riley" } },
    },
  ]);
  expect(JSON.stringify(captured)).not.toMatch(/sharingRole|hasActiveRun|must-not-persist/);
});
