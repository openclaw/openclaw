/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { icons } from "./icons.ts";
import {
  compareCloudProfiles,
  providerDisplayLabel,
  renderProviderBrandIcon,
  resolveCloudProfileIcon,
} from "./provider-icon.ts";

describe("model provider labels", () => {
  it.each([
    ["constructor", "Constructor"],
    ["__proto__", "Proto"],
    ["openai", "OpenAI"],
  ])("renders provider %s as display text", (provider, label) => {
    expect(providerDisplayLabel(provider)).toBe(label);
  });
});

describe("cloud provider presentation", () => {
  it.each(["google", "machine0"])(
    "orders backend %s before local profiles, alphabetically within each group",
    (backend) => {
      const cloud = { id: "z-local", providerId: "crabbox", providerDisplayId: backend };
      const infrastructure = { id: "a-aws", providerId: "aws", providerDisplayId: "constructor" };
      expect(compareCloudProfiles(cloud, infrastructure)).toBeLessThan(0);
      expect(compareCloudProfiles(infrastructure, cloud)).toBeGreaterThan(0);
      expect(
        compareCloudProfiles(
          { id: "z-local", providerId: backend },
          { id: "a-aws", providerId: "crabbox" },
        ),
      ).toBeLessThan(0);
      const profiles = [
        { id: "b", providerId: "incus" },
        { id: "z", providerId: "machine0" },
        { id: "a", providerId: "custom" },
        { id: "y", providerId: "aws" },
      ];
      expect(profiles.toSorted(compareCloudProfiles).map((p) => p.id)).toEqual([
        "y",
        "z",
        "a",
        "b",
      ]);
      expect(profiles.map((p) => p.id)).toEqual(["b", "z", "a", "y"]);
    },
  );
  it("keeps Google Cloud separate from model-provider brands", () => {
    const container = document.createElement("div");
    render(
      resolveCloudProfileIcon({ providerId: "crabbox", providerDisplayId: "google" }).icon,
      container,
    );
    expect(container.querySelector('[data-provider-icon="gcp"]')).not.toBeNull();
    render(renderProviderBrandIcon("google"), container);
    expect(container.querySelector('[data-provider-icon="gemini"]')).not.toBeNull();
  });
  it.each([
    ["machine0", icons.server],
    ["incus", icons.server],
    ["docker", icons.box],
    ["constructor", icons.cloud],
  ])("uses shared generic geometry for %s", (providerId, expectedIcon) => {
    const actual = document.createElement("div"),
      expected = document.createElement("div");
    render(resolveCloudProfileIcon({ providerId }).icon, actual);
    render(expectedIcon, expected);
    expect(actual.querySelector("svg")?.outerHTML).toBe(expected.querySelector("svg")?.outerHTML);
    expect(actual.querySelector("[data-provider-icon]")).toBeNull();
  });
});
