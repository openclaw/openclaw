import { createRouter, definePage } from "@openclaw/uirouter";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { flush } from "../../test-helpers/solid-settle.ts";

export async function choosePairingFilter(page: HTMLElement, index: number, value: string) {
  const settle = async () => {
    flush();
    await Promise.resolve();
    flush();
  };
  const picker = page.querySelectorAll<HTMLElement>(
    ".channels-pairing-filters openclaw-select-picker",
  )[index]!;
  picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!.click();
  await settle();
  const option = Array.from(picker.querySelectorAll<HTMLElement>("[role=option]")).find(
    (entry) => entry.dataset.value === value,
  );
  expect(option).toBeDefined();
  option!.click();
  await settle();
}

export const channelSnapshot = (
  overrides: Partial<ChannelsStatusSnapshot> = {},
): ChannelsStatusSnapshot => ({
  ts: 0,
  channelOrder: [],
  channelLabels: {},
  channels: {},
  channelAccounts: {},
  channelDefaultAccountId: {},
  ...overrides,
});

export function channelStatus(id: string, label: string, configured = false, description?: string) {
  return channelSnapshot({
    channelOrder: [id],
    channelLabels: { [id]: label },
    channels: { [id]: { configured } },
    ...(description ? { channelDetailLabels: { [id]: description } } : {}),
  });
}

export const plugin = (id: string, name: string, overrides: Partial<PluginCatalogItem> = {}) => ({
  id,
  name,
  installed: true,
  enabled: true,
  state: "enabled",
  hasIcon: true,
  ...overrides,
});

export function mockIcon(url: string) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  return fetchMock;
}

export function iconRequests(fetchMock: ReturnType<typeof mockIcon>) {
  return fetchMock.mock.calls
    .map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    .filter((url) => url.includes("/__openclaw__/plugin-icon/"));
}

export const sources: Array<Pick<ApplicationContext, "runtimeConfig" | "channels">> = [];

export function catalogFixture(plugins: object[], initial = channelSnapshot(), scopes?: string[]) {
  let refreshed: ReturnType<typeof channelSnapshot> | undefined;
  const gateway = createGateway(scopes, {
    "plugins.list": () => ({ plugins, diagnostics: [], mutationAllowed: true }),
    "channels.status": () => refreshed ?? channelSnapshot(),
  });
  const source = createContext(gateway);
  source.channels.state.channelsSnapshot = initial;
  const request = vi.spyOn(gateway.snapshot.client!, "request");
  return {
    gateway,
    source,
    request,
    refresh: async (snapshot: typeof initial) => {
      refreshed = snapshot;
      await source.channels.refresh(false);
    },
  };
}

type TestGateway = ApplicationContext["gateway"] & {
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

export function createGateway(
  scopes?: string[],
  responses: Record<string, () => unknown> = {},
): TestGateway {
  const client = {
    request: vi.fn(async (method: string) => {
      if (responses[method]) {
        return responses[method]();
      }
      return method === "channels.pairing.list"
        ? {
            accounts: [],
            requests: [],
            commandOwnerConfigured: true,
            limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
          }
        : method === "channels.status"
          ? channelSnapshot()
          : method === "plugins.list"
            ? { plugins: [], diagnostics: [], mutationAllowed: true }
            : {};
    }),
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

export function setGatewayScopes(gateway: TestGateway, scopes: string[]) {
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
    channels,
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
  if (!button) {
    throw new Error(`Missing action: ${label}`);
  }
  return button;
}
