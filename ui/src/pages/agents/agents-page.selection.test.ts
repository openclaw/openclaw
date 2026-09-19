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

  it.each([
    { pendingUpdate: false, newerIntent: false },
    { pendingUpdate: true, newerIntent: false },
    { pendingUpdate: false, newerIntent: true },
    { pendingUpdate: true, newerIntent: true },
  ])(
    "preserves Files while a reused page awaits route data (updated: $pendingUpdate, newer intent: $newerIntent)",
    async ({ pendingUpdate, newerIntent }) => {
      const listeners = new Set<() => void>();
      const request = vi.fn(async () => ({ models: [] }));
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = agentsCapability(async () => files("main", "main"));
      agents.state.agentsList = roster;
      agents.ensureFiles = vi.fn(async (agentId) => files(agentId, agentId));
      agents.subscribe = (listener) => {
        const notify = () => listener(agents.state);
        listeners.add(notify);
        return () => listeners.delete(notify);
      };
      const selection = createAgentSelectionCapability(
        {
          connection: { gatewayUrl: "ws://settings.test" },
          snapshot: { assistantAgentId: "main" },
          subscribe: () => () => undefined,
        },
        agents,
        undefined,
        undefined,
        { requireConfiguredAgent: true },
      );
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      const context = pageContext(currentGateway, agents);
      page.context = {
        ...context,
        settingsAgentSelection: selection,
        runtimeConfig: {
          ...context.runtimeConfig,
          state: { configSnapshot: {}, configLoading: false },
        },
      } as unknown as ApplicationContext;
      page.routeData = agentsRouteData(currentGateway, roster, "main", selection);
      setPageGateway(page, client);
      page.subscriptions.hostConnected();
      try {
        page.willUpdate(new Map([["routeData", undefined]]));
        await waitForFast(() => expect(page.agentFilesList?.workspace).toBe("main"));

        agents.state.agentsList = null;
        listeners.forEach((listener) => listener());
        expect(selection.state.selectedId).toBeNull();
        const nextData = agentsRouteData(currentGateway, roster, "research", selection);
        // The transient outlet reuses this element while the next loader has no data.
        page.routeData = undefined;
        if (pendingUpdate) {
          page.willUpdate(new Map([["routeData", nextData]]));
        }
        agents.state.agentsList = roster;
        listeners.forEach((listener) => listener());

        expect(selection.state.selectedId).toBe("main");
        expect(page.context.navigate).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        if (newerIntent) {
          selection.set("main");
        }
        page.routeData = nextData;
        page.willUpdate(new Map([["routeData", undefined]]));

        const expectedAgentId = newerIntent ? "main" : "research";
        expect(selection.state.selectedId).toBe(expectedAgentId);
        expect(page.agentsPanel).toBe("files");
        await waitForFast(() => expect(page.agentFilesList?.workspace).toBe(expectedAgentId));
        expect(page.context.navigate).not.toHaveBeenCalled();
        if (newerIntent) {
          expect(page.context.replace).toHaveBeenCalledWith("agents", {
            pathname: "/settings/agents/main/files",
            search: "",
            hash: "",
          });
        } else {
          expect(page.context.replace).not.toHaveBeenCalled();
        }
      } finally {
        page.subscriptions.hostDisconnected();
        selection.dispose();
      }
    },
  );

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

  it.each(["request", "roster refresh"])(
    "retires an identity save during its %s without losing the draft or settling a newer save",
    async (stage) => {
      const oldRequest = deferred();
      const oldRefresh = deferred<AgentsListResult>();
      const newRequest = deferred();
      const request = vi
        .fn()
        .mockImplementationOnce(() => oldRequest.promise)
        .mockImplementationOnce(() => newRequest.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = agentsCapability(async () => files("main", "main"));
      if (stage === "roster refresh") {
        vi.mocked(agents.refreshList).mockImplementationOnce(() => oldRefresh.promise);
      }
      const context = pageContext(currentGateway, agents);
      const mutations: Promise<unknown>[] = [];
      const runExternalMutation: ApplicationContext["runtimeConfig"]["runExternalMutation"] = (
        task,
      ) => {
        const mutation = task(client).then((value) => ({
          ok: true as const,
          value,
          refresh: { ok: true as const },
        }));
        mutations.push(mutation);
        return mutation;
      };
      const page = document.createElement("openclaw-agents-page") as TestAgentsPage;
      page.context = {
        ...context,
        agentIdentity: { ...context.agentIdentity, invalidate: vi.fn() },
        runtimeConfig: {
          ...context.runtimeConfig,
          runExternalMutation,
        },
      };
      setPageGateway(page, client);
      page.agentsSelectedId = "main";
      page.identityDraft = { name: "Lunar museum guide", emoji: null, avatar: null };
      page.saveIdentityDraft();
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      if (stage === "roster refresh") {
        oldRequest.resolve();
        await waitForFast(() => expect(agents.refreshList).toHaveBeenCalledOnce());
      }
      setPageGateway(page, client, false);
      setPageGateway(page, client);
      expect(page.identityDraft.name).toBe("Lunar museum guide");
      expect(page.identitySaving).toBe(false);

      page.identityDraft = { name: "Lunar museum curator", emoji: null, avatar: null };
      page.saveIdentityDraft();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      if (stage === "request") {
        oldRequest.reject(new Error("Retired identity request"));
        await mutations[0]?.catch(() => undefined);
      } else {
        oldRefresh.resolve(agentsList);
        await waitForFast(() => expect(page.context.agentIdentity.ensure).toHaveBeenCalledOnce());
      }
      await Promise.resolve();
      expect(page.identitySaving).toBe(true);
      expect(page.identityDraft.name).toBe("Lunar museum curator");
      expect(page.identityError).toBeNull();

      newRequest.resolve();
      await waitForFast(() => expect(page.identitySaving).toBe(false));
      expect(page.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
      expect(page.identityError).toBeNull();
    },
  );

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
