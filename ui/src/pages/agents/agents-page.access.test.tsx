/* @vitest-environment jsdom */

import { onTestFinished, describe, expect, it, vi } from "vitest";
import type { AgentsPanel } from "../../lib/agents/panels.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsRouteData,
  createAgentsPage,
  emitGatewaySnapshot,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { Agents } from "./view.tsx";

const methods = [
  "agents.list",
  "agent.identity.get",
  "config.get",
  "agents.files.list",
  "agents.files.get",
  "skills.status",
  "channels.status",
  "cron.list",
  "cron.status",
  "doctor.memory.status",
  "doctor.memory.dreamDiary",
  "tools.catalog",
  "tools.effective",
  "models.list",
];

function restrictedPage(panel: AgentsPanel, scopes = ["operator.sessions.read"], pending = false) {
  const request = vi.fn(async (method: string) => {
    if (method === "tools.effective") {
      return { agentId: "main", profile: "full", groups: [] };
    }
    if (method === "models.list") {
      return { models: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const currentGateway = gateway({
    ...snapshot(createTestGatewayClient(request)),
    hello: pending ? null : gatewayHelloForMethods(methods, scopes),
  });
  const files = vi.fn(async () => ({ agentId: "main", workspace: "", files: [] }));
  const context = pageContext(currentGateway, agentsCapability(files));
  const channels = createChannelCapability(currentGateway);
  onTestFinished(() => channels.dispose());
  Object.assign(context, { acquireChannels: () => channels });
  const ensureLoaded = vi.fn(async () => {});
  Object.assign(context.runtimeConfig, { ensureLoaded });
  const page = createAgentsPage(context, {
    ...agentsRouteData(currentGateway, undefined, "main", context.settingsAgentSelection),
    panel,
  });
  const mounted = mountSolid(() => <Agents {...page.read()} />);
  return { ...mounted, page, context, currentGateway, request, files, ensureLoaded };
}

describe("Agent Settings access at the page boundary", () => {
  it.each(["files", "skills", "channels", "cron", "memory"] as const)(
    "settles a direct %s URL without mounting unavailable content or making forbidden reads",
    async (panel) => {
      const view = restrictedPage(panel);
      await vi.dynamicImportSettled();
      await waitForSolid(() =>
        expect(view.container.querySelector(".agent-panel-restricted")).not.toBeNull(),
      );
      expect([...view.container.querySelectorAll(".hub-tab")].map((tab) => tab.id)).toEqual([
        "agents-tab-overview",
        "agents-tab-tools",
      ]);
      expect(view.container.querySelector(".settings-loading-skeleton")).toBeNull();
      expect(view.container.querySelector(".agent-panel-restricted button")).toBeNull();
      expect(view.files).not.toHaveBeenCalled();
      expect(view.ensureLoaded).not.toHaveBeenCalled();
      expect(view.request).not.toHaveBeenCalled();
    },
  );

  it("settles unknown access as denied, then admits a read when access changes", async () => {
    const view = restrictedPage("files", [], true);
    expect(view.container.querySelector(".settings-loading-skeleton")).not.toBeNull();
    expect(view.container.querySelector(".agent-panel-restricted")).toBeNull();
    emitGatewaySnapshot(view.currentGateway, {
      ...view.currentGateway.snapshot,
      hello: gatewayHelloForMethods(methods, ["operator.sessions.read"]),
    });
    await waitForSolid(() =>
      expect(view.container.querySelector(".agent-panel-restricted")).not.toBeNull(),
    );
    expect(view.container.querySelector(".settings-loading-skeleton")).toBeNull();
    expect(view.files).not.toHaveBeenCalled();
    emitGatewaySnapshot(view.currentGateway, {
      ...view.currentGateway.snapshot,
      hello: gatewayHelloForMethods(methods, ["operator.read"]),
    });
    await waitForSolid(() => expect(view.files).toHaveBeenCalled());
    expect(view.container.querySelector("#agents-tab-files")).not.toBeNull();
    expect(view.container.querySelector(".agent-panel-restricted")).toBeNull();
    expect(view.page.read().access.canWriteFiles).toBe(false);
    expect(view.container.querySelector(".agents-create-btn")).toBeNull();
  });

  it("retains readable overview facts without links to unavailable management panels", async () => {
    const view = restrictedPage("overview");
    await waitForSolid(() =>
      expect(view.container.querySelector(".agent-overview")).not.toBeNull(),
    );
    expect(view.container.querySelectorAll(".agent-overview .settings-nav-row")).toHaveLength(0);
    expect(view.container.querySelector(".agent-overview")?.textContent).toContain("Workspace");
    expect(view.container.querySelector(".agent-overview")?.textContent).toContain("Skills filter");
    expect(view.container.textContent).not.toContain("Agent defaults");
    expect(view.container.querySelector(".agents-create-btn")).toBeNull();
  });

  it("keeps the session-authorized Tools preview without config or catalog reads", async () => {
    const view = restrictedPage("tools");
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(view.request).toHaveBeenCalledWith("tools.effective", {
        agentId: "main",
        sessionKey: "main",
      }),
    );
    expect(view.container.querySelector("#agents-tab-tools")).not.toBeNull();
    expect(view.container.querySelector(".agent-panel-restricted")).toBeNull();
    expect(view.ensureLoaded).not.toHaveBeenCalled();
    expect(view.request.mock.calls.map(([method]) => method)).toEqual(["tools.effective"]);
  });
});
