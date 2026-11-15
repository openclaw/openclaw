import { beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AppsPage } from "./apps-page.tsx";
import "../../styles.css";

beforeEach(async () => {
  await i18n.setLocale("en");
});

it.each([
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
])("shows companion apps without a duplicate plugin catalog on $name", async (size) => {
  const { page } = await import("vitest/browser");
  const initialViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(size.width, size.height);
  const { gateway, publish } = createApplicationGateway();
  const request = createGatewayRequestMock(async () => ({ servers: [] }));
  const describe = vi.fn(async () => ({ session: { key: "agent:main:catalog" } }));
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    sessionKey: "agent:main:catalog",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  // MCP Apps are available, but the companion-app directory does not discover them.
  const context = {
    gateway,
    navigate: () => undefined,
    agentSelection: {
      state: { selectedId: "main" },
      subscribe: () => () => undefined,
    },
    sessions: { describe },
  } as unknown as ApplicationContext;
  const mounted = mountSolid(
    () => (
      <main class="content">
        <AppsPage />
      </main>
    ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  try {
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(mounted.getByRole("heading", { name: "Take OpenClaw everywhere" })).toBeVisible(),
    );
    expect(mounted.queryByRole("heading", { name: "Plugin apps" })).toBeNull();
    expect(mounted.queryByRole("button", { name: "Configure MCP servers" })).toBeNull();
    expect(mounted.getByRole("heading", { name: "iPhone" })).toBeVisible();
    expect(describe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
    window.scrollTo(0, 0);
    await page.viewport(initialViewport.width, initialViewport.height);
  }
});
