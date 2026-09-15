/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesListResult, AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  gateway,
  pageContext,
  setPageGateway,
  settingsSelection,
  snapshot,
  type TestAgentsPage,
} from "./agents-page.test-support.ts";
import "./agents-page.ts";

const files = (agentId: string, workspace: string) => ({ agentId, workspace, files: [] });

describe("AgentsPage routing", () => {
  const roster: AgentsListResult = {
    ...agentsList,
    agents: [...agentsList.agents, { id: "research", name: "Research" }],
  };

  it.each([
    { requestedAgentId: "research", selectedId: "main", expectedAgentId: "research" },
    { requestedAgentId: "missing", selectedId: "research", expectedAgentId: "main" },
    { requestedAgentId: null, selectedId: "research", expectedAgentId: "research" },
  ])(
    "resolves $requestedAgentId with the shared Settings selection",
    ({ requestedAgentId, selectedId, expectedAgentId }) => {
      const currentGateway = gateway(snapshot(null, false));
      const selection = settingsSelection(roster, selectedId);
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.context = {
        basePath: "",
        gateway: currentGateway,
        settingsAgentSelection: selection,
      } as unknown as ApplicationContext;
      page.agentsList = roster;
      page.agentsSelectedId = selectedId;
      page.agentFileContents = { "AGENTS.md": "Previous agent's file" };
      page.routeData = {
        ...agentsRouteData(currentGateway, null, requestedAgentId, selection),
        gatewaySnapshot: snapshot(null, false),
        panel: "tools",
      };

      page.willUpdate(new Map([["routeData", undefined]]));

      expect(page.agentsPanel).toBe("tools");
      expect(page.agentsSelectedId).toBe(expectedAgentId);
      expect(selection.state.selectedId).toBe(expectedAgentId);
      expect(page.agentFileContents).toEqual(
        selectedId === expectedAgentId ? { "AGENTS.md": "Previous agent's file" } : {},
      );
    },
  );

  it("keeps a cold deep link while the first roster initializes the default selection", () => {
    const listeners = new Set<() => void>();
    const rosterSource = {
      state: { agentsList: null as AgentsListResult | null },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const selection = createAgentSelectionCapability(
      {
        connection: { gatewayUrl: "ws://settings.test" },
        snapshot: { assistantAgentId: "main" },
        subscribe: () => () => undefined,
      },
      rosterSource,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    );
    const currentGateway = gateway(snapshot(null, false));
    const agents = agentsCapability(async () => files("main", "main"));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
    };
    const preloaded = agentsRouteData(currentGateway, roster, "research", selection);
    page.subscriptions.hostConnected();

    rosterSource.state.agentsList = roster;
    listeners.forEach((listener) => listener());
    expect(selection.state.selectedId).toBe("main");
    expect(page.context.navigate).not.toHaveBeenCalled();

    page.routeData = preloaded;
    page.willUpdate(new Map([["routeData", undefined]]));

    expect(selection.state.selectedId).toBe("research");
    expect(page.agentsSelectedId).toBe("research");
    expect(page.context.navigate).not.toHaveBeenCalled();
    page.subscriptions.hostDisconnected();
    selection.dispose();
  });

  it("does not restore a preloaded agent after a newer sidebar choice, including an ABA change", () => {
    const currentGateway = gateway(snapshot(null, false));
    const selection = settingsSelection(roster, "main");
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const replace = vi.fn();
    page.context = {
      basePath: "",
      gateway: currentGateway,
      settingsAgentSelection: selection,
      replace,
    } as unknown as ApplicationContext;
    page.routeData = agentsRouteData(currentGateway, roster, "research", selection);
    selection.set("research");
    selection.set("main");

    page.willUpdate(new Map([["routeData", undefined]]));

    expect(selection.state.selectedId).toBe("main");
    expect(page.agentsSelectedId).toBe("main");
    expect(replace).toHaveBeenCalledWith("agents", {
      pathname: "/settings/agents/main/files",
      search: "",
      hash: "",
    });
  });

  it("retires the prior agent's pending file request when the sidebar selection changes", async () => {
    const pending = deferred<AgentsFilesListResult>();
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const selection = settingsSelection(roster, "main");
    const agents = {
      ...agentsCapability(() => pending.promise),
      ensureFiles: vi.fn((agentId: string) =>
        agentId === "main" ? pending.promise : Promise.resolve(files("research", "research")),
      ),
    };
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    page.context = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
    };
    page.routeData = agentsRouteData(currentGateway, roster, "main", selection);
    setPageGateway(page, client);
    page.subscriptions.hostConnected();
    page.routeDataInitialized = true;
    page.agentsList = roster;
    const load = page.loadAgentFiles("main");
    expect(page.agentFilesLoading).toBe(true);

    selection.set("research");
    pending.resolve(files("main", "retired-main-workspace"));
    await load;

    expect(page.agentsSelectedId).toBe("research");
    await waitForFast(() => expect(page.agentFilesList?.workspace).toBe("research"));
    expect(page.context.navigate).toHaveBeenCalledWith("agents", {
      pathname: "/settings/agents/research/files",
    });
    page.subscriptions.hostDisconnected();
  });

  it("does not dispatch a queued identity write after the Settings target changes", async () => {
    const admission = deferred();
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const selection = settingsSelection(roster, "main");
    const agents = agentsCapability(async () => files("main", "main"));
    const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
    const runExternalMutation = vi.fn<ApplicationContext["runtimeConfig"]["runExternalMutation"]>(
      async (task, options) => {
        await admission.promise;
        if (!options?.canDispatch?.()) {
          return { ok: false, reason: "rejected", error: "Target changed." };
        }
        return { ok: true, value: await task(client), refresh: { ok: true } };
      },
    );
    page.context = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
      runtimeConfig: { subscribe: () => () => undefined, runExternalMutation },
    } as unknown as ApplicationContext;
    page.routeData = {
      ...agentsRouteData(currentGateway, roster, "main", selection),
      panel: "memory",
    };
    setPageGateway(page, client);
    page.subscriptions.hostConnected();
    page.identityDraft = { name: "Main draft", emoji: null, avatar: null };

    page.saveIdentityDraft();
    expect(runExternalMutation).toHaveBeenCalledOnce();
    selection.set("research");
    admission.resolve();
    await runExternalMutation.mock.results[0]?.value;

    expect(request).not.toHaveBeenCalled();
    expect(page.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
    page.subscriptions.hostDisconnected();
  });
});
