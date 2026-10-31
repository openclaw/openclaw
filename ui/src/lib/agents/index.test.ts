import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../sessions/session-capability.test-support.ts";
import { createSessionState } from "../sessions/session-capability.ts";
import { agentCreationRejection } from "./creation.test-support.ts";
import {
  buildToolsEffectiveRequestKey,
  createAgentCapability,
  readToolsEffective,
} from "./index.ts";
import { setDefaultAgent } from "./mutations.ts";

type AgentsConfigCapability = Parameters<typeof setDefaultAgent>[0];

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createSaveState(configFormDirty = false) {
  const state = { configFormDirty };
  return {
    state,
    save: vi.fn<AgentsConfigCapability["save"]>(async () => true),
    stageDefaultAgent: vi.fn<AgentsConfigCapability["stageDefaultAgent"]>(() => {
      state.configFormDirty = true;
      return true;
    }),
  } satisfies AgentsConfigCapability;
}

function agentFixture(request: TestRequest) {
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const agents = createAgentCapability(harness.gateway);
  onTestFinished(() => agents.dispose());
  return { ...harness, agents };
}

describe("createAgentCapability lifecycle", () => {
  it.each(["account", "recovery scope"])(
    "retires catalogs when the same client's %s changes",
    async (change) => {
      const roster = { defaultId: "main", agents: [{ id: "main" }] };
      const files = { agentId: "main", workspace: "workspace", files: [] };
      const pending = deferred<unknown>();
      const current = deferred<unknown>();
      const request = vi
        .fn<TestRequest>()
        .mockResolvedValueOnce(roster)
        .mockResolvedValueOnce(files)
        .mockReturnValueOnce(pending.promise)
        .mockReturnValue(current.promise);
      const source = createApplicationGateway();
      const hello = gatewayHelloForMethods(["agents.list", "agents.files.list"], ["operator.read"]);
      hello.auth!.recoveryScope = "alice-scope";
      source.publish({
        ...source.gateway.snapshot,
        client: createTestGatewayClient(request),
        phase: "connected",
        hello,
        selfUser: { id: "alice", name: "Alice" },
      });
      const agents = createAgentCapability(source.gateway);
      await agents.ensureList();
      await agents.ensureFiles("main");
      const old = agents.refreshList();
      source.publish({
        ...source.gateway.snapshot,
        ...(change === "account"
          ? { selfUser: { id: "bob", name: "Bob" } }
          : {
              selfUser: undefined,
              hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
            }),
      });
      expect(agents.state.agentsList).toBeNull();
      expect(agents.files("main").list).toBeNull();
      pending.resolve(roster);
      await old;
      expect(agents.state.agentsList).toBeNull();
      expect(request).toHaveBeenCalledTimes(4);
      current.resolve({ defaultId: "main", agents: [] });
      await agents.ensureList();
      expect(agents.state.agentsList?.agents).toEqual([]);
      agents.dispose();
    },
  );

  it("retains the roster and file inventory through a blip, but clears another client's data", async () => {
    const roster = { defaultId: "main", agents: [{ id: "main" }] };
    const files = { agentId: "main", workspace: "workspace", files: [] };
    const refreshed = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(roster)
      .mockResolvedValueOnce(files)
      .mockReturnValue(refreshed.promise);
    const { agents, publish } = agentFixture(request);
    await agents.ensureList();
    await agents.ensureFiles("main");

    publish(false);
    expect(agents.state.agentsList).toEqual(roster);
    expect(agents.files("main").list).toEqual(files);
    publish(true);
    expect(agents.state.agentsList).toEqual(roster);
    expect(agents.files("main").list).toEqual(files);
    publish(false, createTestGatewayClient(request));
    expect(agents.state.agentsList).toBeNull();
    expect(agents.files("main").list).toBeNull();
    refreshed.resolve(null);
  });
  it("reuses the current roster while preserving forced refresh and reconnect ownership", async () => {
    const first = { defaultId: "main", agents: [{ id: "main" }] };
    const replacement = { defaultId: "research", agents: [{ id: "research" }] };
    const reconnected = { defaultId: "writer", agents: [{ id: "writer" }] };
    const pendingRefresh = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce(reconnected);
    const { agents, publish } = agentFixture(request);

    await expect(agents.ensureList()).resolves.toEqual(first);
    await expect(agents.ensureList()).resolves.toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);

    const notify = vi.fn();
    const unsubscribe = agents.subscribe(notify);
    publish(true);
    publish(true);
    expect(notify).not.toHaveBeenCalled();

    const refresh = agents.refreshList();
    const sharedRefresh = agents.ensureList();
    expect(request).toHaveBeenCalledTimes(2);
    pendingRefresh.resolve(replacement);
    await expect(Promise.all([refresh, sharedRefresh])).resolves.toEqual([
      replacement,
      replacement,
    ]);

    publish(false);
    publish(true);
    await expect(agents.ensureList()).resolves.toEqual(reconnected);
    expect(request).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it.each([
    ["list", "reconnect"],
    ["files", "reconnect"],
    ["list", "replacement"],
  ] as const)("isolates %s requests across %s", async (kind, boundary) => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { agents, publish } = agentFixture(request);
    const refresh = () => (kind === "list" ? agents.refreshList() : agents.refreshFiles("main"));
    const read = () => (kind === "list" ? agents.listRead : agents.files("main").read);
    const snapshot = () =>
      kind === "list"
        ? { list: agents.state.agentsList, loading: agents.state.agentsLoading }
        : agents.files("main");
    const result = (name: string) =>
      kind === "list"
        ? { defaultId: name, agents: [{ id: name }] }
        : { agentId: "main", workspace: name, files: [] };
    const staleLoad = refresh();
    const staleRead = read();
    const staleStatus = snapshot();
    expect(staleStatus.loading).toBe(true);
    if (boundary === "reconnect") {
      publish(false);
      if (kind === "files") {
        expect(read()).toBeNull();
        expect(staleStatus.loading).toBe(false);
        expect(snapshot().loading).toBe(false);
      }
      // Retirement releases native readers before the old transport replies.
      await expect(staleRead).resolves.toBeNull();
      await expect(staleLoad).resolves.toBeNull();
      publish(true);
    }
    const currentLoad = refresh();

    first.resolve(result("old"));
    await staleLoad;
    expect(snapshot().list).toBeNull();
    expect(snapshot().loading).toBe(true);

    const current = result("new");
    second.resolve(current);
    await currentLoad;
    expect(snapshot().list).toEqual(current);
    expect(snapshot().loading).toBe(false);
  });

  it("invalidates cached and in-flight file lists for changed agents", async () => {
    const pending = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce({ agentId: "main", workspace: "old", files: [] })
      .mockReturnValueOnce(pending.promise);
    const { agents } = agentFixture(request);

    await agents.refreshFiles("main");
    expect(agents.files("main").list?.workspace).toBe("old");

    const staleLoad = agents.refreshFiles("main");
    agents.invalidateFiles(["main"]);
    pending.resolve({ agentId: "main", workspace: "stale", files: [] });
    await staleLoad;

    expect(agents.files("main").list).toBeNull();
    expect(agents.files("main").loading).toBe(false);
  });

  it("exposes current failures without rejecting legacy roster and file callers", async () => {
    const request = vi.fn<TestRequest>().mockRejectedValue(new Error("Read unavailable"));
    const { agents } = agentFixture(request);
    const roster = agents.refreshList();
    const files = agents.refreshFiles("main");

    await expect(agents.listRead).resolves.toEqual({ error: "Read unavailable" });
    await expect(agents.files("main").read).resolves.toEqual({ error: "Read unavailable" });
    await expect(Promise.all([roster, files])).resolves.toEqual([null, null]);
    expect(agents.state.agentsError).toBe("Read unavailable");
  });

  it("does not commit a list request after disposal", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn<TestRequest>().mockReturnValue(pending.promise);
    const { agents } = agentFixture(request);

    const load = agents.refreshList();
    agents.dispose();
    pending.resolve({ defaultId: "stale", agents: [{ id: "stale" }] });
    await load;

    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsLoading).toBe(false);
  });
});

