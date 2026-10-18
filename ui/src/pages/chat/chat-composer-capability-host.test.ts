import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SkillsLibraryListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  gatewayHelloForMethods,
  sessionMutationGatewayHello,
} from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  ChatComposerCapabilityHost,
  ChatComposerCapabilityDialogs,
} from "./chat-composer-capability-host.tsx";
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

function capabilityHarness(
  request: ReturnType<typeof vi.fn>,
  snapshot: ConfigSnapshot = { appliedConfigHash: "config-a", runtimeConfig: {} },
) {
  const host = new ChatComposerCapabilityHost();
  const context = createContext(snapshot);
  const state = createState();
  state.client = { request } as unknown as GatewayBrowserClient;
  const session = { key: "main" } as GatewaySessionRow;
  return {
    host,
    context,
    state,
    session,
    props: () => host.props(context, state, session, "main"),
  };
}

function toolsHarness(request: Parameters<typeof capabilityHarness>[0], snapshot?: ConfigSnapshot) {
  const harness = capabilityHarness(request, snapshot);
  harness.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "sessions.patch",
    "tools.effective",
  ]);
  return harness;
}

function changeConfig(context: ApplicationContext, appliedConfigHash: string) {
  context.runtimeConfig.state.configSnapshot = { appliedConfigHash, runtimeConfig: {} };
}

function replacedToolsHarness() {
  const [first, second, third] = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
  const request = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const harness = toolsHarness(request);
  harness.props().onOpenToolAccess?.("github");
  changeConfig(harness.context, "config-b");
  harness.props().onOpenToolAccess?.("github");
  changeConfig(harness.context, "config-a");
  harness.props().onOpenToolAccess?.("github");
  return { ...harness, first, second, third, request };
}

