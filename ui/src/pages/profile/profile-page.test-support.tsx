import { vi } from "vitest";
import type {
  UserProfile,
  UsersSelfResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { ProfilePage } from "./profile-page.tsx";

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
      connect: vi.fn(),
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
      subscribeEvents: subscribe,
      async loadSelfProfile() {
        if (!snapshot.selfUser || !snapshot.client || snapshot.phase !== "connected") {
          return null;
        }
        const result = await snapshot.client.request<UsersSelfResult>("users.self", {});
        return result.profile;
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
  } as unknown as Omit<ApplicationContext, "settingsAgentSelection">;
  const context: ApplicationContext = {
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
    emitHello(hello: ApplicationGatewaySnapshot["hello"]) {
      snapshot = { ...snapshot, hello };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    emitConnected(connected: boolean) {
      snapshot = { ...snapshot, phase: connected ? "connected" : "reconnecting" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

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
export type ProfilePageElement = HTMLElement & { unmount(): void };

export function mountProfilePage(context: ApplicationContext): ProfilePageElement {
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <ProfilePage />, { wrapper: provider.wrapper });
  return Object.assign(view.container, { unmount: view.unmount });
}