describe("readToolsEffective", () => {
  it("returns the effective-tools payload for the requested agent and session", async () => {
    const payload = { agentId: "main", profile: "coding", groups: [] };
    const request = vi.fn(async () => payload);
    const client = createTestGatewayClient(request);
    await expect(
      readToolsEffective(client, { agentId: "main", sessionKey: "main" }),
    ).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
  });

  it("throws the existing display error for the native error boundary", async () => {
    const client = createTestGatewayClient(
      vi.fn().mockRejectedValue(new Error("gateway unavailable")),
    );
    await expect(
      readToolsEffective(client, { agentId: "main", sessionKey: "main" }),
    ).rejects.toThrow("gateway unavailable");
  });
});

describe("buildToolsEffectiveRequestKey", () => {
  it.each([
    [
      "deepseek-chat",
      [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" }],
      "deepseek/deepseek-chat",
    ],
    ["openai/gpt-5-mini", [], "openai/gpt-5-mini"],
  ] as const)("resolves %s despite the stale session provider", (model, catalog, expected) => {
    const state = {
      sessions: { state: createSessionState() },
      sessionsResult: sessionsResult([
        { key: "main", kind: "direct", updatedAt: 0, model, modelProvider: "zai" },
      ]),
      chatModelCatalog: [...catalog],
    };
    expect(buildToolsEffectiveRequestKey(state, { agentId: "main", sessionKey: "main" })).toBe(
      `main:main:model=${expected}`,
    );
  });
});

describe("setDefaultAgent", () => {
  it.each([
    ["clean draft", false, true, true, 1, 1],
    ["absent agent", false, false, true, 0, 0],
    ["unrelated dirty draft", true, true, true, 0, 0],
    ["failed save", false, true, false, 1, 0],
  ] as const)(
    "persists only an accepted %s",
    async (_name, dirty, accepted, saved, saves, refreshes) => {
      const config = createSaveState(dirty);
      const refreshAgents = vi.fn(async () => null);
      config.stageDefaultAgent.mockImplementation(() => {
        if (accepted) {
          config.state.configFormDirty = true;
        }
        return accepted;
      });
      config.save.mockResolvedValue(saved);
      await setDefaultAgent(config, "kimi", refreshAgents);
      expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
      expect(config.save).toHaveBeenCalledTimes(saves);
      expect(refreshAgents).toHaveBeenCalledTimes(refreshes);
      expect(config.state.configFormDirty).toBe(dirty || accepted);
    },
  );

  it("passes the originating action guard through the queued config save", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    let canDispatch = true;
    vi.mocked(config.save).mockImplementation(async (options) => {
      canDispatch = false;
      return options?.canDispatch?.() ?? true;
    });

    await setDefaultAgent(config, "kimi", refreshAgents, () => canDispatch);

    expect(config.save).toHaveBeenCalledOnce();
    expect(refreshAgents).not.toHaveBeenCalled();
  });
});

