import { afterEach, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationTheme } from "../app/context.ts";
import { resetProfileAppearancePrefs } from "../app/server-prefs-profile.ts";
import { loadProfileAppearancePrefs } from "../app/server-prefs-reconcile.ts";
import { loadSettings } from "../app/settings.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SessionBackground } from "./session-background.tsx";

afterEach(() => {
  resetProfileAppearancePrefs();
  vi.restoreAllMocks();
});

it("samples the inherited palette when a Solid-mounted photo first joins the document", async () => {
  const gatewayUrl = `${location.origin.replace(/^http/u, "ws")}/ws`;
  const client = new GatewayBrowserClient({ url: gatewayUrl });
  vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method !== "users.prefs.get") {
      throw new Error(`Unexpected profile fixture method: ${method}`);
    }
    return { status: "ok", entries: {} };
  });
  const gateway = createApplicationGateway({
    client,
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
  gateway.gateway.connection.gatewayUrl = gatewayUrl;
  await loadProfileAppearancePrefs(client, "profile-a", gateway.gateway.connection.gatewayUrl, {
    isCurrent: () => true,
  });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const pixels = canvas.getContext("2d")!;
  pixels.fillStyle = "white";
  pixels.fillRect(0, 0, 2, 2);
  const photoBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg");
  });
  expect(photoBlob).not.toBeNull();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    return url.pathname === "/__openclaw__/users/background/asset-a"
      ? Promise.resolve(new Response(photoBlob, { headers: { "content-type": "image/jpeg" } }))
      : nativeFetch(input, init);
  });
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
