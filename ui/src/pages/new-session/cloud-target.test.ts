/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSessionMenuItem, renderCloudProfileMenuItems } from "./cloud-target.ts";

describe("cloud target menu", () => {
  it("renders explicit remediation commands on separate lines", () => {
    const container = document.createElement("div");
    render(
      renderSessionMenuItem(
        {
          value: "device:disabled",
          label: "Device",
          compact: true,
          disabled: true,
          checked: false,
          title: "Hosting disabled",
          remediation: "enable-session-hosting",
          onSelect: vi.fn(),
        },
        false,
      ),
      container,
    );
    expect(container.querySelector("code.new-session-page__command")?.textContent).toBe(
      "openclaw connect --service --session-host",
    );
  });

  it("anchors selected cloud configuration beside its profile row", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [
          {
            id: "aws",
            providerId: "aws",
            operatingSystems: [
              { id: "linux", label: "Linux", default: true },
              { id: "windows", label: "Windows" },
            ],
            machines: [
              { id: "small", label: "Small", cpu: 2, memoryGb: 4, default: true },
              { id: "large", label: "Large", cpu: 8, memoryGb: 16 },
            ],
          },
        ],
        selectedId: "aws",
        selectedOs: "windows",
        selectedMachine: "large",
        compact: true,
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector('[data-value="cloud:aws"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const wrapper = container.querySelector("openclaw-tooltip.new-session-page__cloud-config-card");
    expect(wrapper?.getAttribute("placement")).toBe("right");
    expect(wrapper?.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(
      wrapper
        ?.querySelector('[slot="content"] [data-value="os:windows"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      wrapper
        ?.querySelector('[slot="content"] [data-value="machine:large"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows unselected provider defaults as suggestions and selects the provider before an explicit choice", () => {
    const container = document.createElement("div");
    const onSelect = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profiles: [
        {
          id: "aws",
          providerId: "aws",
          operatingSystems: [
            { id: "linux", label: "Linux", default: true },
            { id: "windows", label: "Windows" },
          ],
          machines: [
            { id: "small", label: "Small", default: true },
            { id: "standard", label: "Standard" },
          ],
        },
      ],
      selectedId: "",
      compact: true,
      submitting: false,
      onSelect,
      onSelectOs,
    };
    render(renderCloudProfileMenuItems(params), container);
    const suggested = container.querySelector<HTMLButtonElement>('[data-value="os:linux"]')!;
    expect(suggested.dataset.suggested).toBe("true");
    expect(suggested.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-value="machine:small"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    suggested.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws", true);
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("linux");
    render(renderCloudProfileMenuItems({ ...params, selectedId: "aws" }), container);
    expect(
      container.querySelector('[data-value="os:linux"]')?.getAttribute("data-suggested"),
    ).toBeNull();
    expect(container.querySelector('[data-value="os:linux"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows only the blocking reason for unavailable compact choices", () => {
    const container = document.createElement("div");
    render(
      renderSessionMenuItem(
        {
          value: "device:offline",
          label: "Offline device",
          compact: true,
          disabled: true,
          checked: false,
          title: "Device unavailable",
          platform: "macOS",
          facts: ["Camera"],
          capacityLabel: "Slot utilization unavailable",
          onSelect: vi.fn(),
        },
        false,
      ),
      container,
    );
    const card = container.querySelector('[slot="content"]');
    expect(card?.textContent?.trim()).toBe("Device unavailable");
    expect(card?.querySelector("strong, svg, .new-session-page__capacity-caption")).toBeNull();
  });

  it.each([
    {
      machine: { id: "standard", label: "Standard", cpu: 32, memoryGb: 64 },
      expected: "32 vCPU · 64 GB",
    },
    { machine: { id: "compute", label: "Compute", cpu: 48 }, expected: "48 vCPU" },
    { machine: { id: "memory", label: "Memory", memoryGb: 256 }, expected: "256 GB" },
    { machine: { id: "custom", label: "Custom" }, expected: "Custom" },
  ])("renders a single machine as fixed provider configuration", ({ machine, expected }) => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [{ id: "aws", providerId: "aws", machines: [machine] }],
        selectedId: "aws",
        compact: true,
        selectedMachine: machine.id,
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );
    const machineLabel = container.querySelector(`[data-value="machine:${machine.id}"]`);
    expect(machineLabel?.classList.contains("new-session-page__fixed-machine")).toBe(true);
    expect(machineLabel?.textContent).toContain(expected);
    expect(machineLabel?.tagName).toBe("SPAN");
  });

  it("keeps the profile selected when configuration uses defaults", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [
          {
            id: "aws",
            providerId: "aws",
            operatingSystems: [
              { id: "windows", label: "Windows" },
              { id: "linux", label: "Linux", default: true },
            ],
            machines: [
              { id: "small", label: "Small" },
              { id: "standard", label: "Standard", default: true },
            ],
          },
        ],
        selectedId: "aws",
        compact: true,
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector('[data-value="cloud:aws"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("forwards configuration choices and disables them while submitting", () => {
    const container = document.createElement("div");
    const onSelectMachine = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profiles: [
        {
          id: "aws",
          providerId: "aws",
          operatingSystems: [
            { id: "linux", label: "Linux" },
            { id: "macos", label: "macOS" },
          ],
          machines: [
            { id: "small", label: "Small" },
            { id: "large", label: "Large" },
          ],
        },
      ],
      selectedId: "aws",
      compact: true,
      selectedOs: "linux",
      selectedMachine: "small",
      submitting: false,
      onSelectMachine,
      onSelectOs,
      onSelect: vi.fn(),
    };
    render(renderCloudProfileMenuItems(params), container);
    container.querySelector<HTMLButtonElement>('[data-value="machine:large"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-value="os:macos"]')!.click();
    expect(onSelectMachine).toHaveBeenCalledExactlyOnceWith("large");
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("macos");
    render(renderCloudProfileMenuItems({ ...params, submitting: true }), container);
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("omits unavailable OS choices even when they are the current selection", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [
          {
            id: "aws",
            providerId: "aws",
            operatingSystems: [
              { id: "linux", label: "Linux" },
              { id: "windows", label: "Windows", disabledReason: "Install WSL2" },
            ],
          },
        ],
        selectedId: "aws",
        compact: true,
        selectedOs: "windows",
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );
    const fixedOs = container.querySelector('[data-value="os:linux"]');
    expect(fixedOs?.textContent).toBe("Linux");
    expect(fixedOs?.tagName).toBe("SPAN");
    expect(fixedOs?.hasAttribute("aria-pressed")).toBe(false);
    expect(container.querySelector('[data-value="os:windows"]')).toBeNull();
    expect(
      container.querySelector('.new-session-page__cloud-configuration [aria-pressed="true"]'),
    ).toBeNull();
  });

  it("disables cloud profiles with the runtime preflight reason", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [{ id: "aws", providerId: "crabbox" }],
        selectedId: "",
        submitting: false,
        disabled: true,
        disabledReason: "The acpx runtime does not support cloud workers.",
        onSelect: vi.fn(),
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("The acpx runtime does not support cloud workers.");
  });

  it("disables only the cloud profile with a profile-specific reason", () => {
    const reason =
      "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.";
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "ssh", providerId: "static-ssh" },
        ],
        selectedId: "",
        submitting: false,
        profileDisabledReason: (profile) => (profile.id === "aws" ? reason : undefined),
        onSelect: vi.fn(),
      }),
      container,
    );

    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    const enabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:ssh"]');
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.title).toBe(reason);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.title).toBe("Cloud worker provider: static-ssh");
  });
});
