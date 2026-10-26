import { describe, expect, it } from "vitest";
import {
  compareCloudProfiles,
  hasProviderBrandIcon,
  providerDisplayLabel,
} from "./provider-icon-data.ts";

describe("model provider labels", () => {
  it.each([
    ["constructor", "Constructor"],
    ["__proto__", "Proto"],
    ["openai", "OpenAI"],
    ["xai", "xAI"],
    ["acp-opencode", "OpenCode (ACP)"],
    ["acp-qwen", "Qwen Code (ACP)"],
    ["acp-pi", "Pi (ACP)"],
    ["acp-copilot", "GitHub Copilot CLI"],
  ])("renders provider %s as display text", (provider, label) => {
    expect(providerDisplayLabel(provider)).toBe(label);
  });

  it("gives ACP harness groups their agent's brand mark", () => {
    expect(hasProviderBrandIcon("acp-opencode")).toBe(true);
    expect(hasProviderBrandIcon("acp-copilot")).toBe(true);
    expect(hasProviderBrandIcon("acp-example")).toBe(false);
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
});
