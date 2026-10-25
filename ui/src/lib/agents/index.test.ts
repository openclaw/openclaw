// Control UI tests cover agents behavior.
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createGatewayHarness } from "../sessions/session-capability.test-support.ts";
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

function createToolsState(): Parameters<typeof buildToolsEffectiveRequestKey>[0] {
  return {
    sessions: { state: createSessionState() },
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "gpt-5-mini",
          modelProvider: "openai",
        },
      ],
    },
    chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
  };
}

function createSaveState() {
  const state: {
    configFormDirty: boolean;
    configForm: Record<string, unknown>;
    configFormOriginal: Record<string, unknown>;
  } = {
    configFormDirty: true,
    configForm: { agents: { entries: { main: {} } } },
    configFormOriginal: { agents: { entries: { main: {} } } },
  };
  return {
    state,
    save: vi.fn<AgentsConfigCapability["save"]>(async () => true),
    stageDefaultAgent: vi.fn<AgentsConfigCapability["stageDefaultAgent"]>(() => false),
  } satisfies AgentsConfigCapability;
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
    const client = createTestGatewayClient(request);
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);
    await agents.ensureList();
    await agents.ensureFiles("main");

    harness.publish(false);
    expect(agents.state.agentsList).toEqual(roster);
    expect(agents.files("main").list).toEqual(files);
    harness.publish(true);
    expect(agents.state.agentsList).toEqual(roster);
    expect(agents.files("main").list).toEqual(files);
    harness.publish(false, createTestGatewayClient(request));
    expect(agents.state.agentsList).toBeNull();
    expect(agents.files("main").list).toBeNull();
    refreshed.resolve(null);
    agents.dispose();
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
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    await expect(agents.ensureList()).resolves.toEqual(first);
    await expect(agents.ensureList()).resolves.toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);

    const notify = vi.fn();
    const unsubscribe = agents.subscribe(notify);
    harness.publish(true);
    harness.publish(true);
    expect(notify).not.toHaveBeenCalled();

    const refresh = agents.refreshList();
    const sharedRefresh = agents.ensureList();
    expect(request).toHaveBeenCalledTimes(2);
    pendingRefresh.resolve(replacement);
    await expect(Promise.all([refresh, sharedRefresh])).resolves.toEqual([
      replacement,
      replacement,
    ]);

    harness.publish(false);
    harness.publish(true);
    await expect(agents.ensureList()).resolves.toEqual(reconnected);
    expect(request).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(6);
    unsubscribe();
    agents.dispose();
  });

  it("starts a fresh list request after a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const staleLoad = agents.refreshList();
    const staleRead = agents.listRead;
    harness.publish(false);
    // Retiring a transport must release a native async frame before its reply.
    await expect(staleRead).resolves.toBeNull();
    await expect(staleLoad).resolves.toBeNull();
    harness.publish(true);
    const currentLoad = agents.refreshList();

    first.resolve({ defaultId: "old", agents: [{ id: "old" }] });
    await staleLoad;
    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsLoading).toBe(true);

    const current = { defaultId: "main", agents: [{ id: "main" }] };
    second.resolve(current);
    await currentLoad;
    expect(agents.state.agentsList).toEqual(current);
    expect(agents.state.agentsLoading).toBe(false);
    agents.dispose();
  });

  it("isolates file requests across a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const staleLoad = agents.refreshFiles("main");
    const staleRead = agents.files("main").read;
    harness.publish(false);
    expect(agents.files("main").read).toBeNull();
    await expect(staleRead).resolves.toBeNull();
    await expect(staleLoad).resolves.toBeNull();
    harness.publish(true);
    const currentLoad = agents.refreshFiles("main");

    first.resolve({ agentId: "main", workspace: "old", files: [] });
    await staleLoad;
    expect(agents.files("main").list).toBeNull();
    expect(agents.files("main").loading).toBe(true);

    const current = { agentId: "main", workspace: "new", files: [] };
    second.resolve(current);
    await currentLoad;
    expect(agents.files("main").list).toEqual(current);
    expect(agents.files("main").loading).toBe(false);
    agents.dispose();
  });

  it("retires existing file loading state before dropping disconnected owners", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn<TestRequest>().mockReturnValue(pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const load = agents.refreshFiles("main");
    const status = agents.files("main");
    expect(status.loading).toBe(true);

    harness.publish(false);

    expect(status.loading).toBe(false);
    expect(agents.files("main").loading).toBe(false);

    pending.resolve({ agentId: "main", workspace: "stale", files: [] });
    await load;
    agents.dispose();
  });

  it("keeps a replacement list request owned while its predecessor completes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    const staleLoad = agents.refreshList();
    const currentLoad = agents.refreshList();

    first.resolve({ defaultId: "old", agents: [{ id: "old" }] });
    await staleLoad;
    expect(agents.state.agentsList).toBeNull();
    expect(agents.state.agentsLoading).toBe(true);

    const current = { defaultId: "main", agents: [{ id: "main" }] };
    second.resolve(current);
    await currentLoad;
    expect(agents.state.agentsList).toEqual(current);
    expect(agents.state.agentsLoading).toBe(false);
    agents.dispose();
  });

  it("invalidates cached and in-flight file lists for changed agents", async () => {
    const pending = deferred<unknown>();
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce({ agentId: "main", workspace: "old", files: [] })
      .mockReturnValueOnce(pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

    await agents.refreshFiles("main");
    expect(agents.files("main").list?.workspace).toBe("old");

    const staleLoad = agents.refreshFiles("main");
    agents.invalidateFiles(["main"]);
    pending.resolve({ agentId: "main", workspace: "stale", files: [] });
    await staleLoad;

    expect(agents.files("main").list).toBeNull();
    expect(agents.files("main").loading).toBe(false);
    agents.dispose();
  });

  it("exposes current failures without rejecting legacy roster and file callers", async () => {
    const request = vi.fn<TestRequest>().mockRejectedValue(new Error("Read unavailable"));
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const agents = createAgentCapability(harness.gateway);
    const roster = agents.refreshList();
    const files = agents.refreshFiles("main");

    await expect(agents.listRead).resolves.toEqual({ error: "Read unavailable" });
    await expect(agents.files("main").read).resolves.toEqual({ error: "Read unavailable" });
    await expect(Promise.all([roster, files])).resolves.toEqual([null, null]);
    expect(agents.state.agentsError).toBe("Read unavailable");
    agents.dispose();
  });

  it("does not commit a list request after disposal", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn<TestRequest>().mockReturnValue(pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const agents = createAgentCapability(harness.gateway);

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
      vi.fn(async () => {
        throw new Error("gateway unavailable");
      }),
    );
    await expect(
      readToolsEffective(client, { agentId: "main", sessionKey: "main" }),
    ).rejects.toThrow("gateway unavailable");
  });
});

