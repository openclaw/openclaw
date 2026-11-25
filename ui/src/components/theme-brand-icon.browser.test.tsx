import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { ChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginThemeArtwork } from "./plugin-theme-artwork.tsx";
import "../test-helpers/load-styles.ts";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>';
const artwork = () => new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });

function setupArtwork(responses: Record<string, () => Response | Promise<Response>>) {
  const previous = currentThemeBranding();
  const gateway = readAvatarGatewayContext();
  const fetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const respond =
      typeof input === "string" && Object.hasOwn(responses, input) ? responses[input] : undefined;
    return respond ? Promise.resolve(respond()) : fetch(input, init);
  });
  setAvatarGatewayOrigin(location.origin);
  onTestFinished(() => {
    spy.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
    setCurrentThemeBranding(previous);
  });
  return spy;
}

it("keeps custom working-indicator artwork at 18 pixels", async () => {
  const artworkUrl = "/__openclaw__/plugin-theme-art/synthetic/layout/icons/brand-size";
  setupArtwork({ [artworkUrl]: artwork });
  setCurrentThemeBranding(
    resolveThemeBranding({
      brandIcon: "synthetic",
      artwork: { icons: { synthetic: { url: artworkUrl } } },
    }),
  );
  const { container } = mountSolid(() => (
    <ChatWorkingIndicator
      part={{ kind: "reading-indicator", key: "synthetic-brand", startedAt: 1 }}
      options={{ workingIndicator: "brand", waitingApproval: true }}
    />
  ));
  await vi.dynamicImportSettled();
  const icon = () => container.querySelector<HTMLElement>("openclaw-theme-brand-icon");
  await waitForSolid(() => expect(icon()?.querySelector("img")?.naturalWidth).toBe(256));
  expect([icon()!.clientWidth, icon()!.clientHeight]).toEqual([18, 18]);
});

it("shows the fallback while replacing artwork with a different URL", async () => {
  const firstUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/first";
  const nextUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/next";
  const next = Promise.withResolvers<Response>();
  const artworkFetch = setupArtwork({ [firstUrl]: artwork, [nextUrl]: () => next.promise });
  onTestFinished(() => next.resolve(artwork()));
  const [url, setUrl] = createSignal(firstUrl);
  const { container } = mountSolid(() => (
    <PluginThemeArtwork url={url()} fallback="Loading artwork" />
  ));
  const image = () => container.querySelector("img");
  await waitForSolid(() => expect(image()?.naturalWidth).toBe(256));
  const firstSource = image()!.src;
  setUrl(nextUrl);
  await waitForSolid(() =>
    expect(artworkFetch.mock.calls.some(([input]) => input === nextUrl)).toBe(true),
  );
  await waitForSolid(() => {
    expect(container).toMatchObject({ textContent: "Loading artwork" });
    expect(image()).toBeNull();
  });
  next.resolve(artwork());
  await waitForSolid(() => {
    expect(image()?.naturalWidth).toBe(256);
    expect(image()?.src).not.toBe(firstSource);
    expect(container.textContent).toBe("");
  });
});
