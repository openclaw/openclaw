import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import {
  beginModelCatalogRead,
  clearModelCatalogCache,
  publishModelCatalogResult,
  type ModelCatalogClient,
} from "../../lib/model-catalog-cache.ts";
import { readCachedProviderPresentation } from "../../lib/provider-presentation-cache.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import type { CloudProfileIdentity } from "../cloud-profile-icon-data.ts";
import { CloudProfileIcon } from "./cloud-profile-icon.tsx";
import { Icon } from "./icon.tsx";
import { ProviderBrandIcon, ProviderFallbackIcon } from "./provider-icon.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function svgGeometry(element: Element | null): unknown {
  return element
    ? {
        tag: element.localName,
        namespace: element.namespaceURI,
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter((attribute) => attribute.name !== "aria-hidden")
            .map((attribute) => [attribute.name, attribute.value]),
        ),
        children: [...element.children].map(svgGeometry),
      }
    : null;
}

it("updates provider brands, aliases, and grapheme fallbacks without retaining stale assets", () => {
  const [provider, setProvider] = createSignal("google");
  const view = render(() => <ProviderBrandIcon provider={provider()} class="picker-icon" />);
  const icon = () => view.container.querySelector<HTMLElement>(".provider-brand-icon")!;
  expect(icon().dataset.providerIcon).toBe("gemini");
  expect(icon().style.getPropertyValue("--provider-icon-url")).toContain("ProviderIcon-gemini.svg");
  expect(icon().classList.contains("picker-icon")).toBe(true);

  setProvider("👩‍💻 Studio");
  flush();
  expect(icon().textContent).toBe("👩‍💻");
  expect(icon().dataset.providerIcon).toBeUndefined();
  expect(icon().style.getPropertyValue("--provider-icon-url")).toBe("");
  expect(icon().classList.contains("provider-brand-icon--fallback")).toBe(true);

  setProvider("acp-copilot");
  flush();
  expect(icon().dataset.providerIcon).toBe("copilot");
  expect(icon().classList.contains("provider-brand-icon--fallback")).toBe(false);
});

it("keeps cloud identity separate and changes from a branded service to infrastructure symbols", () => {
  const [profile, setProfile] = createSignal<CloudProfileIdentity>({
    providerId: "crabbox",
    providerDisplayId: "google",
  });
  const view = render(() => (
    <>
      <CloudProfileIcon profile={profile()} />
      <ProviderFallbackIcon label="   " />
    </>
  ));
  expect(view.container.querySelector("[data-provider-icon=gcp]")).not.toBeNull();
  expect(view.container.querySelector(".provider-brand-icon--fallback")?.textContent).toBe("?");
  setProfile({ providerId: "docker" });
  flush();
  expect(view.container.querySelector("[data-provider-icon]")).toBeNull();
  expect(view.container.querySelector(".cloud-profile-icon svg")?.getAttribute("viewBox")).toBe(
    "0 0 24 24",
  );
  expect(view.container.querySelector(".cloud-profile-icon polygon")).toBeNull();
  expect(view.container.querySelector(".cloud-profile-icon polyline")).not.toBeNull();
});

