/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
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
  snapshot,
  createAgentsPage,
} from "./agents-page.test-support.ts";

const files = (agentId: string, workspace: string) => ({ agentId, workspace, files: [] });
const emptyIdentityDraft = { name: null, emoji: null, avatar: null };
const roster: AgentsListResult = {
  ...agentsList,
  agents: [...agentsList.agents, { id: "research", name: "Research" }],
};
const selections = new Set<ApplicationContext["settingsAgentSelection"]>();
afterEach(() => {
  selections.forEach((selection) => selection.dispose());
  selections.clear();
});

function fixture({
  client = null,
  list = roster,
  selectedId,
  agents = agentsCapability(async () => files("main", "main")),
}: {
  client?: GatewayBrowserClient | null;
  list?: AgentsListResult | null;
  selectedId?: string;
  agents?: ApplicationContext["agents"];
} = {}) {
  const currentGateway = gateway(snapshot(client, client !== null));
  const listeners = new Set<() => void>();
  agents.state.agentsList = list;
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
  if (selectedId !== undefined) {
    selection.set(selectedId);
  }
  selections.add(selection);
  const context = { ...pageContext(currentGateway, agents), settingsAgentSelection: selection };
  return {
    currentGateway,
    agents,
    selection,
    context,
    route: (requested: string | null = "main", nextList = agents.state.agentsList) =>
      agentsRouteData(currentGateway, nextList, requested, selection),
    setRoster(nextList: AgentsListResult | null) {
      agents.state.agentsList = nextList;
      listeners.forEach((listener) => listener());
    },
  };
}

it.each([
  { requestedAgentId: "research", selectedId: "main", expectedAgentId: "research" },
  { requestedAgentId: "missing", selectedId: "research", expectedAgentId: "main" },
  { requestedAgentId: null, selectedId: "research", expectedAgentId: "research" },
])(
  "resolves $requestedAgentId with the shared Settings selection",
  ({ requestedAgentId, selectedId, expectedAgentId }) => {
    const { context, selection, route } = fixture({ selectedId });
    const page = createAgentsPage(context);
    page.read().agentFiles.onFileDraftChange("AGENTS.md", "Previous agent's file");
    page.setRouteData({
      ...route(requestedAgentId, null),
      gatewaySnapshot: snapshot(null, false),
      panel: "tools",
    });

    expect(page.read()).toMatchObject({ activePanel: "tools", selectedAgentId: expectedAgentId });
    expect(selection.state.selectedId).toBe(expectedAgentId);
    expect(agentFileValues(page.read().agentFiles, "draft")).toEqual(
      selectedId === expectedAgentId ? { "AGENTS.md": "Previous agent's file" } : {},
    );
  },
);

it("keeps Back at Settings when the roster defaults after Agents route data", async () => {
  const previousUrl = window.location.href;
  const previousState: unknown = window.history.state;
  const history = createBrowserHistory();
  const { context, route, setRoster } = fixture({ list: null });
  context.basePath = "";
  context.navigate = (_routeId, options) =>
    history.push({
      pathname: options?.pathname ?? "/settings/agents",
      search: options?.search ?? "",
      hash: options?.hash ?? "",
    });
  const page = createAgentsPage(context);
  try {
    window.history.replaceState({}, "", "/settings");
    history.push({ pathname: "/settings/agents", search: "", hash: "" });
    page.setRouteData({
      ...route(null),
      panel: "overview",
    });

    setRoster(roster);
    expect(page.read().selectedAgentId).toBe("main");

    const back = new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
    });
    window.history.back();
    await back;
    expect(window.location.pathname).toBe("/settings");
  } finally {
    page.dispose();
    window.history.replaceState(previousState, "", previousUrl);
  }
});

