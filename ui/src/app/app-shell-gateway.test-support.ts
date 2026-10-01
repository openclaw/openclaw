import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createChatPageSessions } from "../pages/chat/chat-page.test-support.ts";
import { createShellConfigFixture } from "./app-host.test-support.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";

export function createProfileAppearanceGateway(profileId: string | null) {
  const pendingResponses: Array<(accent: string) => void> = [];
  let requestStarted = createDeferred();
  const request = vi.fn(
    () =>
      new Promise<{ status: string; entries: { "ui.accent": string } }>((resolve) => {
        pendingResponses.push((accent) =>
          resolve({ status: "ok", entries: { "ui.accent": accent } }),
        );
        requestStarted.resolve();
      }),
  );
  const client = {
    gatewayUrl: "ws://profile.test",
    request,
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    sessionKey: "",
    selfUser: profileId ? { id: profileId } : null,
    hello: { auth: { role: "operator", scopes: ["operator.write"] } },
  } as ApplicationGatewaySnapshot;
  const refreshTheme = vi.fn();
  const connectionBootstrap = {
    reset: vi.fn(),
    run: (_key: string, task: () => Promise<unknown>) => task(),
    synchronize: vi.fn(),
  };
  const context = {
    config: createShellConfigFixture(),
    gateway: {
      connection: { gatewayUrl: "ws://profile.test" },
      snapshot,
    },
    connectionBootstrap,
    sessions: createChatPageSessions(),
    runtimeConfig: {
      canPatch: false,
      ensureLoaded: vi.fn(async () => undefined),
      runExternalMutation: vi.fn(),
      state: {
        client,
        connected: true,
        configSnapshot: { config: { ui: { prefs: { accent: "#ff0000" } } } },
      },
    },
    theme: { refresh: refreshTheme, recordServerSelection: vi.fn() },
  } as unknown as ApplicationContext;
  const host = {
    context,
    activeSessionKey: "",
    agentRosterRefreshTimer: null,
    agentsListClient: null,
    agentsListSource: null,
    lastLocalePrefSignature: null,
    outboxStoreImport: { load: vi.fn(async () => undefined) },
    previousGatewayPhase: null,
    recoverDeletedActiveSession: vi.fn(),
    routeState: {},
    runtimeConfigClient: null,
    runtimeConfigSource: null,
    sessionKeyClient: null,
  } as unknown as ShellGatewayHost;
  return {
    async completeProfileAppearance(this: void, accent = "#336699") {
      // The first request follows a lazy import; synchronize on its arrival, not loader speed.
      await requestStarted.promise;
      expect(pendingResponses).toHaveLength(1);
      const respond = pendingResponses.shift();
      requestStarted = createDeferred();
      expect(respond, "pending users.prefs.get response").toBeDefined();
      // Config reconciliation can also refresh the theme. Arm this only when
      // releasing this request, after any synchronous reconciliation has finished.
      const refreshed = new Promise<void>((resolve) => {
        refreshTheme.mockImplementationOnce(resolve);
      });
      respond!(accent);
      return refreshed;
    },
    context,
    host,
    owner: new ShellGatewayOwner(host),
    refreshTheme,
    request,
    snapshot,
  };
}