describe("buildToolsEffectiveRequestKey", () => {
  it("uses the catalog provider when the active session reports a stale provider", async () => {
    const state = createToolsState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "deepseek-chat",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" }];
    expect(buildToolsEffectiveRequestKey(state, { agentId: "main", sessionKey: "main" })).toBe(
      "main:main:model=deepseek/deepseek-chat",
    );
  });

  it("preserves already-qualified session models when the active session provider is stale and the catalog is empty", async () => {
    const state = createToolsState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "openai/gpt-5-mini",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [];
    expect(buildToolsEffectiveRequestKey(state, { agentId: "main", sessionKey: "main" })).toBe(
      "main:main:model=openai/gpt-5-mini",
    );
  });
});

describe("setDefaultAgent", () => {
  it("stages the default agent and persists a clean draft", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configForm = { agents: { entries: { main: {}, kimi: {} } } };
    config.state.configFormOriginal = { agents: { entries: { main: {}, kimi: {} } } };
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).toHaveBeenCalledTimes(1);
    expect(refreshAgents).toHaveBeenCalledTimes(1);
  });

  it("does not persist when the agent is absent from the config list", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configForm = { agents: { entries: { main: {} } } };
    vi.mocked(config.stageDefaultAgent).mockReturnValue(false);

    await setDefaultAgent(config, "ghost", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("ghost");
    expect(config.save).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
  });

  it("does not persist unrelated dirty agent config drafts", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configFormDirty = true;
    config.state.configFormOriginal = { agents: { entries: { main: {}, kimi: {} } } };
    config.state.configForm = {
      agents: {
        entries: { main: { model: "gpt-5.5" }, kimi: {} },
      },
    };
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configForm = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "kimi" } },
          entries: {
            main: { model: "gpt-5.5" },
            kimi: {},
          },
        },
      };
      config.state.configFormDirty = true;
      return true;
    });

    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(config.state.configForm).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "kimi" } },
        entries: {
          main: { model: "gpt-5.5" },
          kimi: {},
        },
      },
    });
    expect(config.state.configFormDirty).toBe(true);
  });

  it("keeps the shared agent cache unchanged when saving fails", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
    vi.mocked(config.save).mockResolvedValue(false);

    await setDefaultAgent(config, "kimi", refreshAgents);

    expect(refreshAgents).not.toHaveBeenCalled();
  });

  it("passes the originating action guard through the queued config save", async () => {
    const config = createSaveState();
    const refreshAgents = vi.fn(async () => null);
    let canDispatch = true;
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
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
  it.each(["Provider rejected credentials", "Workspace could not be created"])(
    "reports a failed creation and removes only its pending row: %s",
    async (message) => {
      const roster = { defaultId: "main", agents: [{ id: "main", name: "Molty" }] };
      const request = vi
        .fn<TestRequest>()
        .mockResolvedValueOnce(roster)
        .mockRejectedValueOnce(agentCreationRejection(message))
        .mockResolvedValueOnce({ exists: true, valid: true, sourceConfig: {} });
      const agents = createAgentCapability(
        createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
      );
      await agents.ensureList();
      await expect(agents.create("New agent")).rejects.toThrow(message);
      expect(request).toHaveBeenCalledWith("agents.create", {
        agentId: expect.stringMatching(/^bot-/),
        name: "New agent",
        onboarding: true,
      });
      expect(agents.state.agentsList).toEqual(roster);
      expect(agents.state.pendingAgent).toBeUndefined();
      agents.dispose();
    },
  );

  it("shows a pending agent immediately and publishes the verified receipt without another roster read", async () => {
    const creation = deferred<unknown>();
    const roster = makeBootRoster({
      agents: [{ id: "main", name: "Molty" }],
    });
    const request = vi
      .fn<TestRequest>()
      .mockResolvedValueOnce(roster)
      .mockReturnValueOnce(creation.promise);
    const agents = createAgentCapability(
      createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
    );
    await agents.ensureList();
    const creating = agents.create("New agent");
    expect(agents.state.pendingAgent).toMatchObject({
      id: expect.stringMatching(/^bot-/),
      name: "New agent",
    });
    await expect(agents.create("New agent")).resolves.toBeNull();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["agents.list", "agents.create"]);
    const pending = agents.state.pendingAgent;
    expect(pending).toEqual({ id: expect.stringMatching(/^bot-/), name: "New agent" });
    expect(agents.state.agentsList).toEqual(roster);
    const receipt = {
      agentId: pending!.id,
      name: pending!.name,
      onboarding: { sessionKey: `agent:${pending!.id}:main`, status: "completed" },
    };
    creation.resolve(receipt);
    await expect(creating).resolves.toEqual(receipt);
    expect(request).toHaveBeenLastCalledWith("agents.create", {
      agentId: receipt.agentId,
      name: "New agent",
      onboarding: true,
    });
    expect(agents.state.agentsList?.agents).toEqual([pending, ...roster.agents]);
    expect(agents.state.recentlyCreatedAgentId).toBe(receipt.agentId);
    expect(agents.state.pendingAgent).toBeUndefined();
    agents.dispose();
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
    const agents = createAgentCapability(
      createGatewayHarness({ request } as unknown as GatewayBrowserClient).gateway,
    );
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
    expect(agents.state.agentsList?.agents).toEqual([
      { id: "main", name: "Renamed" },
      { ...pending, identity: { emoji: "🌱" } },
    ]);
    request.mockRejectedValueOnce(new Error("Temporary read failure"));
    await agents.refreshList();
    expect(agents.state.agentsList).toEqual(currentRoster);
    expect(agents.state.agentsError).toContain("Temporary read failure");
    request.mockResolvedValueOnce(currentRoster);
    await expect(agents.ensureList()).resolves.toEqual(currentRoster);
    expect(agents.state.agentsList?.agents.map((agent) => agent.id)).toEqual(["main", pending.id]);
    expect(agents.state.agentsError).toBeNull();
    agents.dispose();
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
    const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agents = createAgentCapability(harness.gateway);
    await agents.ensureList();
    const creating = agents.create("New agent");
    const pending = agents.state.pendingAgent!;
    await creationStarted.promise;
    harness.publish(false);
    creation.resolve({
      agentId: pending.id,
      name: pending.name,
      onboarding: { status: "completed", sessionKey: `agent:${pending.id}:main` },
    });
    await expect(creating).resolves.toBeNull();
    expect(agents.state.pendingAgent).toBeUndefined();
    expect(agents.state.agentsList).toEqual(roster);
    harness.publish(true);
    await expect(agents.create("New agent")).resolves.toMatchObject({ agentId: pending.id });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "agents.list",
      "agents.create",
      "agents.list",
    ]);
    agents.dispose();
  });
});
