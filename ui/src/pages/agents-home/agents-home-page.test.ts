/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AgentsHomePage } from "./agents-home-page.tsx";

const roster: AgentsListResult = {
  defaultId: "harbor",
  mainKey: "team-room",
  scope: "per-sender",
  agents: [
    { id: "harbor", name: "Harbor", identity: { theme: "Keeps the team organized", emoji: "⚓" } },
    {
      id: "ember",
      identity: { theme: "Builds small tools" },
      model: { primary: "example/model-small" },
    },
    { id: "system", kind: "system", name: "System helper" },
  ],
};

function createPage(initiallyActive = true) {
  const [active, setActive] = createSignal(initiallyActive);
  let sessions: GatewaySessionRow[] = [
    {
      key: "agent:harbor:team-room",
      agentId: "harbor",
      kind: "direct",
      isMain: true,
      updatedAt: 5_000,
      lastMessagePreview: "The schedule is ready.",
    },
    {
      key: "agent:ember:team-room",
      agentId: "ember",
      kind: "direct",
      isMain: true,
      updatedAt: 1_000,
      lastMessagePreview: "The main chat summary.",
    },
    {
      key: "agent:ember:side-task",
      agentId: "ember",
      kind: "direct",
      updatedAt: 2_000,
      lastMessagePreview: "A newer side-task message.",
      hasActiveRun: true,
    },
  ];
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "agents.list") {
      return roster;
    }
    if (method === "agent.identity.get") {
      const agentId =
        params && typeof params === "object" && "agentId" in params ? String(params.agentId) : "";
      return {
        agentId,
        name: agentId === "ember" ? "Ember" : "Harbor",
        avatar: "",
        emoji: agentId === "harbor" ? "⚓" : "",
      } satisfies AgentIdentityResult;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      const offset =
        params && typeof params === "object" && "offset" in params ? Number(params.offset) : 0;
      const limit =
        params && typeof params === "object" && "limit" in params ? Number(params.limit) : 300;
      const rows = sessions.slice(offset, offset + limit);
      return {
        ts: 6_000,
        path: "",
        count: rows.length,
        sessions: rows,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        hasMore: offset + rows.length < sessions.length,
        nextOffset: offset + rows.length,
      } satisfies SessionsListResult;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const source = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "harbor",
    sessionKey: "agent:harbor:team-room",
    lastError: null,
    lastErrorCode: null,
  });
  const eventListeners = new Set<GatewayEventListener>();
  source.gateway.subscribeEvents = (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  };
  const agentSelection: ApplicationContext["agentSelection"] = {
    intentRevision: 0,
    state: { selectedId: "harbor", scopeId: null },
    set: () => undefined,
    setScope: () => undefined,
    subscribe: () => () => undefined,
  };
  const agents = createAgentCapability(source.gateway);
  const agentIdentity = createAgentIdentityCapability(source.gateway);
  const sessionCapability = createSessionCapability(source.gateway, agentSelection);
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const context = {
    ...createContext(source.gateway, sessionCapability, roster, [], agentIdentity),
    basePath: "",
    gateway: source.gateway,
    agents,
    agentIdentity,
    agentSelection,
    sessions: sessionCapability,
    navigate,
  };
  const baselineEventListeners = eventListeners.size;
  const provider = createSolidApplicationContextProvider(context);
  const mountPage = () =>
    mountSolid(
      () =>
        createComponent(AgentsHomePage, {
          get active() {
            return active();
          },
        }),
      { wrapper: provider.wrapper },
    );
  const view = mountPage();
  disposers.push(() => {
    agents.dispose();
    sessionCapability.dispose();
  });
  return {
    page: view.container,
    unmount: view.unmount,
    mountPage,
    rosterListenerCount: () => eventListeners.size - baselineEventListeners,
    request,
    setActive,
    navigate,
    updateSessions: (next: GatewaySessionRow[]) => {
      sessions = next;
    },
    emitChange: () => {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "sessions.changed", payload: {} });
      }
    },
    setPhase: (phase: ApplicationGatewaySnapshot["phase"]) => {
      source.publish({ ...source.gateway.snapshot, phase });
    },
  };
}

const disposers: (() => void)[] = [];
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  cleanupSolid();
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  vi.useRealTimers();
});

