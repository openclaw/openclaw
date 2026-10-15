import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { LitContent } from "../lit/solid-content.tsx";
import { renderSubagentActivity } from "../pages/chat/components/chat-subagent-activity.ts";
import { ChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderPluginThemeArtwork } from "./plugin-theme-artwork.ts";
import "../test-helpers/load-styles.ts";

afterEach(cleanupSolid);

it.each([
  { kind: "working-indicator", size: 18 },
  { kind: "subagent", size: 16 },
])("keeps custom $kind artwork at $size pixels", async ({ kind, size }) => {
  const previous = currentThemeBranding();
  const gateway = readAvatarGatewayContext();
  const artworkUrl = "/__openclaw__/plugin-theme-art/synthetic/layout/icons/brand-size";
  const fetch = globalThis.fetch;
  const artworkFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      input === artworkUrl
        ? Promise.resolve(
            new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4169e1"/></svg>',
              { headers: { "Content-Type": "image/svg+xml" } },
            ),
          )
        : fetch(input, init),
    );
  try {
    setAvatarGatewayOrigin(location.origin);
    setCurrentThemeBranding(
      resolveThemeBranding({
        brandIcon: "synthetic",
        artwork: { icons: { synthetic: { url: artworkUrl } } },
      }),
    );
    const view = mountSolid(() =>
      kind === "subagent" ? (
        <LitContent
          value={renderSubagentActivity([
            {
              key: "agent:main:synthetic-subagent",
              label: "Synthetic review",
              status: "running",
              listed: true,
              session: {
                key: "agent:main:synthetic-subagent",
                kind: "direct",
                updatedAt: null,
              },
            },
          ])}
        />
      ) : (
        <ChatWorkingIndicator
          part={{ kind: "reading-indicator", key: "synthetic-brand", startedAt: 1 }}
          options={{ workingIndicator: "brand", waitingApproval: true }}
        />
      ),
    );
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      expect(
        view.container.querySelector<HTMLImageElement>("openclaw-theme-brand-icon img")
          ?.naturalWidth,
      ).toBe(256);
    });
    const icon = view.container.querySelector("openclaw-theme-brand-icon")!;
    expect(icon.clientWidth).toBe(size);
    expect(icon.clientHeight).toBe(size);
  } finally {
    artworkFetch.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
    setCurrentThemeBranding(previous);
  }
});

it("shows the fallback while replacing legacy artwork with a different URL", async () => {
  const gateway = readAvatarGatewayContext();
  const firstUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/first";
  const nextUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/next";
  const next = Promise.withResolvers<Response>();
  const artwork = () =>
    new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4169e1"/></svg>',
      { headers: { "Content-Type": "image/svg+xml" } },
    );
  const fetch = globalThis.fetch;
  const artworkFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      input === firstUrl
        ? Promise.resolve(artwork())
        : input === nextUrl
          ? next.promise
          : fetch(input, init),
    );
  const [url, setUrl] = createSignal(firstUrl);
  try {
    setAvatarGatewayOrigin(location.origin);
    const view = mountSolid(() => (
      <LitContent value={renderPluginThemeArtwork(url(), "synthetic-hat", "Loading artwork")} />
    ));
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(256),
    );
    const firstSource = view.container.querySelector("img")!.src;
    setUrl(nextUrl);
    await waitForSolid(() =>
      expect(artworkFetch.mock.calls.some(([input]) => input === nextUrl)).toBe(true),
    );
    await waitForSolid(() => {
      expect(view.container.textContent).toBe("Loading artwork");
      expect(view.container.querySelector("img")).toBeNull();
    });
    next.resolve(artwork());
    await waitForSolid(() => {
      const image = view.container.querySelector<HTMLImageElement>("img");
      expect(image?.naturalWidth).toBe(256);
      expect(image?.src).not.toBe(firstSource);
      expect(view.container.textContent).toBe("");
    });
  } finally {
    next.resolve(artwork());
    artworkFetch.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
  }
});
