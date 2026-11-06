// Control UI tests cover public assets behavior.
import { afterEach, describe, expect, it } from "vitest";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { controlUiPublicAssetPath, inferControlUiPublicAssetPath } from "./public-assets.ts";

function withConfiguredBasePath<T>(basePath: string, run: () => T): T {
  const key = "__OPENCLAW_CONTROL_UI_BASE_PATH__";
  const previous = Object.getOwnPropertyDescriptor(window, key);
  Object.defineProperty(window, key, { configurable: true, value: basePath });
  try {
    return run();
  } finally {
    restorePropertyDescriptor(window, key, previous);
  }
}

const originalLocation = window.location.href;
afterEach(() => window.history.replaceState(null, "", originalLocation));

describe("controlUiPublicAssetPath", () => {
  it("versions public assets with the document build while keeping the worker revalidating", () => {
    const attribute = "data-openclaw-control-ui-build-id";
    document.documentElement.setAttribute(attribute, "build-a");
    try {
      for (const asset of [
        "favicon.svg",
        "apple-touch-icon.png",
        "manifest.webmanifest",
        "themes/absolutely.css",
        "fonts/lora.css",
        "provider-icons/ProviderIcon-pi.svg",
        "cloud-provider-icons/aws.svg",
        "file-icons/compact/dark/pdf.svg",
        "file-icons/large/shell-dark.svg",
        "file-icons/overlays/pdf.svg",
        "app-art/example.webp",
        "community-art/example.webp",
      ] as const) {
        expect(controlUiPublicAssetPath(asset, "")).toBe(`/${asset}?v=build-a`);
        expect(controlUiPublicAssetPath(asset, "/control/")).toBe(`/control/${asset}?v=build-a`);
      }
      expect(controlUiPublicAssetPath("sw.js", "/control")).toBe("/control/sw.js");
      document.documentElement.setAttribute(attribute, "build-b");
      expect(
        withConfiguredBasePath("/control", () => inferControlUiPublicAssetPath("fonts/lora.css")),
      ).toBe("/control/fonts/lora.css?v=build-b");
    } finally {
      document.documentElement.removeAttribute(attribute);
    }
  });

  it("resolves root-mounted public assets from the URL root", () => {
    expect(controlUiPublicAssetPath("favicon.svg", "")).toBe("/favicon.svg");
    expect(controlUiPublicAssetPath("manifest.webmanifest", null)).toBe("/manifest.webmanifest");
  });
});

describe("inferControlUiPublicAssetPath", () => {
  it("uses the root for known nested routes without a configured base path", () => {
    window.history.replaceState(null, "", "/skills/workshop");
    expect(inferControlUiPublicAssetPath("manifest.webmanifest")).toBe("/manifest.webmanifest");
    window.history.replaceState(null, "", "/__openclaw__/new");
    expect(withConfiguredBasePath("", () => inferControlUiPublicAssetPath("favicon.svg"))).toBe(
      "/favicon.svg",
    );
  });
});
