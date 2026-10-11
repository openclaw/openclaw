import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { CloudProfileIcon, ProviderBrandIcon, ProviderFallbackIcon } from "./provider-icon.tsx";

afterEach(cleanup);

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
  const [providerId, setProviderId] = createSignal("google");
  const view = render(() => (
    <>
      <CloudProfileIcon profile={{ providerId: providerId() }} />
      <ProviderFallbackIcon label="   " />
    </>
  ));
  expect(view.container.querySelector("[data-provider-icon=gcp]")).not.toBeNull();
  expect(view.container.querySelector(".provider-brand-icon--fallback")?.textContent).toBe("?");
  setProviderId("docker");
  flush();
  expect(view.container.querySelector("[data-provider-icon]")).toBeNull();
  expect(view.container.querySelector(".cloud-profile-icon svg")?.getAttribute("viewBox")).toBe(
    "0 0 24 24",
  );
  expect(view.container.querySelector(".cloud-profile-icon polygon")).toBeNull();
  expect(view.container.querySelector(".cloud-profile-icon polyline")).not.toBeNull();
});
