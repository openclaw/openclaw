import { expect } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { mountConfigPage } from "./config-page.test-support.ts";

export async function mountAppearanceCatalogPage(
  client: GatewayBrowserClient,
  scopes: readonly string[] = ["operator.admin"],
) {
  const source = createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["system.info"], scopes),
  } as ApplicationGatewaySnapshot);
  const subscribe = () => () => undefined;
  const context = {
    gateway: source.gateway,
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
    agentSelection: { state: { selectedId: "main" }, subscribe },
    agents: { state: { agentsList: null }, subscribe },
    agentIdentity: { ensure: async () => undefined, subscribe },
    runtimeConfig: { state: { configSnapshot: {}, configSchema: {} }, subscribe },
    theme: { branding: resolveThemeBranding(undefined), subscribe },
    overlays: { snapshot: {}, subscribe },
    config: { current: { assistantIdentity: { name: "OpenClaw" } }, subscribe },
    webPush: { subscribe },
  } as unknown as ApplicationContext;
  const view = mountConfigPage(context, { pageId: "appearance" });
  await waitForSolid(() =>
    expect(
      view.page.querySelector("#settings-appearance-sidebar openclaw-select-picker"),
    ).not.toBeNull(),
  );
  return { view, source, context };
}
