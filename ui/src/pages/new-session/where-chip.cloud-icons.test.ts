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
    for (const selected of ["AWS", "missing"]) {
      const container = renderPicker(
        true,
        undefined,
        { cloudProfiles, cloudProfileId: selected },
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
        ...(selected === "missing" ? ["cloud:missing"] : []),
      ]);
      const row = container.querySelector<HTMLButtonElement>(
        '[data-value="cloud:' + selected + '"]',
      )!;
      expect(row.getAttribute("aria-pressed")).toBe("true");
      expect(
        container.querySelector('[data-value="cloud:production"]')?.getAttribute("aria-disabled"),
      ).toBe("true");
      container.querySelector<HTMLButtonElement>('[data-value="cloud:production"]')!.click();
      expect(onSelect).not.toHaveBeenCalled();
      if (selected === "AWS") {
        row.click();
        expect(onSelect).toHaveBeenCalledExactlyOnceWith("AWS");
        onSelect.mockClear();
      } else {
        expect(row.getAttribute("aria-disabled")).toBe("true");
      }
    }
  });
  it.each([
    { id: "production", backend: "aws", brand: "aws", label: "AWS" },
    { id: "aws", backend: "azure", brand: "azure", label: "Azure" },
    { id: "production", backend: "google-cloud", brand: "gcp", label: "Google Cloud" },
  ])(
    "uses backend $backend for named profile $id in both trigger and filtered menu",
    ({ id, backend, brand, label }) => {
      const onSelect = vi.fn();
      const cloudProfiles = readDraftCloudProfiles([
        {
          id,
          providerId: "crabbox",
          providerDisplayId: backend,
          operatingSystems: [{ id: "linux", label: "Linux", default: true }],
          machines: [{ id: "standard", label: "Standard", default: true }],
        },
      ]);
      const container = renderPicker(
        true,
        undefined,
        { cloudProfiles, cloudProfileId: id },
        {
          environmentQuery: label,
          onSelectCloudProfile: onSelect,
        },
      );
      const trigger = container.querySelector("#new-session-where-trigger")!;
      const row = container.querySelector<HTMLButtonElement>('[data-value="cloud:' + id + '"]')!;
      for (const element of [trigger, row]) {
        expect(element.querySelector('[data-provider-icon="' + brand + '"]')).not.toBeNull();
        expect(element.getAttribute("aria-description")).toBe(`Cloud worker provider: ${label}`);
        expect(element.textContent).toContain("Linux");
        expect(element.textContent).toContain("Standard");
      }
      expect(trigger.getAttribute("aria-label")).toBe(`Where: ${id}, Linux · Standard`);
      expect(row.hasAttribute("aria-label")).toBe(false);
      expect(
        row.querySelector(".session-menu__text")?.textContent?.replace(/\s+/g, " ").trim(),
      ).toBe(`${id} Linux · Standard`);
      row.click();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(id);
      const disabled = renderPicker(
        true,
        undefined,
        { cloudProfiles, cloudProfileId: id },
        { cloudDisabledReason: "Unavailable" },
      );
      expect(
        disabled.querySelector(
          '[data-value="cloud:' + id + '"] [data-provider-icon="' + brand + '"]',
        ),
      ).not.toBeNull();
    },
  );
});