const toolsResult = (profile: string) => ({ agentId: "main", profile, groups: [] });
const disabledServer = { mcp: { servers: { docs: { command: "docs-mcp", enabled: false } } } };

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
  const query = (selector: string) => container.querySelector(selector);
  document.body.append(container);
  onTestFinished(() => {
    container.remove();
    sessions.dispose();
  });
  const host = new ChatComposerCapabilityHost();
  mountSolid(
    () => {
      const capabilities = projectOwner(host, (owner) => owner);
      return createComponent(ChatComposerCapabilityDialogs, {
        read: () => capabilities.read().dialogView(context, state, session),
      });
    },
    { container },
  );
  host.props(context, state, session, "main").onAddServer?.();
  return {
    container,
    form: () => query("form"),
    alert: () => query('[role="alert"]')?.textContent,
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
      await waitForSolid(() => expect(query("form")).not.toBeNull());
      const form = query("form");
      container
        .querySelector<HTMLInputElement>(`input.settings-segmented__input[value="${scope}"]`)!
        .click();
      expect(query("form")).toBe(form);
      container.querySelector<HTMLInputElement>('[name="mcp-name"]')!.value = "docs";
      container.querySelector<HTMLSelectElement>('[name="mcp-transport"]')!.value =
        server.transport;
      container.querySelector<HTMLInputElement>('[name="mcp-target"]')!.value = server.target;
      query("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForSolid(() => expect(host.dialogView(context, state, session).busy).toBe(false));
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
    expect(harness.form()).toBeNull();
  });

  it("adds a session server disabled globally before enabling its sparse override", async () => {
    const harness = createAddServerHarness();
    await harness.submit();

    expect(harness.globalWrites).toEqual([disabledServer]);
    expect(harness.patch).toHaveBeenCalledWith(
      "main",
      { toolOverrides: { mcpServers: { docs: true }, skills: { release: false } } },
      expect.any(Object),
    );
    expect(harness.events).toEqual(["global", "load", "session"]);
    expect(harness.form()).toBeNull();
  });

  it("does not patch the session when the global add fails", async () => {
    const harness = createAddServerHarness({ globalError: "duplicate" });
    await harness.submit();

    expect(harness.alert()?.trim()).toBe("duplicate");
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("classifies a thrown global write as a config-stage failure", async () => {
    const harness = createAddServerHarness({ throwGlobal: true });
    await harness.submit("everywhere");

    expect(harness.alert()?.trim()).toBe("config failed");
    expect(harness.events).toEqual(["global"]);
  });

  it("reports a session-stage failure after retaining the global add", async () => {
    const harness = createAddServerHarness({ sessionError: "gateway disconnected" });
    await harness.submit();

    expect(harness.globalWrites).toEqual([disabledServer]);
    expect(harness.alert()).toContain(
      "The server was saved disabled globally, but enabling it for this session failed: gateway disconnected",
    );
    expect(harness.events).toEqual(["global", "load", "session", "load"]);
  });

  it("aborts the session stage when navigation changes the submitted identity", async () => {
    const harness = createAddServerHarness({ navigateAfterSave: true });
    await harness.submit();

    expect(harness.alert()).toContain("The active session changed before it could be enabled.");
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("returns a session-stage error when refreshing current overrides rejects", async () => {
    const harness = createAddServerHarness({ refreshError: "refresh failed" });
    await harness.submit();

    expect(harness.alert()).toContain(
      "The server was saved disabled globally, but enabling it for this session failed: refresh failed",
    );
    expect(harness.events).toEqual(["global", "load"]);
    expect(harness.patch).not.toHaveBeenCalled();
    const form = harness.container.querySelector("form")!;
    const failure = harness.container.querySelector('[role="alert"]')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(form.contains(failure)).toBe(true);
    expect(submit.form).toBe(form);
    expect(form.lastElementChild?.contains(submit)).toBe(true);
    expect(failure.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("blocks tool override patches without exact sessions.patch access", async () => {
    const request = vi.fn();
    const { context, props } = capabilityHarness(request, { runtimeConfig: {} });
    context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const blocked = props();
    expect(blocked.mutationBlockedReason).toBeTruthy();
    blocked.onPatchToolOverrides?.({ skills: { release: true } });
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Everywhere selectable while a missing session row blocks session submit", async () => {
    const host = new ChatComposerCapabilityHost();
    const context = createContext({ runtimeConfig: {} });
    const state = createState();
    host.props(context, state, undefined, "main").onAddServer?.();
    const container = document.createElement("div");
    mountSolid(
      () =>
        createComponent(ChatComposerCapabilityDialogs, {
          read: () => host.dialogView(context, state, undefined),
        }),
      { container },
    );
    await Promise.resolve();

    const scope = container.querySelector<HTMLInputElement>(
      'input.settings-segmented__input[value="everywhere"]',
    );
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(scope?.disabled).toBe(false);
    expect(submit?.disabled).toBe(true);
  });

  it("derives capability defaults from the active runtime snapshot", () => {
    const { props } = capabilityHarness(vi.fn(), {
      sourceConfig: {
        mcp: { servers: { source: { command: "source-mcp", enabled: true } } },
        tools: { web: { search: { enabled: false } } },
      },
      runtimeConfig: {
        mcp: { servers: { runtime: { command: "runtime-mcp", enabled: false } } },
        tools: { web: { search: { enabled: true } } },
      },
    });

    expect(props().mcpServers.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: "runtime", enabled: false },
    ]);
    expect(props().webSearchBaseEnabled).toBe(true);
  });

  it("refetches effective tools when an active connector definition changes", async () => {
    const firstResult = toolsResult("full");
    const secondResult = toolsResult("minimal");
    const request = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const { context, props } = capabilityHarness(request, {
      appliedConfigHash: "config-1",
      runtimeConfig: {
        mcp: { servers: { github: { url: "https://mcp.example.test", enabled: true } } },
      },
    });
    context.gateway.snapshot.hello = {
      features: { methods: ["tools.effective"] },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    props().onOpenToolAccess?.("github");
    await vi.waitFor(() => expect(props().toolsEffectiveResult).toBe(firstResult));

    context.runtimeConfig.state.configSnapshot = {
      appliedConfigHash: "config-2",
      runtimeConfig: {
        mcp: { servers: { github: { url: "https://new-mcp.example.test", enabled: true } } },
      },
    };
    expect(props().toolsEffectiveLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    props().onLoadView?.("tools:github");
    expect(props().toolsEffectiveLoading).toBe(true);

    await vi.waitFor(() => expect(props().toolsEffectiveResult).toBe(secondResult));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest tools after connector configuration changes away and back", async () => {
    const { first, second, third, request, props } = replacedToolsHarness();
    expect(request).toHaveBeenCalledTimes(3);

    third.resolve(toolsResult("newest-a"));
    await vi.waitFor(() => expect(props().toolsEffectiveResult?.profile).toBe("newest-a"));
    first.resolve(toolsResult("stale-a"));
    await first.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(props().toolsEffectiveResult?.profile).toBe("newest-a");
    second.resolve(toolsResult("stale-b"));
  });

  it("keeps a replacement tools request loading when its same-key predecessor finishes", async () => {
    const { first, second, third, request, props } = replacedToolsHarness();
    first.resolve(toolsResult("stale-a"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    await Promise.resolve();

    expect(props().toolsEffectiveResult).toBeNull();
    expect(props().toolsEffectiveLoading).toBe(true);

    third.resolve(toolsResult("newest-a"));
    await vi.waitFor(() => expect(props().toolsEffectiveResult?.profile).toBe("newest-a"));
    second.resolve(toolsResult("stale-b"));
  });

  it("retires effective tools and requests across a same-client reconnect", async () => {
    const first = deferred<unknown>();
    const current = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(current.promise);
    const { state, props } = toolsHarness(request);
    state.connectionEpoch = 1;

    props().onOpenToolAccess?.("github");
    state.connectionEpoch = 2;
    const reconnected = props();
    expect(reconnected.toolsEffectiveResult).toBeNull();
    expect(reconnected.toolsEffectiveLoading).toBe(false);
    reconnected.onOpenToolAccess?.("github");
    expect(request).toHaveBeenCalledTimes(2);

    first.resolve(toolsResult("retired-connection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(props().toolsEffectiveResult).toBeNull();
    expect(props().toolsEffectiveLoading).toBe(true);

    current.resolve(toolsResult("current-connection"));
    await vi.waitFor(() =>
      expect(props().toolsEffectiveResult?.profile).toBe("current-connection"),
    );
  });

  it("retires cached skills and their requests across a same-client reconnect", async () => {
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
    const { state, props } = capabilityHarness(request, { runtimeConfig: {} });
    state.connectionEpoch = 1;
    const skill = (name: string) => ({
      name,
      skillKey: name,
      disabled: false,
      blockedByAllowlist: false,
      missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    });

    props().onLoadSkills?.();
    state.connectionEpoch = 2;
    const reconnected = props();
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
    expect(props().skills).toBeNull();
    expect(props().skillsLoading).toBe(true);

    current.resolve({ skills: [skill("current")] });
    await vi.waitFor(() => expect(props().skills?.map(({ name }) => name)).toEqual(["current"]));
  });

  it("shows effective-tools request failures and allows an explicit retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("tools unavailable"))
      .mockResolvedValue(toolsResult("full"));
    const { props } = toolsHarness(request, { runtimeConfig: {} });

    props().onOpenToolAccess?.("github");
    await vi.waitFor(() => expect(props().toolsEffectiveError).toBe(true));

    expect(props().toolAccessMutationBlockedReason).toBe("Couldn’t load tools.");

    props().onOpenToolAccess?.("github");
    await vi.waitFor(() => expect(props().toolsEffectiveResult).not.toBeNull());
    expect(request.mock.calls).toEqual([
      ["tools.effective", { agentId: "main", sessionKey: "main" }],
      ["tools.effective", { agentId: "main", sessionKey: "main" }],
    ]);
  });
});
