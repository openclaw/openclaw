import { afterEach, describe, expect, it, vi } from "vitest";
import { publishChatWorkContext } from "../../pages/chat/chat-work-context.ts";
import { notifyPluginHelp, pluginHelpState } from "../../pages/custodian/plugin-help-state.ts";
import { acquirePaletteIdentityPreferences } from "../../pages/new-session/palette-identity-preferences.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { beginChatMetadataPublication } from "../chat/chat-metadata-store.ts";
import { publishMcpAppContext } from "../mcp-app-context.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../model-catalog-cache.ts";
import {
  projectChatMetadata,
  projectChatWorkContext,
  projectMcpAppContexts,
  projectModelCatalog,
  projectPaletteIdentityPreferences,
  projectPluginHelp,
  type ChatWorkContextSource,
} from "./registries.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function client() {
  return createTestGatewayClient(createGatewayRequestMock());
}

function observable() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish() {
      for (const listener of listeners) {
        listener();
      }
    },
    listeners,
  };
}

describe("registry projections", () => {
  it("reads catalog admission, changes scope, and stops observing a retired source", () => {
    const first = client();
    const second = client();
    const scope = { agentId: "main" };
    const publish = (target: typeof first, id: string) =>
      publishModelCatalogResult(beginModelCatalogRead(target, scope), scope, {
        models: [{ id, name: id, provider: "example" }],
      });
    publish(first, "initial");
    const projection = projectModelCatalog({ client: first, scope });
    cleanups.push(projection.dispose);
    expect(projection.read().models.map((model) => model.id)).toEqual(["initial"]);
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    publish(first, "updated");
    expect(projection.read().models.map((model) => model.id)).toEqual(["updated"]);
    projection.replaceSource({ client: second, scope });
    expect(projection.read().hasSnapshot).toBe(false);
    changed.mockClear();
    publish(first, "retired");
    expect(changed).not.toHaveBeenCalled();
    publish(second, "replacement");
    expect(projection.read().models.map((model) => model.id)).toEqual(["replacement"]);
    release();
    changed.mockClear();
    publish(second, "detached");
    expect(changed).not.toHaveBeenCalled();
    expect(projection.read().models.map((model) => model.id)).toEqual(["detached"]);
    projection.dispose();
    publish(second, "disposed");
    expect(projection.read().models.map((model) => model.id)).toEqual(["detached"]);
  });

  it("observes scoped metadata publications without starting a metadata request", () => {
    const first = client();
    const second = client();
    const scope = { agentId: "main", sessionKey: "agent:main:one" };
    const projection = projectChatMetadata({ client: first, scope });
    cleanups.push(projection.dispose);
    expect(projection.read()).toBeUndefined();
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    beginChatMetadataPublication(first, scope).publish({ commands: [], revision: "first" });
    expect(projection.read()?.revision).toBe("first");
    projection.replaceSource({ client: second, scope });
    changed.mockClear();
    beginChatMetadataPublication(first, scope).publish({ commands: [], revision: "old" });
    expect(changed).not.toHaveBeenCalled();
    beginChatMetadataPublication(second, scope).publish({ commands: [], revision: "second" });
    expect(projection.read()?.revision).toBe("second");
    release();
    projection.dispose();
    changed.mockClear();
    beginChatMetadataPublication(second, scope).publish({ commands: [], revision: "late" });
    expect(changed).not.toHaveBeenCalled();
    expect(projection.read()?.revision).toBe("second");
  });

  it("preserves MCP conversation and connection boundaries, including same-object updates", () => {
    const first = client();
    const second = client();
    const entry = {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view",
      title: "Initial",
      state: { updateId: "1", content: [] },
    };
    publishMcpAppContext(first, entry);
    const projection = projectMcpAppContexts({
      client: first,
      sessionKey: entry.sessionKey,
      agentId: "main",
    });
    cleanups.push(projection.dispose);
    expect(projection.read().map((item) => item.title)).toEqual(["Initial"]);
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    entry.title = "Updated";
    publishMcpAppContext(first, entry);
    expect(changed).toHaveBeenCalledOnce();
    expect(projection.read()[0]?.title).toBe("Updated");
    projection.replaceSource({ client: second, sessionKey: entry.sessionKey, agentId: "main" });
    expect(projection.read()).toEqual([]);
    changed.mockClear();
    publishMcpAppContext(first, entry);
    expect(changed).not.toHaveBeenCalled();
    publishMcpAppContext(second, { ...entry, title: "Second" });
    expect(projection.read()[0]?.title).toBe("Second");
    release();
    projection.dispose();
    changed.mockClear();
    publishMcpAppContext(second, { ...entry, title: "Late" });
    expect(changed).not.toHaveBeenCalled();
    expect(projection.read()[0]?.title).toBe("Second");
  });

  it("recomputes work context from pane and capability publications and releases all sources", () => {
    const gateway = observable();
    const agents = observable();
    const sessions = observable();
    // The adapter reads only these capability fields and subscriptions.
    const context = {
      gateway: { ...gateway, snapshot: { hello: null } },
      agents: { ...agents, state: { agentsList: null } },
      sessions: { ...sessions, state: { result: null } },
    } as unknown as ChatWorkContextSource["context"];
    const projection = projectChatWorkContext({
      context,
      page: "chat",
      sessionKey: "agent:main:one",
      agentId: "main",
    });
    cleanups.push(projection.dispose);
    expect(projection.read().file).toBeUndefined();
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    const releaseSecond = projection.subscribe(() => {});
    expect(gateway.listeners.size).toBe(1);
    publishChatWorkContext(
      context,
      {},
      { sessionKey: "agent:main:one", agentId: "main", file: "first.ts" },
    );
    expect(projection.read().file).toBe("first.ts");
    gateway.publish();
    agents.publish();
    sessions.publish();
    expect(changed).toHaveBeenCalledTimes(4);
    release();
    expect(gateway.listeners.size).toBe(1);
    projection.replaceSource({ context, page: "settings", sessionKey: "", agentId: "main" });
    expect(projection.read()).toEqual({ page: "settings" });
    releaseSecond();
    expect([gateway, agents, sessions].map((owner) => owner.listeners.size)).toEqual([0, 0, 0]);
    projection.dispose();
  });

  it("publishes mutable plugin help state and detaches its context listener", () => {
    const gateway = observable();
    const router = observable();
    // Help ownership needs only connection identity and the current pathname.
    const context = {
      gateway: {
        ...gateway,
        snapshot: { hello: null },
        connection: { gatewayUrl: "ws://example.invalid" },
      },
      router: { ...router, getState: () => ({ location: { pathname: "/plugins" } }) },
    } as unknown as Parameters<typeof projectPluginHelp>[0];
    const projection = projectPluginHelp(context);
    cleanups.push(projection.dispose);
    const state = pluginHelpState(context);
    expect(projection.read().pendingDraft).toBe("");
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    state.pendingDraft = "Help with this plugin";
    notifyPluginHelp(state);
    expect(projection.read().pendingDraft).toBe("Help with this plugin");
    expect(changed).toHaveBeenCalledOnce();
    expect(state.listeners.size).toBe(1);
    const replacement = { ...context };
    projection.replaceSource(replacement);
    expect(state.listeners.size).toBe(0);
    expect(projection.read().pendingDraft).toBe("");
    changed.mockClear();
    notifyPluginHelp(state);
    expect(changed).not.toHaveBeenCalled();
    const nextState = pluginHelpState(replacement);
    nextState.pendingDraft = "Replacement context";
    notifyPluginHelp(nextState);
    expect(projection.read().pendingDraft).toBe("Replacement context");
    release();
    expect(nextState.listeners.size).toBe(0);
    projection.dispose();
    changed.mockClear();
    notifyPluginHelp(state);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps palette currentness at the owner and publishes its confirmed writes", async () => {
    const request = createGatewayRequestMock(async (method) =>
      method === "users.prefs.get" ? { status: "ok", entries: {} } : { status: "ok" },
    );
    const owner = {
      client: createTestGatewayClient(request),
      hello: {},
      gatewayUrl: "ws://example.invalid",
      profileId: "alice",
    };
    let current = true;
    const projection = projectPaletteIdentityPreferences({ owner, isCurrent: () => current });
    cleanups.push(projection.dispose);
    expect(projection.read()).toEqual({ mode: "loading", palettePreference: null });
    expect(request).not.toHaveBeenCalled();
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = projection.subscribe(() => {
        if (projection.read().mode === "remote") {
          resolve();
        }
      });
      cleanups.push(release);
    });
    await loaded;
    const preferences = acquirePaletteIdentityPreferences(owner);
    const unobserved = projectPaletteIdentityPreferences({ owner, isCurrent: () => true });
    cleanups.push(unobserved.dispose);
    expect(unobserved.read().mode).toBe("remote");
    const preference = { agentId: "main", selection: {} };
    expect(await preferences.setPalettePreference(preference, () => current)).toBe(true);
    expect(projection.read().palettePreference).toEqual(preference);
    expect(unobserved.read().palettePreference).toEqual(preference);
    current = false;
    expect(await preferences.setPalettePreference(null, () => current)).toBe(false);
    expect(projection.read().palettePreference).toEqual(preference);
    release();
    expect(unobserved.read()).toEqual({ mode: "loading", palettePreference: null });
    current = true;
    const reloaded = new Promise<void>((resolve) => {
      cleanups.push(
        projection.subscribe(() => {
          if (projection.read().mode === "remote") {
            resolve();
          }
        }),
      );
    });
    await reloaded;
    expect(acquirePaletteIdentityPreferences(owner)).not.toBe(preferences);
    const replacement = { ...owner, hello: {} };
    const replaced = new Promise<void>((resolve) => {
      cleanups.push(
        projection.subscribe(() => {
          if (projection.read().mode === "remote") {
            resolve();
          }
        }),
      );
      projection.replaceSource({ owner: replacement, isCurrent: () => true });
    });
    await replaced;
    expect(projection.read().mode).toBe("remote");
    projection.dispose();
  });
});