describe("AgentsHomePage", () => {
  it("waits until an initially inactive page is shown before loading its roster", async () => {
    const { page, request, setActive } = createPage(false);
    await waitForSolid(() => expect(page.querySelector(".agents-home")).not.toBeNull());
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(0);

    setActive(true);
    await waitForSolid(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    expect(request).toHaveBeenCalledWith("agents.list", {});
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ includeLastMessage: true, archived: "all" }),
    );
  });

  it("shows the configured roster, prioritizes work across sessions, and opens the canonical main chat", async () => {
    const { page, request, navigate } = createPage();
    await waitForSolid(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));

    const cards = [...page.querySelectorAll(".agents-home__card")];
    expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual(["Ember", "Harbor"]);
    expect(cards[0]?.textContent).toContain("Builds small tools");
    expect(cards[0]?.textContent).toContain("example/model-small");
    await waitForSolid(() =>
      expect(cards[0]?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(cards[1]?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "⚓",
    );
    expect(cards[0]?.querySelector(".agents-home__working")?.textContent).toBe("Working now");
    expect(cards[1]?.querySelector(".agents-home__working")).toBeNull();
    expect(cards[0]?.querySelector(".agents-home__preview")?.textContent?.trim()).toBe(
      "The main chat summary.",
    );
    expect(page.textContent).not.toContain("System helper");
    expect(page.textContent).not.toContain("A newer side-task message.");
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ includeLastMessage: true, archived: "all", limit: 100 }),
    );

    const openChat = cards[0]?.querySelector<HTMLElement>(".agents-home__open");
    expect(openChat?.textContent).toBe("Open chat");
    openChat?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/ember" });
  });

  it("shares bounded activity loading between consumers and stops after the last detach", async () => {
    vi.useFakeTimers();
    const { page, mountPage, unmount, request, rosterListenerCount, updateSessions, emitChange } =
      createPage();
    await waitForSolid(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const secondView = mountPage();
    const second = secondView.container;
    await waitForSolid(() => expect(second.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const calls = (method: string) =>
      request.mock.calls.filter(
        ([name, params]) =>
          name === method &&
          (method !== "sessions.list" ||
            (params !== null &&
              typeof params === "object" &&
              "archived" in params &&
              params.archived === "all")),
      );
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(calls("sessions.list")).toHaveLength(1);
    expect(rosterListenerCount()).toBe(0);

    updateSessions(
      Array.from({ length: 301 }, (_, index) => ({
        key: `agent:harbor:task-${index}`,
        kind: "direct",
        updatedAt: index + 1,
        lastMessagePreview: `Activity ${index}`,
      })),
    );
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    flush();
    expect(page.textContent).toContain("Activity 299");
    expect(second.textContent).toContain("Activity 299");
    expect(calls("sessions.list")).toHaveLength(3);
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(page.textContent).not.toContain("Activity 300");

    unmount();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(3);
    emitChange();
    secondView.unmount();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(0);
  });

  it("refreshes live status and previews after session events and gateway reconnect", async () => {
    vi.useFakeTimers();
    const { page, updateSessions, emitChange, setPhase } = createPage();
    await waitForSolid(() => expect(page.querySelector(".agents-home__working")).not.toBeNull());
    updateSessions([
      {
        key: "agent:ember:team-room",
        agentId: "ember",
        kind: "direct",
        isMain: true,
        updatedAt: 7_000,
        lastMessagePreview: "The tool is finished.",
      },
    ]);
    emitChange();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForSolid(() => expect(page.textContent).toContain("The tool is finished."));
    expect(page.querySelector(".agents-home__working")).toBeNull();

    setPhase("reconnecting");
    await waitForSolid(() => expect(page.textContent).toContain("Connect to the Gateway"));
    updateSessions([
      {
        key: "agent:harbor:team-room",
        agentId: "harbor",
        kind: "direct",
        isMain: true,
        updatedAt: 8_000,
        lastMessagePreview: "The next schedule is ready.",
        hasActiveRun: true,
      },
    ]);
    setPhase("connected");
    await waitForSolid(() => expect(page.textContent).toContain("The next schedule is ready."));
    expect(page.querySelector(".agents-home__card h2")?.textContent).toBe("Harbor");
    expect(page.querySelector(".agents-home__working")?.textContent).toBe("Working now");
  });
});
