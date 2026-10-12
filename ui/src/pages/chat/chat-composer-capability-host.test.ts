import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SkillsLibraryListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  gatewayHelloForMethods,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { ChatComposerCapabilityHost } from "./chat-composer-capability-host.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

function createContext(configSnapshot: ConfigSnapshot | null): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client: {} as GatewayBrowserClient,
        phase: "connected",
        hello: sessionMutationGatewayHello(["operator.admin", "operator.write"]),
      },
    },
    navigate: vi.fn(),
    runtimeConfig: {
      ensureLoaded: vi.fn(async () => undefined),
      state: { configLoading: false, configSnapshot },
    },
    sessions: { state: { modelOverrides: {} } },
  } as unknown as ApplicationContext;
}

function createState(): ChatPageHost {
  return {
    basePath: "",
    client: {} as GatewayBrowserClient,
    connected: true,
    sessionKey: "main",
  } as ChatPageHost;
}

function createAddServerHarness(
  options: {
    globalError?: string;
    throwGlobal?: boolean;
    sessionError?: string;
    refreshError?: string;
    navigateAfterSave?: boolean;
  } = {},
) {
  const context = createContext({ runtimeConfig: {} });
  const state = createState();
  const session: GatewaySessionRow = {
    key: "main",
    kind: "direct",
    toolOverrides: { skills: { release: false } },
  };
  const events: string[] = [];
  const globalWrites: unknown[] = [];
  context.runtimeConfig.patchFromSnapshot = vi.fn(
    async (build: Parameters<ApplicationContext["runtimeConfig"]["patchFromSnapshot"]>[0]) => {
      events.push("global");
      if (options.throwGlobal) {
        throw new Error("config failed");
      }
      if (options.globalError) {
        context.runtimeConfig.state.lastError = options.globalError;
        return false;
      }
      const result = build({});
      if ("error" in result) {
        throw new Error(result.error);
      }
      globalWrites.push(result.options.raw);
      if (options.navigateAfterSave) {
        state.sessionKey = "other";
      }
      return true;
    },
  );
  context.runtimeConfig.refresh = vi.fn(async () => undefined);
  const refresh = vi.fn(async () => {
    events.push("load");
    if (options.refreshError) {
      throw new Error(options.refreshError);
    }
  });
  const patch = vi.fn(async () => {
    events.push("session");
    if (options.sessionError) {
      throw new Error(options.sessionError);
    }
    return { ok: true as const, key: session.key, path: "", entry: { sessionId: "test-session" } };
  });
  state.client = context.gateway.snapshot.client;
  const { gateway } = createGatewayHarness(state.client!);
  const sessions = createTestSessionCapability(gateway);
  Object.assign(sessions.state, {
    agentId: "main",
    result: {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [session],
    },
  });
  sessions.refresh = refresh;
  sessions.patch = patch;
  state.sessions = sessions;
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    container.remove();
    sessions.dispose();
  });
  const settled = deferred();
  let submitted = false;
  const host = new ChatComposerCapabilityHost(() => {
    render(host.renderAddServerDialog(context, state, session), container);
    if (
      submitted &&
      !container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled
    ) {
      settled.resolve();
    }
  });
  host.props(context, state, session, "main").onAddServer?.();
  return {
    container,
    events,
    globalWrites,
    refresh,
    patch,
    async submit(
      scope: "session" | "everywhere" = "session",
      server: { transport: "stdio" | "streamable-http"; target: string } = {
        transport: "stdio",
        target: "docs-mcp",
      },
    ) {
      container
        .querySelector<HTMLInputElement>(`input.settings-segmented__input[value="${scope}"]`)!
        .click();
      container.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "docs";
      container.querySelector<HTMLSelectElement>('[name="mcp-transport"]')!.value =
        server.transport;
      container.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value = server.target;
      submitted = true;
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settled.promise;
    },
  };
}

