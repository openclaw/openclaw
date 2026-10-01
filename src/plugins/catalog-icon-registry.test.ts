import { describe, expect, it } from "vitest";
import {
  registerClawHubCatalogIconUrls,
  resolveClawHubCatalogIconUrl,
} from "./catalog-icon-registry.js";

describe("ClawHub catalog icon registry", () => {
  it("only resolves exact HTTPS URLs learned from catalog responses", () => {
    registerClawHubCatalogIconUrls([
      "https://cdn.example.com/icon.svg",
      "http://cdn.example.com/insecure.svg",
    ]);

    expect(resolveClawHubCatalogIconUrl("https://cdn.example.com/icon.svg")).toBe(
      "https://cdn.example.com/icon.svg",
    );
    expect(resolveClawHubCatalogIconUrl("https://cdn.example.com/other.svg")).toBeUndefined();
    expect(resolveClawHubCatalogIconUrl("http://cdn.example.com/insecure.svg")).toBeUndefined();
  });

  it("retains the latest 1024 registered URLs without promoting reads", () => {
    const iconUrl = (index: number) => `https://cdn.example.com/retained-icon-${index}.svg`;
    registerClawHubCatalogIconUrls(Array.from({ length: 1024 }, (_, index) => iconUrl(index)));
    registerClawHubCatalogIconUrls([iconUrl(0)]);
    expect(resolveClawHubCatalogIconUrl(iconUrl(1))).toBe(iconUrl(1));

    registerClawHubCatalogIconUrls([iconUrl(1024)]);

    expect(resolveClawHubCatalogIconUrl(iconUrl(1))).toBeUndefined();
    expect(resolveClawHubCatalogIconUrl(iconUrl(0))).toBe(iconUrl(0));
    expect(resolveClawHubCatalogIconUrl(iconUrl(2))).toBe(iconUrl(2));
  });
});