it("navigates only for explicit selection intent after the roster changes its default", () => {
  const { context, selection, route, setRoster } = fixture();
  const page = createAgentsPage(context, route());
  setRoster({ ...roster, agents: [{ id: "research" }] });

  expect(page.read().selectedAgentId).toBe("research");
  expect(context.navigate).not.toHaveBeenCalled();

  setRoster(roster);
  expect(page.read().selectedAgentId).toBe("main");
  expect(context.navigate).not.toHaveBeenCalled();

  selection.set("research");

  expect(context.navigate).toHaveBeenCalledExactlyOnceWith("agents", {
    pathname: "/settings/agents/research/files",
  });
});

it.each([false, true])(
  "preserves Files while a reused page awaits route data (newer intent: %s)",
  async (newerIntent) => {
    const request = vi.fn(async () => ({ models: [] }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { agents, selection, context, route, setRoster } = fixture({ client });
    agents.ensureFiles = vi.fn(async (agentId) => files(agentId, agentId));
    Object.assign(context.runtimeConfig, { state: { configSnapshot: {}, configLoading: false } });
    const page = createAgentsPage(context, route());
    await waitForFast(() => expect(page.read().agentFiles.agentFilesList?.workspace).toBe("main"));

    setRoster(null);
    expect(selection.state.selectedId).toBeNull();
    const nextData = route("research", roster);
    // The transient outlet reuses this element while the next loader has no data.
    page.setRouteData(undefined);
    setRoster(roster);

    expect(selection.state.selectedId).toBe("main");
    expect(context.navigate).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    if (newerIntent) {
      selection.set("main");
    }
    page.setRouteData(nextData);

    const expectedAgentId = newerIntent ? "main" : "research";
    expect(selection.state.selectedId).toBe(expectedAgentId);
    expect(page.read().activePanel).toBe("files");
    await waitForFast(() =>
      expect(page.read().agentFiles.agentFilesList?.workspace).toBe(expectedAgentId),
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
  },
);

it("does not restore a preloaded agent after a newer sidebar choice, including an ABA change", () => {
  const { context, selection, route } = fixture();
  const preloaded = route("research");
  const page = createAgentsPage(context);
  selection.set("research");
  selection.set("main");
  page.setRouteData(preloaded);

  expect(selection.state.selectedId).toBe("main");
  expect(page.read().selectedAgentId).toBe("main");
  expect(context.replace).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/main/files",
    search: "",
    hash: "",
  });
});

it("retires the prior agent's pending file request when the sidebar selection changes", async () => {
  const pending = deferred<AgentsFilesListResult>();
  const client = {} as GatewayBrowserClient;
  const agents = {
    ...agentsCapability(() => pending.promise),
    ensureFiles: vi.fn((agentId: string) =>
      agentId === "main" ? pending.promise : Promise.resolve(files("research", "research")),
    ),
  };
  const { context, selection, route } = fixture({ client, agents });
  const page = createAgentsPage(context, route());

  expect(page.read().agentFiles.agentFilesLoading).toBe(true);

  selection.set("research");
  pending.resolve(files("main", "retired-main-workspace"));
  await pending.promise;

  expect(page.read().selectedAgentId).toBe("research");
  await waitForFast(() =>
    expect(page.read().agentFiles.agentFilesList?.workspace).toBe("research"),
  );
  expect(context.navigate).toHaveBeenCalledWith("agents", {
    pathname: "/settings/agents/research/files",
  });
});

it.each([
  ["same target", "main", "Lunar museum guide"],
  ["different target", "main", "Lunar museum guide"],
  ["excluded target", "research", null],
  ["profile", "main", null],
  ["source", "main", null],
])(
  "retains an identity draft for its original agent and profile through selection changes (%s)",
  (change, selectedAgentId, name) => {
    const client = {
      request: vi.fn(async () => ({ models: [] })),
    } as unknown as GatewayBrowserClient;
    const { context, currentGateway, selection, setRoster } = fixture({ client });
    currentGateway.snapshot.selfUser = { id: "operator" };
    let page = createAgentsPage(context);
    page.read().overview.onIdentityFieldChange("name", "Lunar museum guide");
    setRoster(null);
    expect(page.read()).toMatchObject({
      selectedAgentId: null,
      overview: { identityDraft: { name: null } },
    });
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
    setRoster(
      change === "excluded target"
        ? { ...roster, agents: roster.agents.filter((agent) => agent.id !== "main") }
        : roster,
    );
    expect(page.read()).toMatchObject({
      selectedAgentId,
      overview: { identityDraft: { name } },
    });
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
    const { context, currentGateway, agents } = fixture({ client, list: agentsList });
    if (stage === "roster refresh") {
      vi.mocked(agents.refreshList).mockImplementationOnce(() => oldRefresh.promise);
    }
    const mutations: Promise<unknown>[] = [];
    context.runtimeConfig.runExternalMutation = (task) => {
      const mutation = task(client).then((value) => ({
        ok: true as const,
        value,
        refresh: { ok: true as const },
      }));
      mutations.push(mutation);
      return mutation;
    };
    Object.assign(context.agentIdentity, { invalidate: vi.fn() });
    const page = createAgentsPage(context);
    page.read().overview.onIdentityFieldChange("name", "Lunar museum guide");
    page.read().overview.onIdentitySave();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    if (stage === "roster refresh") {
      oldRequest.resolve();
      await waitForFast(() => expect(agents.refreshList).toHaveBeenCalledOnce());
    }
    emitGatewaySnapshot(currentGateway, snapshot(client, false));
    emitGatewaySnapshot(currentGateway, snapshot(client));
    expect(page.read().overview).toMatchObject({
      identityDraft: { name: "Lunar museum guide" },
      identitySaving: false,
    });

    page.read().overview.onIdentityFieldChange("name", "Lunar museum curator");
    page.read().overview.onIdentitySave();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    if (stage === "request") {
      oldRequest.reject(new Error("Retired identity request"));
      await mutations[0]?.catch(() => undefined);
    } else {
      oldRefresh.resolve(agentsList);
      await waitForFast(() => expect(context.agentIdentity.ensure).toHaveBeenCalledOnce());
    }
    await Promise.resolve();
    expect(page.read().overview).toMatchObject({
      identitySaving: true,
      identityDraft: { name: "Lunar museum curator" },
      identityError: null,
    });

    newRequest.resolve();
    await waitForFast(() => expect(page.read().overview.identitySaving).toBe(false));
    expect(page.read().overview.identityDraft).toEqual(emptyIdentityDraft);
    expect(page.read().overview.identityError).toBeNull();
  },
);

it.each(["Settings target changes", "operator access is revoked"])(
  "does not dispatch a queued identity write after %s",
  async (change) => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { context, currentGateway, selection, route } = fixture({ client });
    const admission = deferred();
    const runExternalMutation = vi.fn<ApplicationContext["runtimeConfig"]["runExternalMutation"]>(
      async (task, options) => {
        await admission.promise;
        if (!options?.canDispatch?.()) {
          return { ok: false, reason: "rejected", error: "Access changed." };
        }
        return { ok: true, value: await task(client), refresh: { ok: true } };
      },
    );
    context.runtimeConfig.runExternalMutation = runExternalMutation;
    const page = createAgentsPage(
      context,
      change === "Settings target changes" ? { ...route(), panel: "memory" } : undefined,
    );
    page.read().overview.onIdentityFieldChange("name", "Private draft");
    page.read().overview.onIdentitySave();
    await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
    if (change === "Settings target changes") {
      selection.set("research");
    } else {
      currentGateway.snapshot.hello = gatewayHelloForMethods(["agents.update"], ["operator.read"]);
    }
    admission.resolve();
    await runExternalMutation.mock.results[0]?.value;

    expect(request).not.toHaveBeenCalled();
    if (change === "Settings target changes") {
      expect(page.read().overview.identityDraft).toEqual(emptyIdentityDraft);
    }
  },
);
