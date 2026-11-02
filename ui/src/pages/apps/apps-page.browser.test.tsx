import { beforeEach, expect, it } from "vitest";
import type { McpAppDiscoverResult } from "../../../../src/shared/mcp-app-extensions.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
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
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AppsPage } from "./apps-page.tsx";
import "../../styles.css";

const catalog: McpAppDiscoverResult = {
  servers: Array.from({ length: 100 }, (_, index) => ({
    serverName: `catalog-app-${index}`,
    label: `Catalog application ${index}`,
    entrypoints: [
      {
        title: `Application ${index}`,
        toolName: `application_${index}`,
        resourceUri: `ui://catalog/${index}`,
        entrypoint: { type: "global" },
      },
    ],
  })),
};

async function frames() {
  flush();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

it.each([
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
])(
  "keeps platform content in place while the $name app catalog loads and scrolls",
  async (size) => {
    const { page } = await import("vitest/browser");
    const initialViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(size.width, size.height);
    const discovery = createDeferred<McpAppDiscoverResult>();
    const requested = createDeferred();
    const { gateway, publish } = createApplicationGateway();
    const request = createGatewayRequestMock((method) => {
      if (method !== "mcp.app.discover") {
        throw new Error(`Unexpected method: ${method}`);
      }
      requested.resolve();
      return discovery.promise;
    });
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      sessionKey: "agent:main:catalog",
      hello: gatewayHelloForMethods(["mcp.app.discover"]),
    });
    // Only discovery and the global catalog's existing-session check are exercised.
    const context = {
      gateway,
      navigate: () => undefined,
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      sessions: { describe: async () => ({ session: { key: "agent:main:catalog" } }) },
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
      await requested.promise;
      await waitForSolid(() =>
        expect(
          mounted.container.querySelector("openclaw-mcp-app-catalog [role=status]")?.textContent,
        ).toContain("Loading"),
      );
      await frames();
      const platform = mounted.container.querySelector<HTMLElement>(".apps-page")!;
      const catalogHost = mounted.container.querySelector<HTMLElement>("openclaw-mcp-app-catalog")!;
      const platformTop = () =>
        platform.getBoundingClientRect().top - catalogHost.getBoundingClientRect().top;
      const before = platformTop();
      expect(platform.getBoundingClientRect().height).toBeGreaterThan(0);

      discovery.resolve(catalog);
      await waitForSolid(() =>
        expect(mounted.container.querySelectorAll(".mcp-app-catalog__entry")).toHaveLength(100),
      );
      await frames();
      expect(Math.abs(platformTop() - before)).toBeLessThanOrEqual(1);

      const entries = mounted.container.querySelector<HTMLElement>(".mcp-app-catalog__entries")!;
      expect(entries.clientHeight).toBeGreaterThan(0);
      expect(entries.clientHeight).toBeLessThan(window.innerHeight);
      expect(entries.scrollHeight).toBeGreaterThan(entries.clientHeight);
      entries.scrollTop = entries.scrollHeight;
      await frames();
      expect(entries.scrollTop).toBeGreaterThan(0);
      const finalEntry = mounted.getByRole("button", { name: /^Application 99\b/ });
      const last = finalEntry.getBoundingClientRect();
      const viewport = entries.getBoundingClientRect();
      expect(last.top).toBeGreaterThanOrEqual(viewport.top - 1);
      expect(last.bottom).toBeLessThanOrEqual(viewport.bottom + 1);
      expect(Math.abs(platformTop() - before)).toBeLessThanOrEqual(1);

      publish({ ...gateway.snapshot, hello: gatewayHelloForMethods([]) });
      await waitForSolid(() =>
        expect(mounted.container.querySelector("openclaw-mcp-app-catalog")?.childElementCount).toBe(
          0,
        ),
      );
      await frames();
      const unavailable = mounted.container.querySelector<HTMLElement>("openclaw-mcp-app-catalog")!;
      expect(unavailable.getBoundingClientRect().height).toBe(0);
    } finally {
      mounted.unmount();
      discovery.resolve({ servers: [] });
      window.scrollTo(0, 0);
      await page.viewport(initialViewport.width, initialViewport.height);
    }
  },
);