it.each([
  ["machine0", "server"],
  ["incus", "server"],
  ["docker", "box"],
  ["constructor", "cloud"],
] as const)("uses shared generic geometry for %s", (providerId, expectedIcon) => {
  const actual = render(() => <CloudProfileIcon profile={{ providerId }} />);
  const expected = render(() => <Icon name={expectedIcon} />);
  expect(svgGeometry(actual.container.querySelector("svg"))).toEqual(
    svgGeometry(expected.container.querySelector("svg")),
  );
  expect(actual.container.querySelector("svg")?.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(actual.container.querySelector("[data-provider-icon]")).toBeNull();
});

it("lets a bundled symbol override the provider brand and keeps invalid symbols usable", async () => {
  const [presentation, setPresentation] = createSignal<
    import("../provider-icon-data.ts").ProviderPresentation
  >({
    providerName: "Workstation",
    providerIcon: { source: "builtin", name: "server" },
  });
  const { container } = render(() => (
    <ProviderBrandIcon provider="openai" presentation={presentation()} />
  ));
  await vi.waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
  expect(container.querySelector("[data-provider-icon]")).toBeNull();
  setPresentation({
    providerName: "Workstation",
    providerIcon: { source: "builtin", name: "not-an-icon" },
  });
  flush();
  expect(container.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon")).toBe(
    "codex",
  );
});

it("loads artwork through the Gateway and falls through to the effective-name initial", async () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM5sAAAAASUVORK5CYII=",
        ),
        (char) => char.charCodeAt(0),
      ),
      { headers: { "Content-Type": "image/png" } },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const { container } = render(() => (
    <ProviderBrandIcon
      provider="rtx-pro-workstation"
      presentation={{
        providerName: "Workstation",
        providerIcon: { source: "asset", url: "/__openclaw__/provider-icon/workstation?v=opaque" },
      }}
    />
  ));
  await expect.poll(() => container.querySelector("img")).not.toBeNull();
  expect(fetch.mock.calls[0]?.[0]).toContain("/__openclaw__/provider-icon/workstation?v=opaque");
  expect(container.querySelector("img")?.style.objectFit).toBe("contain");
  const imageUrl = container.querySelector("img")?.src;
  container.querySelector("img")?.dispatchEvent(new Event("error"));
  flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("W");
  expect(revoke).toHaveBeenCalledWith(imageUrl);
});

it("keeps the built-in brand if configured artwork cannot be loaded", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const { container } = render(() => (
    <ProviderBrandIcon
      provider="openai"
      presentation={{
        providerName: "Workstation",
        providerIcon: { source: "asset", url: "/__openclaw__/provider-icon/missing" },
      }}
    />
  ));
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await expect
    .poll(() => container.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon"))
    .toBe("codex");
  expect(container.querySelector("img")).toBeNull();
});

it("projects per-connection catalog presentations through refresh and retirement", () => {
  const first = createTestGatewayClient(createGatewayRequestMock());
  const second = createTestGatewayClient(createGatewayRequestMock());
  const provider = "workstation";
  const model = { id: "stable-id", name: "Local model", provider };
  const source = createApplicationGateway(createApplicationGatewaySnapshot({ client: first }));
  // This standalone leaf exercises Gateway observation only, as in the canonical context harness.
  const context = { gateway: source.gateway } as ApplicationContext;
  const view = render(() => (
    <ApplicationProvider value={context}>
      <ModelProviderIcon provider={provider} />
    </ApplicationProvider>
  ));
  const initial = () => view.container.querySelector(".provider-brand-icon--fallback")?.textContent;
  const publish = (target: ModelCatalogClient, providerName: string, refresh = false) =>
    publishModelCatalogResult(
      beginModelCatalogRead(target, {}),
      { refresh },
      {
        models: target === first ? [] : [model],
        providerPresentations: { [provider]: { providerName } },
      },
    );
  expect(initial()).toBe("W");
  publish(first, "Alpha workstation");
  flush();
  expect(initial()).toBe("A");
  expect(readCachedProviderPresentation(first, provider)?.providerName).toBe("Alpha workstation");
  publish(second, "Bravo workstation");
  expect(readCachedProviderPresentation(second, provider)?.providerName).toBe("Bravo workstation");
  publish(first, "Renamed workstation", true);
  flush();
  expect(initial()).toBe("R");
  expect(readCachedProviderPresentation(first, provider)?.providerName).toBe("Renamed workstation");
  source.publish(createApplicationGatewaySnapshot({ client: second }));
  flush();
  expect(initial()).toBe("B");
  publish(first, "Stale workstation");
  flush();
  expect(initial()).toBe("B");
  clearModelCatalogCache(first);
  flush();
  expect(readCachedProviderPresentation(first, provider)).toBeUndefined();
  expect(readCachedProviderPresentation(second, provider)?.providerName).toBe("Bravo workstation");
  expect(initial()).toBe("B");
  clearModelCatalogCache(second);
  flush();
  expect(initial()).toBe("W");
  expect(readCachedProviderPresentation(second, provider)).toBeUndefined();
});
