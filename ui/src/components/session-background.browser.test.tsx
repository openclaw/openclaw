import { expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationTheme } from "../app/context.ts";
import { loadSettings } from "../app/settings.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SessionBackground } from "./session-background.tsx";

// mock-isolation: Keep the process-wide profile preference cache outside the palette fixture.
vi.mock("../app/server-prefs-profile.ts", () => ({ resolveProfileAppearancePrefs: () => ({}) }));

// Keep image transport synthetic while sampling real inherited CSS and canvas contrast.
vi.mock("./session-background-image.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-background-image.ts")>()),
  readBackgroundImage: async () =>
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
}));

it("samples the inherited palette when a Solid-mounted photo first joins the document", async () => {
  const gateway = createApplicationGateway({
    client: {} as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-a" },
  });
  gateway.gateway.connection.gatewayUrl = `${location.origin.replace(/^http/u, "ws")}/ws`;
  const theme: ApplicationTheme = {
    settings: {
      ...loadSettings(),
      background: selectBackgroundSource({ kind: "custom", assetId: "asset-a" }),
    },
    branding: resolveThemeBranding(undefined),
    mode: "dark",
    resolvedMode: "dark",
    serverSelection: null,
    appliedPalette: null,
    recordServerSelection: () => undefined,
    setMode: () => undefined,
    refresh: () => undefined,
    subscribe: () => () => undefined,
  };
  const context = { resourceBasePath: "", gateway: gateway.gateway, theme } as ApplicationContext;
  const view = mountSolid(() => (
    <div
      style={{
        "--bg-content": "rgb(12 12 12)",
        "--bg": "rgb(12 12 12)",
        "--text": "rgb(220 220 220)",
        "--text-strong": "rgb(240 240 240)",
        "--muted": "rgb(180 180 180)",
        "--chat-text": "rgb(220 220 220)",
      }}
    >
      <SessionBackground context={context} surface="preview" />
    </div>
  ));
  await waitForSolid(() => {
    const photo = view.container.querySelector<HTMLImageElement>(".session-background__image");
    expect(photo).not.toBeNull();
    expect(Number(photo!.style.opacity)).toBeGreaterThan(0);
  });
});
