import { vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ProfilePage } from "./profile-page.ts";

export function createConnectedContext(
  request: GatewayBrowserClient["request"],
  selfUser: AuthenticatedUser | null = null,
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const subscribe = () => () => undefined;
  const baseContext = {
    runtimeConfig: { subscribe, state: {}, ensureLoaded: async () => undefined },
    gateway: {
      get snapshot() {
        return snapshot;
      },
      connection: {
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        token: "",
        bootstrapToken: "",
        password: "",
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      updateSelfUser(patch: Partial<Omit<AuthenticatedUser, "id">>) {
        if (!snapshot.selfUser) {
          return;
        }
        snapshot = { ...snapshot, selfUser: { ...snapshot.selfUser, ...patch } };
        for (const listener of listeners) {
          listener(snapshot);
        }
      },
    },
    agents: {
      state: { agentsList: null },
      ensureList: async () => null,
      subscribe,
    },
    agentIdentity: {
      get: () => null,
      ensure: async () => undefined,
      subscribe,
    },
    config: {
      current: {
        assistantIdentity: {
          name: "OpenClaw",
          avatar: null,
          avatarSource: null,
          avatarStatus: null,
          avatarReason: null,
        },
      },
      subscribe,
    },
    basePath: "",
    navigate: vi.fn(),
  } as unknown as Omit<ApplicationContext<RouteId>, "settingsAgentSelection">;
  const context: ApplicationContext<RouteId> = {
    ...baseContext,
    settingsAgentSelection: createAgentSelectionCapability(
      baseContext.gateway,
      baseContext.agents,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    ),
  };
  return {
    context,
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, phase: connected ? "connected" : "reconnecting" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

const PROFILE_PAGE_TEST_TAG = "test-openclaw-profile-page";
export const modelAccountProfile: UserProfile = {
  id: "profile-1",
  displayName: "Ada",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["ada@example.test"],
  githubIdentity: null,
  hasAvatar: false,
};
// Keep the element class on the same post-reset i18n module as this test.
if (!customElements.get(PROFILE_PAGE_TEST_TAG)) {
  customElements.define(PROFILE_PAGE_TEST_TAG, class extends ProfilePage {});
}

export type ProfilePageElement = HTMLElement & {
  updateComplete: Promise<boolean>;
};

export function mountProfilePage(context: ApplicationContext<RouteId>) {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement(PROFILE_PAGE_TEST_TAG) as ProfilePageElement;
  provider.append(page);
  document.body.append(provider);
  return page;
}
