import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
  createNavigationPreferencesFixture,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../test-helpers/gateway-methods.ts";
type GatewayBrowserClientFixtureOverrides = Omit<Partial<GatewayBrowserClient>, "request"> & {
  request?: GatewayRequestHandler;
};

export function createGatewayBrowserClientFixture(
  overrides: GatewayBrowserClientFixtureOverrides = {},
): GatewayBrowserClient {
  const {
    request = (method) => (method === "sessions.describe" ? { session: null } : {}),
    ...properties
  } = overrides;
  const client = createTestGatewayClient(request);
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(client, key, { configurable: true, writable: true, value });
  }
  return client;
}

type FixtureContextServices =
  | "theme"
  | "agentIdentity"
  | "agents"
  | "sessions"
  | "plugins"
  | "connectionBootstrap"
  | "chatAttachmentHandoff";

function withLiveCapabilities(
  context: Omit<ApplicationContext, FixtureContextServices> & { sessions?: SessionCapability },
): ApplicationContext {
  const chatAttachmentHandoff = createChatAttachmentHandoff(context.gateway);
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const synchronizeBootstrap = (snapshot: ApplicationContext["gateway"]["snapshot"]) =>
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
  synchronizeBootstrap(context.gateway.snapshot);
  const stopBootstrap = context.gateway.subscribe(synchronizeBootstrap);
  const theme = createApplicationTheme(
    loadSettings(context.gateway.connection.gatewayUrl),
    context.gateway,
  );
  const agents = createAgentCapability(context.gateway);
  const sessions =
    context.sessions ??
    createSessionCapability(context.gateway, context.agentSelection, { connectionBootstrap });
  const plugins = new ControlUiPluginRuntime(() => applicationContext);
  onTestFinished(() => {
    plugins.dispose();
    stopBootstrap();
    chatAttachmentHandoff.dispose();
    connectionBootstrap.reset();
    if (!context.sessions) {
      sessions.dispose();
    }
    agents.dispose();
    theme.dispose();
  });
  const applicationContext: ApplicationContext = {
    ...context,
    chatAttachmentHandoff,
    connectionBootstrap,
    navigation: createNavigationPreferencesFixture(),
    theme,
    agents,
    sessions,
    plugins,
    agentIdentity: createAgentIdentityCapability(context.gateway),
  };
  return applicationContext;
}

export function createInitializationContext(client?: GatewayBrowserClient): ApplicationContext {
  return withLiveCapabilities({
    basePath: "",
    gateway: {
      snapshot: createApplicationGatewaySnapshot({
        client: client ?? null,
        phase: client ? "connected" : "stopped",
      }),
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
      connection: {
        gatewayUrl: loadSettings().gatewayUrl,
        token: "",
        bootstrapToken: "",
        password: "",
      },
    },
    config: {
      subscribe: () => () => {},
      current: {
        assistantIdentity: {
          agentId: null,
          name: "Assistant",
          avatar: null,
          avatarStatus: null,
          avatarReason: null,
        },
        serverVersion: null,
        embedSandboxMode: "strict",
        allowExternalEmbedUrls: false,
        terminalEnabled: false,
      },
    },
    agentSelection: {
      state: { selectedId: "main" },
      subscribe: () => () => {},
    },
    runtimeConfig: createRuntimeConfigFixture(),
    placementStartup: {
      get: () => null,
      hasPendingTurn: () => false,
      retry: () => undefined,
      pause: () => undefined,
      subscribe: () => () => {},
    },
    navigate: () => undefined,
    chatSubmissions: createChatSubmissions(),
  } as unknown as Omit<ApplicationContext, FixtureContextServices>);
}

function createRuntimeConfigFixture() {
  return {
    state: { configNeedsApply: false, configSnapshot: null },
    ensureLoaded: async () => undefined,
    ensureDisplayLoaded: async () => undefined,
    subscribe: () => () => {},
  };
}

export function createSessionContext(
  client: GatewayBrowserClient,
  sessions?: SessionCapability,
): ApplicationContext & {
  publishGatewaySnapshot: (snapshot: ApplicationContext["gateway"]["snapshot"]) => void;
} {
  const agentSelectionListeners = new Set<(state: { selectedId: string | null }) => void>();
  const agentSelectionState = { selectedId: "main" as string | null };
  const { gateway, publish, publishEvent } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods([
        ...SESSION_MUTATION_TEST_METHODS,
        "taskSuggestions.list",
        "session.suggestions.list",
      ]),
    }),
  );
  const context = withLiveCapabilities({
    gateway: Object.assign(gateway, {
      connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
      eventLog: [],
      subscribeEventLog: () => () => {},
      connect: vi.fn(),
      setSessionKey: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      emitTestEvent: publishEvent,
    }),
    agentSelection: {
      state: agentSelectionState,
      set: (agentId: string | null) => {
        agentSelectionState.selectedId = agentId;
        for (const listener of agentSelectionListeners) {
          listener(agentSelectionState);
        }
      },
      subscribe: (listener: (state: { selectedId: string | null }) => void) => {
        agentSelectionListeners.add(listener);
        return () => agentSelectionListeners.delete(listener);
      },
    },
    config: {
      subscribe: () => () => {},
      current: {
        assistantIdentity: { name: "Molty" },
        terminalEnabled: false,
      },
    },
    runtimeConfig: createRuntimeConfigFixture(),
    chatSubmissions: createChatSubmissions(),
    nativeChatDrafts: { subscribe: () => () => undefined },
    placementStartup: {
      get: vi.fn(() => null),
      hasPendingTurn: () => false,
      pause: vi.fn(),
      subscribe: () => () => {},
    },
    sessions,
  } as unknown as Omit<ApplicationContext, FixtureContextServices> & {
    sessions?: SessionCapability;
  });
  return Object.assign(context, { publishGatewaySnapshot: publish });
}
