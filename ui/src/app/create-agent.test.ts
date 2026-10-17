/* @vitest-environment jsdom */
import { createRouter, definePage, type RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { locationForRoute, routePageSpec, type RouteId } from "../app-route-paths.ts";
import { agentCreationRejection } from "../lib/agents/creation.test-support.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../lib/sessions/route-navigation.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import "../lib/toast-host.ts";
import "../pages/chat/pending-session-create.tsx";
import "../test-helpers/app-sidebar-suite.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import type { ApplicationContext } from "./context.ts";
import { createApplicationAgent } from "./create-agent.ts";
import { loadSettings, patchSettings } from "./settings.ts";

async function fixture(
  options: {
    verification?: Promise<{ ok: boolean; error?: string }>;
    creation?: Promise<void>;
    onboardingError?: string;
  } = {},
) {
  const toast = document.createElement("openclaw-toast-host");
  document.body.append(toast);
  await toast.updateComplete;
  onTestFinished(() => toast.remove());
  const roster: AgentsListResult = {
    defaultId: "main",
    mainKey: "home",
    scope: "per-sender",
    agents: [{ id: "main", name: "Molty" }],
  };
  const creationStarted = createDeferred();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "agents.list") {
      return structuredClone(roster);
    }
    if (method === "config.get") {
      return {
        exists: true,
        valid: true,
        sourceConfig: {
          agents: {
            entries: Object.fromEntries(roster.agents.map(({ id, name }) => [id, { name }])),
          },
        },
      };
    }
    if (method === "agents.create") {
      creationStarted.resolve();
      const verification: { ok: boolean; error?: string } = await (options.verification ?? {
        ok: true,
      });
      if (!verification.ok) {
        throw agentCreationRejection(verification.error ?? "Inference unavailable");
      }
      await options.creation;
      if (
        !params ||
        typeof params !== "object" ||
        !("agentId" in params) ||
        typeof params.agentId !== "string" ||
        !("name" in params) ||
        typeof params.name !== "string"
      ) {
        throw new Error("Expected a stable ID and display name in agents.create");
      }
      roster.agents.push({ id: params.agentId, name: params.name });
      return {
        ok: true,
        agentId: params.agentId,
        name: params.name,
        onboarding: {
          sessionKey: `agent:${params.agentId}:home`,
          ...(options.onboardingError
            ? { status: "error", error: options.onboardingError }
            : { status: "completed" }),
        },
      };
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  // SAFETY: These tests exercise the client's request transport boundary only.
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const gateway = harness.gateway;
  harness.publish({ sessionKey: "agent:main:home" });
  gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
  const agents = createAgentCapability(gateway);
  await agents.ensureList();
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  const context = createContext(
    gateway,
    createSessionsHarness("main", ["agent:main:home"]).sessions,
    roster,
  );
  let location = { pathname: "/chat/main", search: "", hash: "" };
  const history: RouterHistory = {
    location: () => location,
    push: (next) => {
      location = next;
    },
    replace: (next) => {
      location = next;
    },
    listen: () => () => undefined,
  };
  const router = createRouter<RouteId, ApplicationContext>({
    routes: (["chat", "usage"] as const).map((id) =>
      definePage({
        ...routePageSpec(id),
        component: () => ({ renderSolid: () => null }),
      }),
    ),
  });
  let navigation: Promise<void> | undefined;
  const navigate = vi.fn<ApplicationContext["navigate"]>((routeId, params) => {
    navigation = router.navigate(
      routeId,
      context,
      { history: "push" },
      {
        ...locationForRoute(routeId, ""),
        ...params,
      },
    );
  });
  const replace = vi.fn<ApplicationContext["replace"]>((routeId, params) => {
    navigation = router.navigate(
      routeId,
      context,
      { history: "replace" },
      {
        ...locationForRoute(routeId, ""),
        ...params,
      },
    );
  });
  Object.assign(context, {
    agents,
    agentSelection,
    router,
    navigate,
    replace,
    chatSubmissions: createChatSubmissions(),
    basePath: "",
  });
  await router.start(history, "", context);
  onTestFinished(() => {
    router.stop();
    agentSelection.dispose();
    agents.dispose();
  });
  return {
    context,
    request,
    creationStarted: creationStarted.promise,
    roster,
    navigate,
    replace,
    publishGateway: (snapshot: Parameters<typeof harness.publish>[0]) => harness.publish(snapshot),
    toast,
    settledNavigation: () => navigation,
  };
}

describe("application agent creation", () => {
  it.each(["read-only", "unadvertised", "unpaired"] as const)(
    "refuses %s creation before opening a provisional chat",
    async (access) => {
      const { context, request, navigate, toast, publishGateway } = await fixture();
      publishGateway({
        hello:
          access === "unpaired"
            ? null
            : gatewayHelloForMethods(
                access === "unadvertised" ? [] : ["agents.create"],
                access === "read-only" ? ["operator.read"] : ["operator.admin"],
              ),
      });
      await createApplicationAgent(context);
      expect(navigate).not.toHaveBeenCalled();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.list"]);
      expect(context.chatSubmissions.creation).toBeUndefined();
      await vi.waitFor(() => expect(toast.toast?.message).toContain("Pair this browser"));
    },
  );

  it("opens the new chat before waiting for inference verification", async () => {
    const verification = createDeferred<{ ok: boolean; error?: string }>();
    const { context, request, roster, navigate, creationStarted } = await fixture({
      verification: verification.promise,
    });
    const creating = createApplicationAgent(context);
    try {
      expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
        pathname: expect.stringMatching(/^\/chat\/bot-/),
        search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
      });
      expect(roster.agents).toHaveLength(1);
      expect(context.chatSubmissions.creation).toMatchObject({
        sessionKey: expect.stringMatching(/^agent:bot-.*:home$/),
        admitted: false,
      });
      expect(context.chatSubmissions.readCreate()?.displayName).toBe("New agent");
      expect(context.chatSubmissions.readCreate()?.message).toBeNull();
      expect(context.gateway.snapshot.sessionKey).toBe("agent:main:home");
      await creationStarted;
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "agents.list",
        "agents.create",
      ]);
      Object.assign(context.placementStartup, {
        get: () => null,
        subscribe: () => () => undefined,
      });
      const pending = Object.assign(document.createElement("openclaw-pending-session-create"), {
        context,
        sessionKey: context.chatSubmissions.creation!.sessionKey,
      });
      document.body.append(pending);
      onTestFinished(() => pending.remove());
      await vi.waitFor(() => {
        expect(pending.querySelector(".chat-group.assistant .chat-text")?.textContent?.trim()).toBe(
          "Hi! What would you like to call me?",
        );
      });
      expect(pending.querySelector(".chat-avatar.assistant")?.getAttribute("aria-label")).toBe(
        "New agent",
      );
      expect(pending.querySelector(".chat-group.user")).toBeNull();
      expect(roster.agents).toHaveLength(1);
      expect(context.chatSubmissions.creation?.admitted).toBe(false);
    } finally {
      verification.resolve({ ok: false, error: "Test verification did not pass" });
      await creating;
    }
  });

  it("puts creation first, shows a pending top row, and opens the agent-initiated chat", async () => {
    const verification = createDeferred<{ ok: boolean }>();
    const creation = createDeferred();
    const { context, request, roster, navigate, toast, settledNavigation } = await fixture({
      verification: verification.promise,
      creation: creation.promise,
    });
    const { sidebar } = await mountSidebarContext(context);
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const create = sidebar.querySelector<HTMLButtonElement>('[data-value="command:new-agent"]');
    expect(create?.textContent).toContain("Create new agent");
    expect(sidebar.querySelector(".sidebar-agent-menu [data-value]")).toBe(create);
    expect(sidebar.querySelector(".sidebar-agent-menu [role=separator]")).toBeNull();
    create?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    await vi.waitFor(() => {
      expect(context.agents.state.pendingAgent).toBeDefined();
      expect(sidebar.querySelector('[data-value="command:new-agent"]')?.textContent).toContain(
        "Creating new agent",
      );
    });
    expect(roster.agents).toHaveLength(1);
    expect(navigate).toHaveBeenCalledOnce();

    verification.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(context.agents.state.pendingAgent).toBeDefined();
      const pendingRow = sidebar.querySelector<HTMLButtonElement>(
        '[data-value="command:new-agent"]',
      );
      expect(pendingRow?.textContent).toContain("Creating new agent");
      expect(pendingRow?.getAttribute("aria-disabled")).toBe("true");
      const firstAgent = sidebar.querySelector('[data-value^="agent:"]');
      expect(firstAgent?.textContent).toContain("New agent");
      expect(firstAgent?.getAttribute("aria-disabled")).toBe("true");
      expect(firstAgent?.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
        "Creating new agent…",
      );
    });
    expect(navigate).toHaveBeenCalledOnce();
    creation.resolve();
    await vi.waitFor(() => expect(context.chatSubmissions.creation).toBeUndefined());
    await settledNavigation();
    const bot = roster.agents[1];
    expect(bot).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
    expect(context.agentSelection.state.selectedId).toBe(bot?.id);
    expect(context.agents.state.agentsList?.agents).toContainEqual(bot);
    expect(context.gateway.snapshot.sessionKey).toBe(`agent:${bot?.id}:home`);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: `/chat/${bot?.id}`,
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(request).toHaveBeenCalledWith("agents.create", {
      agentId: bot?.id,
      name: "New agent",
      onboarding: true,
    });
    // The creation owner starts the assistant turn; the UI never impersonates a user.
    expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.list", "agents.create"]);
    expect(toast.toast).toBeNull();
  });

  it("keeps the created agent first after reconnect and a fresh sidebar", async () => {
    const { context, roster, publishGateway, settledNavigation } = await fixture();
    await createApplicationAgent(context);
    await settledNavigation();
    const createdId = roster.agents[1]!.id;
    publishGateway({ phase: "reconnecting" });
    publishGateway({ phase: "connected", sessionKey: "agent:main:home" });
    await context.agents.ensureList();
    expect(context.agents.state.recentlyCreatedAgentId).toBeUndefined();
    expect(context.agents.state.agentsList?.agents.map(({ id }) => id)).toEqual([
      "main",
      createdId,
    ]);

    const resumed = createContext(
      context.gateway,
      createSessionsHarness("main", ["agent:main:home"]).sessions,
      structuredClone(roster),
    );
    const { sidebar } = await mountSidebarContext(resumed);
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-value^="agent:"]')?.getAttribute("data-value")).toBe(
      `agent:${createdId}`,
    );
    expect(sidebar.querySelector('[data-value="agent:main"]')?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(sidebar.querySelector('[data-value="scope:all"]')?.textContent).toContain("Show all");
    expect(resumed.navigation.snapshot.pinnedAgentIds).toEqual([]);
  });

  it("explains failed inference and restores the prior chat without persisting an agent", async () => {
    const { context, request, roster, navigate, replace, toast, settledNavigation } = await fixture(
      {
        verification: Promise.resolve({ ok: false, error: "Provider credentials expired" }),
      },
    );
    patchSettings(
      {
        gatewayUrl: context.gateway.connection.gatewayUrl,
        sidebarRecentlyCreatedAgentId: "previous",
      },
      { selectGateway: false },
    );
    vi.useFakeTimers();
    await createApplicationAgent(context);
    await settledNavigation();
    await toast.updateComplete;
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(1_000);
    await toast.updateComplete;
    expect(roster.agents).toEqual([{ id: "main", name: "Molty" }]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "agents.create",
      "config.get",
    ]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("chat", { pathname: "/chat/main", search: "", hash: "" });
    expect(context.chatSubmissions.creation).toBeUndefined();
    expect(context.agentSelection.state.selectedId).toBe("main");
    expect(loadSettings(context.gateway.connection.gatewayUrl).sidebarRecentlyCreatedAgentId).toBe(
      "previous",
    );
    expect(context.gateway.snapshot.sessionKey).toBe("agent:main:home");
    expect(toast.active).toBe(true);
    expect(toast.querySelector(".app-toast__message")?.textContent).toContain(
      "Provider credentials expired",
    );
  });

  it("restores the prior chat if the same Gateway disconnects during verification", async () => {
    const verification = createDeferred<{ ok: boolean }>();
    const {
      context,
      request,
      roster,
      replace,
      publishGateway,
      settledNavigation,
      creationStarted,
    } = await fixture({
      verification: verification.promise,
    });
    const client = context.gateway.snapshot.client;
    const creating = createApplicationAgent(context);
    await settledNavigation();
    expect(context.router.getState().location.pathname).toMatch(/^\/chat\/bot-/);

    await creationStarted;
    publishGateway({ phase: "reconnecting" });
    expect(context.gateway.snapshot.client).toBe(client);
    verification.resolve({ ok: true });
    await creating;
    await settledNavigation();

    expect(context.router.getState().location.pathname).toBe("/chat/main");
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/chat/main",
      search: "",
      hash: "",
    });
    // A disconnected client cannot undo an already dispatched server creation.
    expect(roster.agents).toHaveLength(2);
    expect(context.agents.state.agentsList).toBeNull();
    expect(context.chatSubmissions.creation).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.list", "agents.create"]);
  });

  it.each(["route", "selection"] as const)(
    "finishes the bot and its chat in the background after newer %s intent",
    async (intent) => {
      const verification = createDeferred<{ ok: boolean }>();
      const { context, request, roster, navigate, toast, settledNavigation } = await fixture({
        verification: verification.promise,
      });
      const creating = createApplicationAgent(context);
      if (intent === "route") {
        context.navigate("usage");
        await settledNavigation();
      } else {
        context.agentSelection.setScope(null);
      }
      const location = context.router.getState().location;
      const selection = context.agentSelection.state;
      navigate.mockClear();
      verification.resolve({ ok: true });
      await creating;
      expect(roster.agents[1]).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
      expect(context.agents.state.agentsList?.agents).toContainEqual(roster.agents[1]);
      expect(request).toHaveBeenCalledWith(
        "agents.create",
        expect.objectContaining({ agentId: roster.agents[1]?.id, onboarding: true }),
      );
      expect(context.router.getState().location).toBe(location);
      expect(context.agentSelection.state).toEqual(selection);
      expect(context.gateway.snapshot.sessionKey).toBe("agent:main:home");
      expect(navigate).not.toHaveBeenCalled();
      expect(
        loadSettings(context.gateway.connection.gatewayUrl).sidebarRecentlyCreatedAgentId,
      ).toBe(roster.agents[1]?.id);
      expect(toast.toast).toBeNull();
    },
  );

  it("retains the created agent when onboarding admission fails and offers recovery", async () => {
    const { context, roster, toast, settledNavigation } = await fixture({
      onboardingError: "Provider disconnected before admission",
    });
    await createApplicationAgent(context);
    await settledNavigation();
    const agent = roster.agents[1];
    expect(agent?.name).toBe("New agent");
    expect(context.agents.state.agentsList?.agents).toContainEqual(agent);
    expect(context.agentSelection.state.selectedId).toBe(agent?.id);
    expect(context.gateway.snapshot.sessionKey).toBe(`agent:${agent?.id}:home`);
    await toast.updateComplete;
    await vi.dynamicImportSettled();
    expect(toast.active).toBe(true);
    expect(toast.querySelector(".app-toast__message")?.textContent).toContain(
      "Your agent was created, but its first message couldn't be sent",
    );
  });
});