describe("ChatComposerCapabilityHost", () => {
  it("adds an everywhere server globally without a session patch", async () => {
    const harness = createAddServerHarness();
    await harness.submit("everywhere", {
      transport: "streamable-http",
      target: "https://mcp.example.test",
    });

    expect(harness.globalWrites).toEqual([
      {
        mcp: {
          servers: { docs: { url: "https://mcp.example.test", transport: "streamable-http" } },
        },
      },
    ]);
    expect(harness.events).toEqual(["global"]);
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.container.querySelector("form")).toBeNull();
  });

  it("adds a session server disabled globally before enabling its sparse override", async () => {
    const harness = createAddServerHarness();
    await harness.submit();

    expect(harness.globalWrites).toEqual([
      { mcp: { servers: { docs: { command: "docs-mcp", enabled: false } } } },
    ]);
    expect(harness.patch).toHaveBeenCalledWith(
      "main",
      {
        toolOverrides: { mcpServers: { docs: true }, skills: { release: false } },
      },
      expect.any(Object),
    );
    expect(harness.events).toEqual(["global", "load", "session"]);
    expect(harness.container.querySelector("form")).toBeNull();
  });

  it("does not patch the session when the global add fails", async () => {
    const harness = createAddServerHarness({ globalError: "duplicate" });
    await harness.submit();

    expect(harness.container.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "duplicate",
    );
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("classifies a thrown global write as a config-stage failure", async () => {
    const harness = createAddServerHarness({ throwGlobal: true });
    await harness.submit("everywhere");

    expect(harness.container.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "config failed",
    );
    expect(harness.events).toEqual(["global"]);
  });

  it("reports a session-stage failure after retaining the global add", async () => {
    const harness = createAddServerHarness({ sessionError: "gateway disconnected" });
    await harness.submit();

    expect(harness.globalWrites).toEqual([
      { mcp: { servers: { docs: { command: "docs-mcp", enabled: false } } } },
    ]);
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The server was saved disabled globally, but enabling it for this session failed: gateway disconnected",
    );
    expect(harness.events).toEqual(["global", "load", "session", "load"]);
  });

  it("aborts the session stage when navigation changes the submitted identity", async () => {
    const harness = createAddServerHarness({ navigateAfterSave: true });
    await harness.submit();

    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The active session changed before it could be enabled.",
    );
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("returns a session-stage error when refreshing current overrides rejects", async () => {
    const harness = createAddServerHarness({ refreshError: "refresh failed" });
    await harness.submit();

    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The server was saved disabled globally, but enabling it for this session failed: refresh failed",
    );
    expect(harness.events).toEqual(["global", "load"]);
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("blocks tool override patches without exact sessions.patch access", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const request = vi.fn();
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    const props = host.props(context, state, session, "main");
    expect(props.mutationBlockedReason).toBeTruthy();
    const result = await (
      host as unknown as {
        patch: (
          context: ApplicationContext,
          state: ChatPageHost,
          next: { skills: Record<string, boolean> },
        ) => Promise<{ ok: true } | { ok: false; error: string }>;
      }
    ).patch(context, state, { skills: { release: true } });

    expect(result).toEqual({ ok: false, error: props.mutationBlockedReason });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Everywhere selectable while a missing session row blocks session submit", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    const state = createState();
    host.props(context, state, undefined, "main").onAddServer?.();
    const container = document.createElement("div");
    render(host.renderAddServerDialog(context, state, undefined), container);
    await Promise.resolve();

    const scope = container.querySelector<HTMLInputElement>(
      'input.settings-segmented__input[value="everywhere"]',
    );
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(scope?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
  });

  it("derives capability defaults from the active runtime snapshot", () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const props = host.props(
      createContext({
        sourceConfig: {
          mcp: { servers: { source: { command: "source-mcp", enabled: true } } },
          tools: { web: { search: { enabled: false } } },
        },
        runtimeConfig: {
          mcp: { servers: { runtime: { command: "runtime-mcp", enabled: false } } },
          tools: { web: { search: { enabled: true } } },
        },
      }),
      createState(),
      { key: "main" } as GatewaySessionRow,
      "main",
    );

    expect(props.mcpServers.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: "runtime", enabled: false },
    ]);
    expect(props.webSearchBaseEnabled).toBe(true);
  });

  it("refetches effective tools when an active connector definition changes", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({
      appliedConfigHash: "config-1",
      runtimeConfig: {
        mcp: { servers: { github: { url: "https://mcp.example.test", enabled: true } } },
      },
    });
    context.gateway.snapshot.hello = {
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const firstResult = { agentId: "main", groups: [], profile: "full" };
    const secondResult = { agentId: "main", groups: [], profile: "minimal" };
    const request = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).toBe(firstResult);
    });

    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-2",
      runtimeConfig: {
        mcp: {
          servers: {
            github: { url: "https://new-mcp.example.test", enabled: true },
          },
        },
      },
    };
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.props(context, state, session, "main", true).toolsEffectiveLoading).toBe(true);

    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).toBe(secondResult);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refetches effective tools each time Tool access is opened", async () => {
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const beforeRun = { agentId: "main", groups: [], profile: "before-run" };
    const afterRun = { agentId: "main", groups: [], profile: "after-run" };
    const request = vi.fn().mockResolvedValueOnce(beforeRun).mockResolvedValueOnce(afterRun);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;
    const menu = (toolAccessOpen = false) =>
      host.props(context, state, session, "main", toolAccessOpen);
    // The host notifies once a request settles and its result is published.
    let published = deferred();
    const host = new ChatComposerCapabilityHost(() => {
      if (!menu().toolsEffectiveLoading) {
        published.resolve();
      }
    });
    const openToolAccess = (times: number) => {
      published = deferred();
      for (let open = 0; open < times; open += 1) {
        menu().onOpenToolAccess?.("github");
      }
      return published.promise;
    };

    await openToolAccess(1);
    expect(menu().toolsEffectiveResult).toBe(beforeRun);
    menu(true);
    expect(request).toHaveBeenCalledTimes(1);

    const reopened = openToolAccess(2);
    expect(request).toHaveBeenCalledTimes(2);
    await reopened;
    expect(menu().toolsEffectiveResult).toBe(afterRun);
  });

  it("keeps the newest tools after connector configuration changes away and back", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-b",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-a",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    expect(request).toHaveBeenCalledTimes(3);

    third.resolve({ agentId: "main", profile: "newest-a", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "newest-a",
      );
    });
    first.resolve({ agentId: "main", profile: "stale-a", groups: [] });
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
      "newest-a",
    );
    second.resolve({ agentId: "main", profile: "stale-b", groups: [] });
  });

  it("keeps a replacement tools request loading when its same-key predecessor finishes", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-b",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-a",
      runtimeConfig: {},
    };
    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    first.resolve({ agentId: "main", profile: "stale-a", groups: [] });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    await Promise.resolve();

    expect(host.props(context, state, session, "main").toolsEffectiveResult).toBeNull();
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(true);

    third.resolve({ agentId: "main", profile: "newest-a", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "newest-a",
      );
    });
    second.resolve({ agentId: "main", profile: "stale-b", groups: [] });
  });

  it("retires effective tools and requests across a same-client reconnect", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ appliedConfigHash: "config-a", runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    const first = deferred<unknown>();
    const current = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise);
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    state.connectionEpoch = 1;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    state.connectionEpoch = 2;
    const reconnected = host.props(context, state, session, "main");
    expect(reconnected.toolsEffectiveResult).toBeNull();
    expect(reconnected.toolsEffectiveLoading).toBe(false);
    reconnected.onOpenToolAccess?.("github");
    expect(request).toHaveBeenCalledTimes(2);

    first.resolve({ agentId: "main", profile: "retired-connection", groups: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.props(context, state, session, "main").toolsEffectiveResult).toBeNull();
    expect(host.props(context, state, session, "main").toolsEffectiveLoading).toBe(true);

    current.resolve({ agentId: "main", profile: "current-connection", groups: [] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult?.profile).toBe(
        "current-connection",
      );
    });
  });

  it("retires cached skills and their requests across a same-client reconnect", async () => {
    const host = new ChatComposerCapabilityHost(vi.fn());
    const context = createContext({ runtimeConfig: {} });
    const first = deferred<unknown>();
    const current = deferred<unknown>();
    const statusRequest = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(current.promise);
    const library: SkillsLibraryListResult = {
      entries: [],
      profileId: null,
      multipleProfiles: false,
      defaultTarget: "workspace",
      canManageWorkspace: true,
      defaultSelectionLimit: 64,
      session: { sessionKey: "main", selections: [], attachable: [] },
    };
    const request = vi.fn((method: string) => {
      if (method === "skills.status") {
        return statusRequest();
      }
      if (method === "skills.library.list") {
        return Promise.resolve(library);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const state = createState();
    state.client = { request } as unknown as GatewayBrowserClient;
    state.connectionEpoch = 1;
    const session = { key: "main" } as GatewaySessionRow;
    const skill = (name: string) => ({
      name,
      skillKey: name,
      disabled: false,
      blockedByAllowlist: false,
      missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    });

    host.props(context, state, session, "main").onLoadSkills?.();
    state.connectionEpoch = 2;
    const reconnected = host.props(context, state, session, "main");
    expect(reconnected.skills).toBeNull();
    expect(reconnected.skillsLoading).toBe(false);
    reconnected.onLoadSkills?.();
    expect(statusRequest).toHaveBeenCalledTimes(2);
    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "main" }],
      ["skills.library.list", { sessionKey: "main" }],
      ["skills.status", { agentId: "main" }],
      ["skills.library.list", { sessionKey: "main" }],
    ]);

    first.resolve({ skills: [skill("retired")] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.props(context, state, session, "main").skills).toBeNull();
    expect(host.props(context, state, session, "main").skillsLoading).toBe(true);

    current.resolve({ skills: [skill("current")] });
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").skills?.map(({ name }) => name)).toEqual([
        "current",
      ]);
    });
  });

  it("records an unexpected effective-tools loader rejection", async () => {
    const notify = vi.fn();
    const host = new ChatComposerCapabilityHost(notify);
    const context = createContext({ runtimeConfig: {} });
    context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.patch", "tools.effective"]);
    let stateReads = 0;
    Object.defineProperty(context.sessions, "state", {
      configurable: true,
      get: () => {
        stateReads += 1;
        if (stateReads === 3) {
          throw new Error("unexpected loader failure");
        }
        return { modelOverrides: {} };
      },
    });
    const state = createState();
    const request = vi.fn().mockResolvedValue({ agentId: "main", groups: [], profile: "full" });
    state.client = { request } as unknown as GatewayBrowserClient;
    const session = { key: "main" } as GatewaySessionRow;

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveError).toBe(true);
    });

    expect(host.props(context, state, session, "main").toolAccessMutationBlockedReason).toBe(
      "Couldn’t load tools.",
    );

    host.props(context, state, session, "main").onOpenToolAccess?.("github");
    await vi.waitFor(() => {
      expect(host.props(context, state, session, "main").toolsEffectiveResult).not.toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
