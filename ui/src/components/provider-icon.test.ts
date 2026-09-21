/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { icons } from "./icons.ts";
import {
  compareCloudProfiles,
  renderProviderBrandIcon,
  resolveCloudProfileIcon,
} from "./provider-icon.ts";

describe("cloud provider presentation", () => {
  it.each(["aws", "azure", "daytona", "gcp", "google", "google-cloud", "hetzner", "machine0"])(
    "orders backend %s before local/custom profiles regardless of their names",
    (backend) => {
      const cloud = { id: "z-local", providerId: "crabbox", providerDisplayId: backend };
      for (const providerDisplayId of [
        "incus",
        "local-container",
        "docker",
        "local-docker",
        "podman",
        "local-podman",
        "custom",
        "constructor",
      ]) {
        const infrastructure = { id: "a-aws", providerId: "aws", providerDisplayId };
        expect(compareCloudProfiles(cloud, infrastructure)).toBeLessThan(0);
        expect(compareCloudProfiles(infrastructure, cloud)).toBeGreaterThan(0);
      }
      expect(
        compareCloudProfiles(
          { id: "z-local", providerId: backend },
          { id: "a-aws", providerId: "crabbox" },
        ),
      ).toBeLessThan(0);
    },
  );

  it("keeps alphabetical order within each group without changing the catalog", () => {
    const profiles = [
      { id: "b", providerId: "incus" },
      { id: "z", providerId: "machine0" },
      { id: "a", providerId: "custom" },
      { id: "y", providerId: "aws" },
    ];
    expect(profiles.toSorted(compareCloudProfiles).map((p) => p.id)).toEqual(["y", "z", "a", "b"]);
    expect(profiles.map((p) => p.id)).toEqual(["b", "z", "a", "y"]);
  });
  it.each(["gcp", "google", "google-cloud"])(
    "keeps %s separate from model-provider brands",
    (providerDisplayId) => {
      const container = document.createElement("div");
      render(resolveCloudProfileIcon({ providerId: "crabbox", providerDisplayId }).icon, container);
      expect(container.querySelector('[data-provider-icon="gcp"]')).not.toBeNull();
      render(renderProviderBrandIcon("google"), container);
      expect(container.querySelector('[data-provider-icon="gemini"]')).not.toBeNull();
    },
  );
  it.each([
    ["machine0", icons.server],
    ["incus", icons.server],
    ["local-container", icons.box],
    ["docker", icons.box],
    ["local-docker", icons.box],
    ["podman", icons.box],
    ["local-podman", icons.box],
    ["external", icons.cloud],
    ["unknown", icons.cloud],
    ["constructor", icons.cloud],
    ["__proto__", icons.cloud],
    ["toString", icons.cloud],
    ["crabbox", icons.cloud],
  ])("uses shared generic geometry for %s", (providerId, expectedIcon) => {
    const actual = document.createElement("div"),
      expected = document.createElement("div");
    render(resolveCloudProfileIcon({ providerId }).icon, actual);
    render(expectedIcon, expected);
    expect(actual.querySelector("svg")?.outerHTML).toBe(expected.querySelector("svg")?.outerHTML);
    expect(actual.querySelector("[data-provider-icon]")).toBeNull();
  });
});
