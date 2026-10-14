/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { readDraftCloudProfiles } from "./discovery.ts";
import { renderPicker } from "./where-chip.test-support.ts";

describe("Cloud backend picker presentation", () => {
  it("orders actual backend groups while retaining disabled and missing selections", () => {
    const cloudProfiles = readDraftCloudProfiles([
      { id: "AWS", providerId: "crabbox", providerDisplayId: "local-container" },
      { id: "Azure", providerId: "crabbox", providerDisplayId: "incus" },
      { id: "custom", providerId: "custom-worker" },
      { id: "local", providerId: "crabbox", providerDisplayId: "machine0" },
      { id: "production", providerId: "crabbox", providerDisplayId: "aws" },
    ]);
    const onSelect = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles, cloudProfileId: "missing" },
      {
        onSelectCloudProfile: onSelect,
        cloudProfileDisabledReason: (profile) =>
          profile.id === "production" ? "Unavailable" : undefined,
      },
    );
    expect(
      [...container.querySelectorAll('[data-value^="cloud:"]')].map((row) =>
        row.getAttribute("data-value"),
      ),
    ).toEqual([
      "cloud:local",
      "cloud:production",
      "cloud:AWS",
      "cloud:Azure",
      "cloud:custom",
      "cloud:missing",
    ]);
    const missing = container.querySelector('[data-value="cloud:missing"]')!;
    expect(missing.getAttribute("aria-pressed")).toBe("true");
    expect(missing.getAttribute("aria-disabled")).toBe("true");
    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:production"]')!;
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.querySelector('[data-provider-icon="aws"]')).not.toBeNull();
    disabled.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the backend rather than the profile name in both trigger and filtered menu", () => {
    const onSelect = vi.fn();
    const cloudProfiles = readDraftCloudProfiles([
      {
        id: "aws",
        providerId: "crabbox",
        providerDisplayId: "azure",
        operatingSystems: [{ id: "linux", label: "Linux", default: true }],
        machines: [{ id: "standard", label: "Standard", default: true }],
      },
    ]);
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles, cloudProfileId: "aws" },
      { environmentQuery: "Azure", onSelectCloudProfile: onSelect },
    );
    const trigger = container.querySelector("#new-session-where-trigger")!;
    const row = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')!;
    for (const element of [trigger, row]) {
      expect(element.querySelector('[data-provider-icon="azure"]')).not.toBeNull();
      expect(element.getAttribute("aria-description")).toBe("Cloud worker provider: Azure");
      expect(element.textContent).toContain("Linux");
      expect(element.textContent).toContain("Standard");
    }
    expect(trigger.getAttribute("aria-label")).toBe("Where: aws, Linux · Standard");
    expect(row.hasAttribute("aria-label")).toBe(false);
    expect(row.querySelector(".session-menu__text")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "aws Linux · Standard",
    );
    row.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws");
  });
});
