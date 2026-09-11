/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import {
  renderSessionMenuItem,
  renderCloudMachineSelect,
  renderCloudOsSelect,
  renderCloudProfileMenuItems,
} from "./cloud-target.ts";

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

  it("uses the selected cloud OS and machine rather than the defaults", () => {
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
    const card = container.querySelector('[slot="content"]');
    const controls = card?.querySelectorAll<SelectPicker>("openclaw-select-picker");
    expect(controls?.[0]?.params.value).toBe("windows");
    expect(controls?.[1]?.params.value).toBe("large");
    expect(controls?.[1]?.params.options.find((option) => option.value === "large")?.label).toBe(
      "8 vCPU · 16 GB",
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
  ])("includes available compute details in $machine.id option", ({ machine, expected }) => {
    const container = document.createElement("div");
    render(
      renderCloudMachineSelect({
        machines: [machine],
        selectedId: machine.id,
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );
    expect(
      container.querySelector<SelectPicker>("openclaw-select-picker")?.params.options[0]?.label,
    ).toBe(expected);
    expect(container.querySelector<SelectPicker>("openclaw-select-picker")?.params.value).toBe(
      machine.id,
    );
  });

  it("selects profile defaults when no explicit choice is set", () => {
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
    expect(
      [...container.querySelectorAll<SelectPicker>("openclaw-select-picker")].map(
        (select) => select.params.value,
      ),
    ).toEqual(["linux", "standard"]);
  });

  it("forwards machine changes and disables the control while submitting", () => {
    const container = document.createElement("div");
    const onSelect = vi.fn();
    const params = {
      machines: [
        { id: "small", label: "Small" },
        { id: "large", label: "Large" },
      ],
      selectedId: "small",
      submitting: false,
      onSelect,
    };
    render(renderCloudMachineSelect(params), container);
    const select = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    select.params.onChange("large");
    expect(onSelect).toHaveBeenCalledWith("large");
    render(renderCloudMachineSelect({ ...params, submitting: true }), container);
    expect(container.querySelector<SelectPicker>("openclaw-select-picker")?.params.disabled).toBe(
      true,
    );
  });

  it("retains unavailable OS repair hints and forwards eligible OS changes", () => {
    const container = document.createElement("div");
    const onSelect = vi.fn();
    const params = {
      operatingSystems: [
        { id: "linux", label: "Linux" },
        { id: "windows", label: "Windows", disabledReason: "Install WSL2" },
        { id: "macos", label: "macOS" },
      ],
      selectedId: "linux",
      submitting: false,
      onSelect,
    };
    render(renderCloudOsSelect(params), container);
    const select = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    expect(select.params.value).toBe("linux");
    expect(select.params.options[1]?.disabled).toBe(true);
    expect(select.params.options[1]?.description).toBe("Install WSL2");
    select.params.onChange("macos");
    expect(onSelect).toHaveBeenCalledWith("macos");
    render(renderCloudOsSelect({ ...params, submitting: true }), container);
    expect(container.querySelector<SelectPicker>("openclaw-select-picker")?.params.disabled).toBe(
      true,
    );
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