describe("agent creation", () => {
  it("reports a failed creation and removes only its pending row", async () => {
    const message = "Provider rejected credentials";
    const roster = { defaultId: "main", agents: [{ id: "main", name: "Molty" }] };
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(roster)
      .mockRejectedValueOnce(agentCreationRejection(message))
      .mockResolvedValueOnce({ exists: true, valid: true, sourceConfig: {} });
    const { agents } = agentFixture(request);
    await agents.ensureList();
    await expect(agents.create("New agent")).rejects.toThrow(message);
    expect(request).toHaveBeenCalledWith("agents.create", {
      agentId: expect.stringMatching(/^bot-/),
      name: "New agent",
      onboarding: true,
    });
    expect(agents.state.agentsList).toEqual(roster);
    expect(agents.state.pendingAgent).toBeUndefined();
  });

  it("shows a pending agent immediately and publishes the verified receipt without another roster read", async () => {
    const creation = deferred<unknown>();
    const roster = makeBootRoster({
      agents: [{ id: "main", name: "Molty" }],
    });
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(roster)
      .mockReturnValueOnce(creation.promise);
    const { agents } = agentFixture(request);
    await agents.ensureList();
    const creating = agents.create("New agent");
    const pending = agents.state.pendingAgent;
    expect(pending).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
    await expect(agents.create("New agent")).resolves.toBeNull();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.list", "agents.create"]);
    expect(agents.state.agentsList).toEqual(roster);
    const receipt = {
      agentId: pending!.id,
      name: pending!.name,
      onboarding: { sessionKey: `agent:${pending!.id}:main`, status: "completed" },
    };
    creation.resolve(receipt);
    await expect(creating).resolves.toEqual(receipt);
    expect(agents.state.agentsList?.agents).toEqual([pending, ...roster.agents]);
    expect(agents.state.recentlyCreatedAgentId).toBe(receipt.agentId);
    expect(agents.state.pendingAgent).toBeUndefined();
  });

  it("reconciles an overlapping config refresh without holding up the new chat", async () => {
    const creation = deferred<unknown>();
    const staleRead = deferred<unknown>();
    const currentRead = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce({ defaultId: "main", agents: [{ id: "main", name: "Old name" }] })
      .mockReturnValueOnce(creation.promise)
      .mockReturnValueOnce(staleRead.promise)
      .mockReturnValueOnce(currentRead.promise);
    const { agents } = agentFixture(request);
    await agents.ensureList();
    const creating = agents.create("New agent");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const oldRefresh = agents.refreshList();
    const pending = agents.state.pendingAgent!;
    creation.resolve({ agentId: pending.id, name: pending.name });
    await creating;
    expect(agents.state.agentsList?.agents[0]).toEqual(pending);
    expect(agents.state.agentsLoading).toBe(true);
    staleRead.resolve({ defaultId: "main", agents: [{ id: "main", name: "Stale name" }] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(agents.state.agentsList?.agents[0]).toEqual(pending);
    const currentRoster = {
      defaultId: "main",
      agents: [
        { id: "main", name: "Renamed" },
        { ...pending, identity: { emoji: "🌱" } },
      ],
    };
    currentRead.resolve(currentRoster);
    expect(await oldRefresh).toBe(agents.state.agentsList);
    expect(agents.state.agentsList).toEqual(currentRoster);
  });

  it("recovers a disconnected creation receipt without dispatching another attempt", async () => {
    const creation = deferred<unknown>();
    const creationStarted = deferred();
    const roster = { defaultId: "main", agents: [{ id: "main", name: "Molty" }] };
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(roster)
      .mockImplementationOnce(() => {
        creationStarted.resolve();
        return creation.promise;
      })
      .mockResolvedValueOnce(roster);
    const { agents, publish } = agentFixture(request);
    await agents.ensureList();
    const creating = agents.create("New agent");
    const pending = agents.state.pendingAgent!;
    await creationStarted.promise;
    publish(false);
    creation.resolve({
      agentId: pending.id,
      name: pending.name,
      onboarding: { status: "completed", sessionKey: `agent:${pending.id}:main` },
    });
    await expect(creating).resolves.toBeNull();
    expect(agents.state.pendingAgent).toBeUndefined();
    expect(agents.state.agentsList).toEqual(roster);
    publish(true);
    await expect(agents.create("New agent")).resolves.toMatchObject({ agentId: pending.id });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "agents.create",
      "agents.list",
    ]);
  });
});
