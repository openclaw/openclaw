import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createConfigCapabilityHarness } from "../lib/config/config-test-harness.ts";
import { createShellConfigFixture } from "./app-host.test-support.ts";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";

export function createProfileAppearanceGateway(profileId: string | null) {
  const pendingResponses: Array<ReturnType<typeof createDeferred<ProfileAppearanceReply>>> = [];
  let requestStarted = createDeferred();
  const request = vi.fn(() => {
    const reply = createDeferred<ProfileAppearanceReply>();
    pendingResponses.push(reply);
    requestStarted.resolve();
    return reply.promise;
  });
  const client = { gatewayUrl: "ws://profile.test", request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    sessionKey: "",
    selfUser: profileId ? { id: profileId } : null,
    hello: { auth: { role: "operator", scopes: ["operator.write"] } },
  } as ApplicationGatewaySnapshot;
  const refreshTheme = vi.fn();
  const invalidate = vi.fn();
  const context = {
    config: createShellConfigFixture(),
    gateway: {
      connection: { gatewayUrl: "ws://profile.test" },
      snapshot,
    },
    connectionBootstrap: { run: (_key: string, task: () => Promise<unknown>) => task() },
    runtimeConfig: {
      canPatch: false,
      ensureDisplayLoaded: vi.fn(async () => undefined),
      refreshDisplay: vi.fn(async () => undefined),
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
    lastLocalePrefSignature: null,
    outboxStoreImport: { load: vi.fn(async () => undefined) },
    shellNavigation: { recoverDeletedActiveSession: vi.fn() },
    invalidate,
    routeState: {},
  } as unknown as ShellGatewayHost;
  const owner = new ShellGatewayOwner(host);
  onTestFinished(() => owner.reset());
  return {
    async completeProfileAppearance(this: void, accent = "#336699") {
      // The first request follows a lazy import; synchronize on its arrival, not loader speed.
      await requestStarted.promise;
      const respond = pendingResponses.shift();
      requestStarted = createDeferred();
      // Arm after synchronous config reconciliation, which may also refresh the theme.
      const refreshed = createDeferred();
      refreshTheme.mockImplementationOnce(refreshed.resolve);
      respond!.resolve(profileAppearanceReply(accent));
      return refreshed.promise;
    },
    context,
    host,
    owner,
    refreshTheme,
    invalidate,
    request,
    snapshot,
  };
}

export function createShellConfig(request: Parameters<typeof createConfigCapabilityHarness>[0]) {
  const harness = createConfigCapabilityHarness(request);
  const { context, owner } = createProfileAppearanceGateway(null);
  Object.assign(context, { runtimeConfig: harness.runtimeConfig });
  return { ...harness, context, owner };
}

export function holdProfileAppearanceRead(
  request: ReturnType<typeof createProfileAppearanceGateway>["request"],
) {
  const readStarted = createDeferred();
  const reply = createDeferred<ProfileAppearanceReply>();
  request.mockImplementationOnce(() => {
    readStarted.resolve();
    return reply.promise;
  });
  return { readStarted, reply };
}

type ProfileAppearanceReply = ReturnType<typeof profileAppearanceReply>;

export function profileAppearanceReply(accent: string) {
  return { status: "ok", entries: { "ui.accent": accent, "ui.railShortcuts": [] } };
}
