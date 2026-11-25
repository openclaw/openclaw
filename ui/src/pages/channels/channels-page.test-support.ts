import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability, type ChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { emptyPairingSnapshot } from "./pairing.test-support.ts";
import { channelSnapshot as makeSnapshot } from "./view.test-support.ts";

export const channelSnapshot = (
  overrides: Partial<ChannelsStatusSnapshot> = {},
): ChannelsStatusSnapshot => makeSnapshot({}, { ts: 0, ...overrides });

export const sources: Array<{
  runtimeConfig: ApplicationContext["runtimeConfig"];
  channels: ChannelCapability;
}> = [];

type TestGateway = ApplicationContext["gateway"] & {
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

export function createGateway(
  scopes?: string[],
  responses: Record<string, () => unknown> = {},
): TestGateway {
  const defaults: Record<string, () => unknown> = {
    "channels.pairing.list": emptyPairingSnapshot,
    "channels.status": channelSnapshot,
    "plugins.list": () => ({ plugins: [], diagnostics: [], mutationAllowed: true }),
  };
  const client = {
    request: vi.fn(async (method: string) =>
      (responses[method] ?? defaults[method] ?? (() => ({})))(),
    ),
  } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    sessionKey: "main",
  });
  const fixture = createApplicationGateway(snapshot);
  const gateway = Object.assign(fixture.gateway, {
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      fixture.publish(Object.assign(snapshot, patch));
    },
  });
  gateway.connection.gatewayUrl = "";
  if (scopes) {
    setGatewayScopes(gateway, scopes);
  }
  return gateway;
}

function setGatewayScopes(gateway: TestGateway, scopes: string[]) {
  gateway.emit({
    hello: { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"],
  });
}

export function createContext(gateway: ApplicationContext["gateway"]) {
  const channels = createChannelCapability(gateway);
  channels.state.channelsSnapshot = channelSnapshot();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  runtimeConfig.state.configSnapshot = { config: {}, hash: "test" };
  vi.spyOn(runtimeConfig, "ensureSchemaLoaded").mockResolvedValue();
  const router = createRouter({
    routes: [
      definePage({ id: "channels", path: "/channels", component: () => ({}) }),
      definePage({ id: "dashboard", path: "/dashboard", component: () => ({}) }),
    ],
  });
  onTestFinished(() => router.stop());
  const context = {
    basePath: "",
    resourceBasePath: "",
    gateway,
    acquireChannels: () => channels,
    runtimeConfig,
    router,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
  const source = { context, runtimeConfig, channels };
  sources.push(source);
  return source;
}

export function profileButton(page: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(button, `Missing action: ${label}`).toBeDefined();
  return button!;
}
