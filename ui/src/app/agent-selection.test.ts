import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createAgentSelectionCapability, selectApplicationSession } from "./agent-selection.ts";
import { loadSettings, saveSettings, type UiSettings } from "./settings.ts";

function publisher<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    read: () => value,
    subscribe: (listener: (next: T) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (next: T) => {
      value = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function createGateway(assistantAgentId: string | null = "Main") {
  const snapshot = publisher({ assistantAgentId });
  const connection = { gatewayUrl: "ws://gateway-a.test" };
  return {
    connection,
    get snapshot() {
      return snapshot.read();
    },
    subscribe: snapshot.subscribe,
    publish: snapshot.publish,
    switchGateway(url: string) {
      connection.gatewayUrl = url;
      snapshot.publish(snapshot.read());
    },
  };
}

function createRoster() {
  const state = publisher({ agentsList: null as AgentsListResult | null });
  return {
    get state() {
      return state.read();
    },
    subscribe: state.subscribe,
    publish: (agentsList: AgentsListResult | null) => state.publish({ agentsList }),
  };
}

function createPreferences(sidebarAgentsMode?: "chip" | "roster") {
  let settings = loadSettings("ws://gateway-a.test");
  const notifications = publisher(undefined);
  const refresh = (url = settings.gatewayUrl) => {
    settings = loadSettings(url);
    notifications.publish(undefined);
  };
  const patch = (changes: Partial<UiSettings>) => {
    saveSettings({ ...settings, ...changes });
    refresh();
  };
  if (sidebarAgentsMode) {
    patch({ sidebarAgentsMode });
  }
  return {
    get settings() {
      return settings;
    },
    patch,
    refresh,
    persistence: {
      load: (url: string) => loadSettings(url).selectedAgentId ?? null,
      save: (url: string, selectedAgentId: string | null) => {
        saveSettings({ ...loadSettings(url), selectedAgentId: selectedAgentId ?? undefined });
        refresh();
      },
    },
    setMode: (mode: "chip" | "roster") => patch({ sidebarAgentsMode: mode }),
    subscribe: notifications.subscribe,
  };
}

function agentRoster(
  defaultId: string,
  agents: Array<string | AgentsListResult["agents"][number]> = [defaultId],
): AgentsListResult {
  return {
    defaultId,
    mainKey: "main",
    scope: "per-sender",
    agents: agents.map((agent) =>
      typeof agent === "string" ? { id: agent, kind: "agent" } : agent,
    ),
  };
}

function defaultSelection(
  assistantAgentId: string | null = "Main",
  options: {
    agents?: AgentsListResult;
    persistence?: Parameters<typeof createAgentSelectionCapability>[2];
    configured?: boolean;
  } = {},
) {
  const gateway = createGateway(assistantAgentId);
  const roster = createRoster();
  if (options.agents) {
    roster.publish(options.agents);
  }
  const selection = createAgentSelectionCapability(
    gateway,
    roster,
    options.persistence,
    undefined,
    options.configured ? { requireConfiguredAgent: true } : {},
  );
  return { gateway, roster, selection };
}

function selectionFixture(assistantAgentId: string | null = "Main") {
  const gateway = createGateway(assistantAgentId);
  const roster = createRoster();
  const preferences = createPreferences();
  return {
    gateway,
    roster,
    preferences,
    select: (persistence = preferences.persistence) =>
      createAgentSelectionCapability(gateway, roster, persistence, preferences),
  };
}

describe("agent selection", () => {
  installSettingsStorageLifecycle();
  beforeEach(() => {
    setTestLocation({ protocol: "http:", host: "gateway-a.test", pathname: "/" });
  });

  it("restores the pre-team scope after chat navigation and a preference reload", () => {
    const scopeId = "research";
    let preferences = createPreferences();
    const gateway = createGateway();
    const roster = createRoster();
    const select = () =>
      createAgentSelectionCapability(gateway, roster, preferences.persistence, preferences);
    let selection = select();
    selection.setScope(scopeId);
    preferences.setMode("roster");
    selectApplicationSession({
      selection,
      gateway: { setSessionKey() {} },
      sessionKey: "agent:writer:main",
    });
    selection.dispose();

    preferences = createPreferences();
    selection = select();
    expect(selection.state).toEqual({ selectedId: "writer", scopeId: null });
    preferences.setMode("chip");
    expect(selection.state).toEqual({ selectedId: "writer", scopeId });
    expect(loadSettings().sidebarPreTeamScope).toBeUndefined();
    selection.dispose();
  });

  it("restores each gateway's own pre-team scope after switching away and back", () => {
    const { gateway: harness, preferences, select } = selectionFixture();
    harness.subscribe(() => preferences.refresh(harness.connection.gatewayUrl));
    const selection = select();
    selection.setScope("research");
    preferences.setMode("roster");
    selection.set("writer");

    harness.switchGateway("ws://gateway-b.test");
    selection.setScope(null);
    preferences.setMode("roster");
    selection.set("ops");
    harness.switchGateway("ws://gateway-a.test");
    preferences.setMode("chip");
    expect(selection.state).toEqual({ selectedId: "writer", scopeId: "research" });
    harness.switchGateway("ws://gateway-b.test");
    preferences.setMode("chip");
    expect(selection.state).toEqual({ selectedId: "ops", scopeId: null });
    selection.dispose();
  });
  it("keeps persisted team mode global through roster fallback and clears removed filters", () => {
    const preferences = createPreferences("roster");
    const roster = createRoster();
    const selection = createAgentSelectionCapability(
      createGateway("stale"),
      roster,
      { load: () => "research", save: vi.fn() },
      preferences,
    );
    expect(selection.state).toEqual({ selectedId: "research", scopeId: null });
    roster.publish(agentRoster("main", ["main", "research"]));
    selection.setScope("research");
    const listener = vi.fn();
    selection.subscribe(listener);
    roster.publish(agentRoster("main"));
    expect(selection.state).toEqual({ selectedId: "main", scopeId: null });
    expect(listener).toHaveBeenLastCalledWith({ selectedId: "main", scopeId: null });
    preferences.setMode("chip");
    expect(selection.state.scopeId).toBe("main");
  });

  it("reconciles a saved agent against a roster that excludes the Gateway default", () => {
    const persistence = { load: () => "private", save: vi.fn() };
    const { gateway, roster, selection } = defaultSelection("main", { persistence });

    expect(selection.state).toEqual({ selectedId: "private", scopeId: "private" });
    roster.publish(agentRoster("main", ["shared", "research"]));
    expect(selection.state).toEqual({ selectedId: "shared", scopeId: "shared" });
    expect(persistence.save).toHaveBeenLastCalledWith("ws://gateway-a.test", null);

    selection.set("research");
    gateway.publish({ assistantAgentId: "private" });
    expect(selection.state).toEqual({ selectedId: "research", scopeId: "research" });
    selection.set("private");
    expect(selection.state).toEqual({ selectedId: "shared", scopeId: "shared" });
    selection.dispose();
  });

  it("clears selection and remembered roster scope when the loaded roster becomes empty", () => {
    const { gateway, roster, preferences, select } = selectionFixture("main");
    const selection = select();
    const result = { ...agentRoster("main"), agents: [{ id: "shared" }] };
    roster.publish(result);
    selection.set("shared");
    preferences.setMode("roster");

    roster.publish(null);
    expect(selection.state.selectedId).toBe("shared");
    roster.publish({ ...result, agents: [] });
    expect(selection.state).toEqual({ selectedId: null, scopeId: null });
    expect(loadSettings().selectedAgentId).toBeUndefined();
    preferences.setMode("chip");
    expect(selection.state).toEqual({ selectedId: null, scopeId: null });

    gateway.publish({ assistantAgentId: "private" });
    selection.set("main");
    expect(selection.state).toEqual({ selectedId: null, scopeId: null });
    roster.publish(result);
    expect(selection.state).toEqual({ selectedId: "shared", scopeId: "shared" });
    selection.dispose();
  });

  it("clears system page scopes when the typed roster becomes known", () => {
    const { roster, selection } = defaultSelection("OpenClaw");

    expect(selection.state).toEqual({ selectedId: "openclaw", scopeId: "openclaw" });
    roster.publish({
      ...agentRoster("main"),
      agents: [
        { id: "main", kind: "agent" },
        { id: "openclaw", kind: "system" },
      ],
    });
    expect(selection.state).toEqual({ selectedId: "openclaw", scopeId: null });

    selection.setScope("historical");
    expect(selection.state.scopeId).toBe("historical");
    selection.setScope("main");
    expect(selection.state.scopeId).toBe("main");
    selection.setScope("openclaw");
    expect(selection.state.scopeId).toBeNull();
  });

  it.each(["filter", "sidebar mode"])(
    "publishes %s intent before notifying scope observers",
    (action) => {
      const { gateway, roster, preferences } = selectionFixture(null);
      const selection = createAgentSelectionCapability(gateway, roster, undefined, preferences);
      const observed = vi.fn(() => selection.intentRevision);
      selection.subscribe(observed);
      const revision = selection.intentRevision;
      gateway.publish({ assistantAgentId: "main" });
      expect(observed.mock.results.at(-1)?.value).toBe(revision);

      if (action === "filter") {
        selection.setScope("research");
      } else {
        preferences.setMode("roster");
      }
      expect(observed.mock.results.at(-1)?.value).toBe(revision + 1);
      roster.publish(agentRoster("main", ["main", "research"]));
      expect(selection.intentRevision).toBe(revision + 1);
      selection.dispose();
    },
  );

  it.each([false, true])(
    "follows a changed reconnect default after explicit owner removal: %s",
    (explicitOwner) => {
      const { gateway, roster, selection } = defaultSelection("Main", {
        agents: explicitOwner ? agentRoster("main", ["main", "research"]) : undefined,
      });
      if (explicitOwner) {
        selection.set("Research");
      }
      roster.publish(agentRoster("main"));
      expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
      gateway.publish({ assistantAgentId: null });
      expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
      gateway.publish({ assistantAgentId: "Ops" });
      expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
      roster.publish(agentRoster("ops", ["main", "ops"]));
      expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
    },
  );

  it.each(["selection", "roster"] as const)(
    "preserves explicit ownership through a reentrant %s subscriber",
    (trigger) => {
      const fallback = trigger === "roster";
      const { gateway, roster, selection } = defaultSelection("Main", {
        agents: fallback ? agentRoster("main", ["main", "ops", "research"]) : undefined,
      });
      if (fallback) {
        selection.set("Research");
      }
      selection.subscribe((state) => {
        if (state.selectedId === (fallback ? "main" : "research")) {
          if (fallback) {
            selection.set("Ops");
          } else {
            gateway.publish({ assistantAgentId: "Ops" });
          }
        }
      });
      if (fallback) {
        roster.publish(agentRoster("main", ["main", "ops"]));
        gateway.publish({ assistantAgentId: null });
        gateway.publish({ assistantAgentId: "Main" });
      } else {
        selection.set("Research");
      }
      const expected = fallback ? "ops" : "research";
      expect(selection.state).toEqual({ selectedId: expected, scopeId: expected });
    },
  );
});

describe("configured Settings agent selection", () => {
  const settingsFixture = (assistantAgentId: string | null = "Main") =>
    defaultSelection(assistantAgentId, { configured: true });

  it("keeps a cold link private until the roster confirms it, independently of chat", () => {
    const { gateway, roster, selection: settings } = settingsFixture(null);
    const chat = createAgentSelectionCapability(gateway, roster);
    settings.set("Research");
    expect(settings.state).toEqual({ selectedId: null, scopeId: null });
    gateway.publish({ assistantAgentId: "main" });
    roster.publish(agentRoster("main", ["main", "research"]));
    expect(settings.state).toEqual({ selectedId: "research", scopeId: "research" });
    expect(chat.state.selectedId).toBe("main");
    settings.set("main");
    chat.set("research");
    expect(settings.state.selectedId).toBe("main");
    settings.dispose();
    chat.dispose();
  });

  it.each([
    ["system", [{ id: "system", kind: "system" }, { id: "research" }], "research"],
    ["main", [{ id: "system", kind: "system" }], null],
  ] as const)("reconciles %s against the selectable roster", (requested, agents, expected) => {
    const { roster, selection: settings } = settingsFixture();
    settings.set(requested);
    roster.publish(agentRoster(requested, [...agents]));
    expect(settings.state).toEqual({ selectedId: expected, scopeId: expected });
    settings.setScope(requested);
    expect(settings.state).toEqual({ selectedId: expected, scopeId: expected });
    settings.dispose();
  });

  it("preserves explicit ownership through reconnect, then clears a removed agent", () => {
    const { gateway, roster, selection: settings } = settingsFixture();
    roster.publish(agentRoster("main", ["main", "research"]));
    settings.set("research");
    roster.publish(null);
    gateway.publish({ assistantAgentId: null });
    expect(settings.state.selectedId).toBeNull();
    gateway.publish({ assistantAgentId: "main" });
    roster.publish(agentRoster("main", ["main", "research"]));
    expect(settings.state.selectedId).toBe("research");
    roster.publish(agentRoster("main"));
    expect(settings.state).toEqual({ selectedId: "main", scopeId: "main" });
    roster.publish(agentRoster("main", []));
    expect(settings.state).toEqual({ selectedId: null, scopeId: null });
    settings.dispose();
  });

  it("does not carry pending intent to another Gateway and stops observing after disposal", () => {
    const gateway = createGateway();
    const roster = createRoster();
    gateway.subscribe(() => roster.publish(null));
    const settings = createAgentSelectionCapability(gateway, roster, undefined, undefined, {
      requireConfiguredAgent: true,
    });
    settings.set("research");
    const revision = settings.intentRevision;
    gateway.switchGateway("ws://gateway-b.test");
    expect(settings.intentRevision).toBeGreaterThan(revision);
    roster.publish(agentRoster("main", ["main", "research"]));
    expect(settings.state.selectedId).toBe("main");
    const listener = vi.fn();
    settings.subscribe(listener);
    settings.dispose();
    roster.publish(agentRoster("research"));
    gateway.publish({ assistantAgentId: "research" });
    expect(settings.state.selectedId).toBe("main");
    expect(listener).not.toHaveBeenCalled();
  });

  it("records same-id and ABA user intent without treating roster publication as new intent", () => {
    const { roster, selection: settings } = settingsFixture();
    const initialRevision = settings.intentRevision;
    roster.publish(agentRoster("main", ["main", "research"]));
    expect(settings.intentRevision).toBe(initialRevision);
    settings.set("main");
    settings.set("research");
    settings.set("main");
    expect(settings.intentRevision).toBe(initialRevision + 3);
    roster.publish(agentRoster("research"));
    expect(settings.intentRevision).toBe(initialRevision + 3);
    settings.dispose();
  });
});

describe("application session selection", () => {
  it.each([
    { sessionKey: "agent:Research:work", agentId: undefined },
    { sessionKey: "global", agentId: "Research" },
  ])("selects the owner before the Gateway session ($sessionKey)", ({ sessionKey, agentId }) => {
    const calls: string[] = [];
    selectApplicationSession({
      selection: { set: (id) => calls.push(`agent:${id}`) },
      gateway: { setSessionKey: (key) => calls.push(`session:${key}`) },
      sessionKey,
      agentId,
    });
    expect(calls).toEqual(["agent:research", `session:${sessionKey}`]);
  });
});
