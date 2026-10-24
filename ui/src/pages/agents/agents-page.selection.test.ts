/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesListResult, AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { createBrowserHistory } from "../../app/browser.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { agentFileValues } from "./agent-file-state.test-helpers.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  gateway,
  pageContext,
  emitGatewaySnapshot,
  settingsSelection,
  snapshot,
  createAgentsPage,
} from "./agents-page.test-support.ts";

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
      const agents = agentsCapability(async () => files(selectedId, selectedId));
      agents.state.agentsList = roster;
      const context: ApplicationContext = {
        ...pageContext(currentGateway, agents),
        settingsAgentSelection: selection,
      };
      const page = createAgentsPage(context);
      page.read().agentFiles.onFileDraftChange("AGENTS.md", "Previous agent's file");
      page.setRouteData({
        ...agentsRouteData(currentGateway, null, requestedAgentId, selection),
        panel: "tools",
      });

      expect(page.read().readData().agentsPanel).toBe("tools");
      expect(page.read().selectedAgentId).toBe(expectedAgentId);
      expect(page.read().memoryTarget.read()).toBe(expectedAgentId);
      expect(selection.state.selectedId).toBe(expectedAgentId);
      expect(agentFileValues(page.read().readData(), "draft")).toEqual(
        selectedId === expectedAgentId ? { "AGENTS.md": "Previous agent's file" } : {},
      );
    },
  );

  it("publishes admitted memory targets from the retained page owner", () => {
    const currentGateway = gateway(snapshot(null, false));
    const selection = settingsSelection(roster, "main");
    const agents = agentsCapability(async () => files("main", "main"));
    agents.state.agentsList = roster;
    const context: ApplicationContext = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
    };
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, roster, "main", selection),
    );
    const target = page.read().memoryTarget;
    const notify = vi.fn((agentId: string | null) => agentId);
    const stop = target.subscribe(() => notify(target.read()));
    try {
      expect(target.read()).toBe("main");
      const staleRoute = agentsRouteData(currentGateway, roster, "research", selection);
      selection.set("research");
      expect(notify).toHaveBeenLastCalledWith("research");
      selection.set("main");
      expect(notify).toHaveBeenLastCalledWith("main");
      page.setRouteData(staleRoute);
      expect(target.read()).toBe("main");
      expect(page.read().memoryTarget).toBe(target);

      stop();
      notify.mockClear();
      selection.set("research");
      expect(notify).not.toHaveBeenCalled();
    } finally {
      stop();
      page.dispose();
      selection.dispose();
    }
  });

  it("keeps Back at Settings when the roster defaults after Agents route data", async () => {
    const previousUrl = window.location.href;
    const previousState: unknown = window.history.state;
    const history = createBrowserHistory();
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
    const context: ApplicationContext = {
      ...pageContext(
        currentGateway,
        agentsCapability(async () => files("main", "main")),
      ),
      basePath: "",
      settingsAgentSelection: selection,
      navigate: (_routeId, options) =>
        history.push({
          pathname: options?.pathname ?? "/settings/agents",
          search: options?.search ?? "",
          hash: options?.hash ?? "",
        }),
    };
    const page = createAgentsPage(context);
    try {
      window.history.replaceState({}, "", "/settings");
      history.push({ pathname: "/settings/agents", search: "", hash: "" });
      page.setRouteData({
        ...agentsRouteData(currentGateway, null, null, selection),
        panel: "overview",
      });

      rosterSource.state.agentsList = roster;
      listeners.forEach((listener) => listener());
      expect(page.read().selectedAgentId).toBe("main");

      const back = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.back();
      await back;
      expect(window.location.pathname).toBe("/settings");
    } finally {
      page.dispose();
      selection.dispose();
      window.history.replaceState(previousState, "", previousUrl);
    }
  });

  it("navigates only for explicit selection intent after the roster changes its default", () => {
    const listeners = new Set<() => void>();
    const rosterSource = {
      state: { agentsList: roster as AgentsListResult | null },
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
    const context: ApplicationContext = {
      ...pageContext(
        currentGateway,
        agentsCapability(async () => files("main", "main")),
      ),
      settingsAgentSelection: selection,
    };
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, roster, "main", selection),
    );
    try {
      rosterSource.state.agentsList = { ...roster, agents: [{ id: "research" }] };
      listeners.forEach((listener) => listener());

      expect(page.read().selectedAgentId).toBe("research");
      expect(context.navigate).not.toHaveBeenCalled();

      rosterSource.state.agentsList = roster;
      listeners.forEach((listener) => listener());
      expect(page.read().selectedAgentId).toBe("main");
      expect(context.navigate).not.toHaveBeenCalled();

      selection.set("research");

      expect(context.navigate).toHaveBeenCalledExactlyOnceWith("agents", {
        pathname: "/settings/agents/research/files",
      });
    } finally {
      page.dispose();
      selection.dispose();
    }
  });

  it.each([false, true])(
    "preserves Files while a reused page awaits route data (newer intent: %s)",
    async (newerIntent) => {
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
      const baseContext = pageContext(currentGateway, agents);
      const context: ApplicationContext = {
        ...baseContext,
        settingsAgentSelection: selection,
        runtimeConfig: {
          ...baseContext.runtimeConfig,
          state: { configSnapshot: {}, configLoading: false },
        },
      } as unknown as ApplicationContext;
      const page = createAgentsPage(
        context,
        agentsRouteData(currentGateway, roster, "main", selection),
      );
      try {
        await waitForFast(() =>
          expect(page.read().readData().agentFilesList?.workspace).toBe("main"),
        );

        agents.state.agentsList = null;
        listeners.forEach((listener) => listener());
        expect(selection.state.selectedId).toBeNull();
        const nextData = agentsRouteData(currentGateway, roster, "research", selection);
        // The transient outlet reuses this element while the next loader has no data.
        page.setRouteData(undefined);
        agents.state.agentsList = roster;
        listeners.forEach((listener) => listener());

        expect(selection.state.selectedId).toBe("main");
        expect(context.navigate).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        if (newerIntent) {
          selection.set("main");
        }
        page.setRouteData(nextData);

        const expectedAgentId = newerIntent ? "main" : "research";
        expect(selection.state.selectedId).toBe(expectedAgentId);
        expect(page.read().readData().agentsPanel).toBe("files");
        await waitForFast(() =>
          expect(page.read().readData().agentFilesList?.workspace).toBe(expectedAgentId),
        );
        expect(context.navigate).not.toHaveBeenCalled();
        if (newerIntent) {
          expect(context.replace).toHaveBeenCalledWith("agents", {
            pathname: "/settings/agents/main/files",
            search: "",
            hash: "",
          });
        } else {
          expect(context.replace).not.toHaveBeenCalled();
        }
      } finally {
        page.dispose();
        selection.dispose();
      }
    },
  );

  it("does not restore a preloaded agent after a newer sidebar choice, including an ABA change", () => {
    const currentGateway = gateway(snapshot(null, false));
    const selection = settingsSelection(roster, "main");
    const replace = vi.fn();
    const context: ApplicationContext = {
      basePath: "",
      gateway: currentGateway,
      settingsAgentSelection: selection,
      replace,
    } as unknown as ApplicationContext;
    const preloaded = agentsRouteData(currentGateway, roster, "research", selection);
    const page = createAgentsPage({
      ...pageContext(
        currentGateway,
        agentsCapability(async () => files("main", "main")),
      ),
      ...context,
    });
    selection.set("research");
    selection.set("main");
    page.setRouteData(preloaded);

    expect(selection.state.selectedId).toBe("main");
    expect(page.read().selectedAgentId).toBe("main");
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
    const context: ApplicationContext = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
    };
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, roster, "main", selection),
    );

    selection.set("research");
    pending.resolve(files("main", "retired-main-workspace"));
    await pending.promise;

    expect(page.read().selectedAgentId).toBe("research");
    await waitForFast(() =>
      expect(page.read().readData().agentFilesList?.workspace).toBe("research"),
    );
    expect(context.navigate).toHaveBeenCalledWith("agents", {
      pathname: "/settings/agents/research/files",
    });
    page.dispose();
  });

  it.each(["same target", "different target", "excluded target", "profile", "source"])(
    "retains an identity draft for its original agent and profile through selection changes (%s)",
    (change) => {
      const listeners = new Set<() => void>();
      const client = {
        request: vi.fn(async () => ({ models: [] })),
      } as unknown as GatewayBrowserClient;
      const currentGateway = gateway({ ...snapshot(client), selfUser: { id: "operator" } });
      const agents = agentsCapability(async () => files("main", "main"));
      agents.state.agentsList = roster;
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
      const context: ApplicationContext = {
        ...pageContext(currentGateway, agents),
        settingsAgentSelection: selection,
      };
      let page = createAgentsPage(context);
      try {
        page.read().overview.onIdentityFieldChange("name", "Lunar museum guide");
        agents.state.agentsList = null;
        listeners.forEach((listener) => listener());
        expect(page.read().selectedAgentId).toBeNull();
        expect(page.read().readData().identityDraft.name).toBeNull();
        if (change === "different target") {
          selection.set("research");
          selection.set("main");
        } else if (change === "profile") {
          currentGateway.snapshot.selfUser = { id: "other-operator" };
          emitGatewaySnapshot(currentGateway, currentGateway.snapshot);
        } else if (change === "source") {
          page.dispose();
          page = createAgentsPage({ ...context, gateway: gateway(snapshot(client)) });
        }
        agents.state.agentsList =
          change === "excluded target"
            ? { ...roster, agents: roster.agents.filter((agent) => agent.id !== "main") }
            : roster;
        listeners.forEach((listener) => listener());
        expect(page.read().selectedAgentId).toBe(
          change === "excluded target" ? "research" : "main",
        );
        expect(page.read().readData().identityDraft.name).toBe(
          change === "same target" || change === "different target" ? "Lunar museum guide" : null,
        );
      } finally {
        page.dispose();
        selection.dispose();
      }
    },
  );

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
      const mountedContext = {
        ...context,
        agentIdentity: { ...context.agentIdentity, invalidate: vi.fn() },
        runtimeConfig: {
          ...context.runtimeConfig,
          runExternalMutation,
        },
      };
      const page = createAgentsPage(mountedContext);
      page.read().overview.onIdentityFieldChange("name", "Lunar museum guide");
      page.read().overview.onIdentitySave();
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      if (stage === "roster refresh") {
        oldRequest.resolve();
        await waitForFast(() => expect(agents.refreshList).toHaveBeenCalledOnce());
      }
      emitGatewaySnapshot(currentGateway, snapshot(client, false));
      emitGatewaySnapshot(currentGateway, snapshot(client));
      expect(page.read().readData().identityDraft.name).toBe("Lunar museum guide");
      expect(page.read().readData().identitySaving).toBe(false);

      page.read().overview.onIdentityFieldChange("name", "Lunar museum curator");
      page.read().overview.onIdentitySave();
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      const currentOutcome = page.read().readData().identityOutcome;
      if (stage === "request") {
        oldRequest.reject(new Error("Retired identity request"));
        await mutations[0]?.catch(() => undefined);
      } else {
        vi.mocked(context.agentIdentity.ensure).mockClear();
        oldRefresh.resolve(agentsList);
        await waitForFast(() =>
          expect(context.agentIdentity.ensure).toHaveBeenCalledWith(["main"]),
        );
      }
      await Promise.resolve();
      expect(page.read().readData().identitySaving).toBe(true);
      expect(page.read().readData().identityDraft.name).toBe("Lunar museum curator");
      expect(page.read().readData().identityOutcome).toBe(currentOutcome);

      newRequest.resolve();
      await waitForFast(() => expect(page.read().readData().identitySaving).toBe(false));
      expect(page.read().readData().identityDraft).toEqual({
        name: null,
        emoji: null,
        avatar: null,
      });
      expect(await page.read().readData().identityOutcome).toBeNull();
    },
  );

  it("does not dispatch a queued identity write after the Settings target changes", async () => {
    const admission = deferred();
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const selection = settingsSelection(roster, "main");
    const agents = agentsCapability(async () => files("main", "main"));
    const runExternalMutation = vi.fn<ApplicationContext["runtimeConfig"]["runExternalMutation"]>(
      async (task, options) => {
        await admission.promise;
        if (!options?.canDispatch?.()) {
          return { ok: false, reason: "rejected", error: "Target changed." };
        }
        return { ok: true, value: await task(client), refresh: { ok: true } };
      },
    );
    const context: ApplicationContext = {
      ...pageContext(currentGateway, agents),
      settingsAgentSelection: selection,
      runtimeConfig: { subscribe: () => () => undefined, runExternalMutation },
    } as unknown as ApplicationContext;
    const page = createAgentsPage(context, {
      ...agentsRouteData(currentGateway, roster, "main", selection),
      panel: "memory",
    });
    page.read().overview.onIdentityFieldChange("name", "Main draft");

    page.read().overview.onIdentitySave();
    await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
    selection.set("research");
    admission.resolve();
    await runExternalMutation.mock.results[0]?.value;

    expect(request).not.toHaveBeenCalled();
    expect(page.read().readData().identityDraft).toEqual({ name: null, emoji: null, avatar: null });
    page.dispose();
  });

  it("does not dispatch a queued identity write after operator access is revoked", async () => {
    const admission = deferred();
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = agentsCapability(async () => files("main", "main"));
    const runExternalMutation = vi.fn<ApplicationContext["runtimeConfig"]["runExternalMutation"]>(
      async (task, options) => {
        await admission.promise;
        if (!options?.canDispatch?.()) {
          return { ok: false, reason: "rejected", error: "Access changed." };
        }
        return { ok: true, value: await task(client), refresh: { ok: true } };
      },
    );
    const context: ApplicationContext = {
      ...pageContext(currentGateway, agents),
      runtimeConfig: { subscribe: () => () => undefined, runExternalMutation },
    } as unknown as ApplicationContext;
    const page = createAgentsPage(context);
    page.read().overview.onIdentityFieldChange("name", "Private draft");
    page.read().overview.onIdentitySave();
    await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());

    currentGateway.snapshot.hello = gatewayHelloForMethods(["agents.update"], ["operator.read"]);
    admission.resolve();
    await runExternalMutation.mock.results[0]?.value;

    expect(request).not.toHaveBeenCalled();
    page.dispose();
  });
});
