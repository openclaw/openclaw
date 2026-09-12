/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { deviceIcons } from "../../components/icons-devices.ts";
import { icons } from "../../components/icons.ts";
import { hoverDetails, renderPicker } from "../../test-helpers/new-session-where-chip.ts";
import { readDraftCloudProfiles } from "./discovery.ts";

describe("Where chip rendering", () => {
  it("focuses environment search only after the enclosing picker opens", () => {
    const container = renderPicker(true);
    const popover = container.querySelector("wa-popover")!;
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const focus = vi.spyOn(search, "focus");
    search.dispatchEvent(new CustomEvent("wa-after-show", { bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    popover.dispatchEvent(new CustomEvent("wa-after-show"));
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "Work MacBook Pro", platform: "darwin", icon: deviceIcons.laptop, form: "laptop" },
    {
      label: "Personal MacBook Air",
      platform: undefined,
      icon: deviceIcons.laptop,
      form: "laptop",
    },
    { label: "Office Mac-mini", platform: "darwin", icon: deviceIcons.macMini, form: "mini" },
    { label: "Build Mac Studio", platform: "macOS", icon: deviceIcons.macStudio, form: "studio" },
    { label: "Development workstation", platform: "darwin", icon: icons.monitor, form: null },
    { label: "MacBookish workstation", platform: "darwin", icon: icons.monitor, form: null },
    { label: "Studio runner", platform: "darwin", icon: icons.monitor, form: null },
    { label: "Build Mac Studio", platform: "linux", icon: icons.monitor, form: null },
  ])(
    "uses the same device outline in the selected row and trigger: $label / $platform",
    ({ label, platform, icon, form }) => {
      const container = renderPicker(true, undefined, {
        deviceId: "model-device",
        environments: [
          {
            id: "node:model-device",
            type: "node",
            label,
            platform,
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
      });
      const expected = document.createElement("div");
      render(icon, expected);
      const expectedSvg = expected.querySelector("svg")!;

      expect(
        expectedSvg.isEqualNode(
          container.querySelector('[data-value="device:model-device"] .session-menu__icon svg'),
        ),
      ).toBe(true);
      expect(
        expectedSvg.isEqualNode(
          container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
        ),
      ).toBe(true);
      for (const selector of [
        '[data-value="device:model-device"] .session-menu__icon',
        "#new-session-where-trigger .new-session-page__target-icon",
      ]) {
        const marker = container.querySelector(`${selector} .new-session-page__device-icon`);
        if (form) {
          expect(marker?.getAttribute("data-form")).toBe(form);
        } else {
          expect(marker).toBeNull();
        }
      }
    },
  );

  it.each([
    { cloudProfileId: "", value: "gateway", icon: icons.home },
    { cloudProfileId: "aws", value: "cloud:aws", icon: icons.cloud },
  ])(
    "keeps destination-type icons for $value even with a Mac-named Gateway",
    ({ cloudProfileId, value, icon }) => {
      const container = renderPicker(
        true,
        undefined,
        { cloudProfileId },
        { gatewayName: "Gateway Mac Studio" },
      );
      if (value === "gateway") {
        expect(
          container.querySelector(".new-session-page__trigger-label")?.textContent?.trim(),
        ).toBe("Gateway Mac Studio");
        expect(
          container
            .querySelector('[data-value="gateway"] .session-menu__text')
            ?.textContent?.trim(),
        ).toBe("Gateway Mac Studio");
      }
      const expected = document.createElement("div");
      render(icon, expected);
      const expectedSvg = expected.querySelector("svg")!;

      expect(
        expectedSvg.isEqualNode(
          container.querySelector(`[data-value="${value}"] .session-menu__icon svg`),
        ),
      ).toBe(true);
      expect(
        expectedSvg.isEqualNode(
          container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
        ),
      ).toBe(true);
      expect(
        container.querySelector(`[data-value="${value}"] .new-session-page__device-icon`),
      ).toBeNull();
      expect(
        container.querySelector("#new-session-where-trigger .new-session-page__device-icon"),
      ).toBeNull();
    },
  );

  it.each([
    { query: "  local  ", expected: ["gateway"] },
    { query: "STUDIO", expected: ["gateway"] },
    { query: "device", expected: ["device:runner", "device:alpha-device", "device:beta-device"] },
    { query: "beta-device", expected: ["device:beta-device"] },
    { query: "cloud", expected: ["cloud:aws"] },
    { query: "AWS", expected: ["cloud:aws"] },
    { query: "crabbox", expected: ["cloud:aws"] },
    { query: "persistent", expected: ["cloud:aws"] },
  ])("searches destination names, types, IDs and facts: $query", ({ query, expected }) => {
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles: [{ id: "aws", providerId: "crabbox", trust: "persistent" }] },
      { gatewayName: "Build Studio", environmentQuery: query },
    );

    expect(
      [
        ...container.querySelectorAll(
          '.new-session-page__environment-list [data-value]:not([data-value="auto-device"])',
        ),
      ].map((row) => row.getAttribute("data-value")),
    ).toEqual(expected);
  });

  it.each([0, 1, 2])(
    "shows Auto only for multiple paired devices and always provides the admin add-device action: %s",
    (count) => {
      const environments = Array.from({ length: count }, (_, index) => ({
        id: `node:device${index}`,
        type: "node" as const,
        label: `Device ${index}`,
        status: "available" as const,
        sessionHost: true,
        workerSlots: { total: 2, available: 2 },
      }));
      const container = renderPicker(true, undefined, { environments });
      expect(Boolean(container.querySelector('[data-value="auto-device"]'))).toBe(count > 1);
      const connect = container.querySelector<HTMLButtonElement>('[data-action="connect-machine"]');
      expect(connect).not.toBeNull();
      expect(connect?.classList.contains("new-session-page__connect-device")).toBe(true);
    },
  );

  it("keeps the gateway as a distinct home-icon option after selecting the device pool", () => {
    const container = renderPicker(true, undefined, { autoDevice: true });
    const gateway = container.querySelector<HTMLButtonElement>('[data-value="gateway"]');
    const pool = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]');

    expect(gateway?.getAttribute("aria-pressed")).toBe("false");
    expect(pool?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll('[data-value="gateway"]')).toHaveLength(1);
    expect(gateway?.querySelector(".session-menu__icon svg")).not.toBeNull();
  });

  it("uses the same device-pool icon in the Auto trigger and menu row", () => {
    const container = renderPicker(true, undefined, { autoDevice: true });
    for (const icon of [
      container.querySelector('[data-value="auto-device"] .session-menu__icon svg'),
      container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
    ]) {
      expect(icon?.querySelector('rect[x="2"][y="7"][width="14"]')).not.toBeNull();
    }
  });

  it("omits the Cloud heading when no cloud profiles are configured", () => {
    const container = renderPicker(true, undefined, { cloudProfiles: [] });
    const headings = [...container.querySelectorAll(".new-session-page__environment-heading")].map(
      (heading) => heading.textContent?.trim(),
    );

    expect(headings).toEqual(["Your devices"]);
  });

  it("shows the Cloud settings action only to admins when a cloud profile is available", () => {
    const onManageCloudWorkers = vi.fn();
    const admin = renderPicker(true, undefined, {}, { onManageCloudWorkers });
    const action = admin.querySelector<HTMLButtonElement>('[data-action="manage-cloud-workers"]');
    expect(action).not.toBeNull();
    expect(action?.classList.contains("new-session-page__connect-device")).toBe(true);
    action?.click();
    expect(onManageCloudWorkers).toHaveBeenCalledOnce();

    expect(renderPicker(false).querySelector('[data-action="manage-cloud-workers"]')).toBeNull();
    expect(
      renderPicker(true, undefined, { cloudProfiles: [] }).querySelector(
        '[data-action="manage-cloud-workers"]',
      ),
    ).toBeNull();
  });

  it("does not offer Connect to non-admin users with no paired devices", () => {
    const onConnectMachine = vi.fn();
    const container = renderPicker(false, undefined, { environments: [] }, { onConnectMachine });
    expect(container.querySelector('[data-action="connect-machine"]')).toBeNull();
    expect(onConnectMachine).not.toHaveBeenCalled();
  });

  it("describes eligible-order automatic placement accurately", () => {
    const container = renderPicker(true, "eligible-order");
    expect(
      container.querySelector('[data-value="auto-device"]')?.getAttribute("aria-description"),
    ).toBe("Chooses the first eligible connected device");
  });

  it("uses the full paired-device count for Auto while search narrows the rows", () => {
    const container = renderPicker(true, undefined, {}, { environmentQuery: "beta-device" });
    expect(container.querySelector('[data-value="auto-device"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-value^="device:"]')).toHaveLength(1);
  });

  it("places Any available device first in Your devices with destination-card help", () => {
    const container = renderPicker(true);
    const row = container.querySelector('[data-value="auto-device"]');
    const choices = [
      ...container.querySelectorAll(
        '[data-value="auto-device"], [data-value="gateway"], [data-value^="device:"]',
      ),
    ];
    expect(choices[0]).toBe(row);
    expect(row?.closest(".new-session-page__devices-heading")).toBeNull();
    expect(hoverDetails(row)).toContain("Chooses the least-busy connected device");
    expect(
      row?.closest("openclaw-tooltip")?.querySelector(".new-session-page__environment-card"),
    ).not.toBeNull();
  });

  it("explains the checkout requirement instead of provider details", () => {
    const container = renderPicker(true, undefined, {}, { worktreeAvailable: false });
    expect(hoverDetails(container.querySelector('[data-value="cloud:aws"]'))).toBe(
      "Cloud needs a Git checkout",
    );
  });

  it("places usable devices before disabled devices while preserving each group's order", () => {
    const container = renderPicker(true, undefined, {
      environments: [
        {
          id: "node:offline",
          type: "node",
          label: "Offline",
          status: "offline",
          sessionHost: true,
        },
        {
          id: "node:ready",
          type: "node",
          label: "Ready",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 1 },
        },
        {
          id: "node:busy",
          type: "node",
          label: "Busy",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 0 },
        },
        {
          id: "node:ready2",
          type: "node",
          label: "Ready two",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 1 },
        },
      ],
    });
    expect(
      [...container.querySelectorAll('[data-value^="device:"]')].map((row) =>
        row.getAttribute("data-value"),
      ),
    ).toEqual(["device:ready", "device:ready2", "device:busy", "device:offline"]);
  });

  it("keeps matching Local, Devices and Cloud in order with device facts searchable", () => {
    const container = renderPicker(
      true,
      undefined,
      {
        environments: [
          {
            id: "node:zulu",
            type: "node",
            label: "Zulu runner",
            platform: "linux",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
          {
            id: "node:alpha",
            type: "node",
            label: "Alpha runner",
            platform: "linux",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        cloudProfiles: [{ id: "linux-worker", providerId: "crabbox" }],
      },
      { gatewayName: "Linux Studio", environmentQuery: "LINUX" },
    );

    expect(
      [
        ...container.querySelectorAll(
          '.new-session-page__environment-list [data-value]:not([data-value="auto-device"])',
        ),
      ].map((row) => row.getAttribute("data-value")),
    ).toEqual(["gateway", "device:alpha", "device:zulu", "cloud:linux-worker"]);
    expect(hoverDetails(container.querySelector('[data-value="device:alpha"]'))).toContain("Linux");
  });

  it("does not offer Connect when search hides already paired devices", () => {
    const container = renderPicker(true, undefined, {}, { environmentQuery: "no-such-runner" });
    expect(container.querySelector('[data-action="connect-machine"]')).toBeNull();
    expect(container.textContent).toContain("No matching environments");
  });

  it("forwards search input without changing the selected destination", () => {
    const onEnvironmentQueryInput = vi.fn();
    const onSelectDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { deviceId: "runner" },
      { onEnvironmentQueryInput, onSelectDevice },
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search environments"]',
    )!;

    input.value = "cloud";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onEnvironmentQueryInput).toHaveBeenCalledExactlyOnceWith("cloud");
    expect(onSelectDevice).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-value="device:runner"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it.each([
    { isAdmin: true, cloudProfileId: "aws", blocked: false, shown: true },
    { isAdmin: false, cloudProfileId: "aws", blocked: false, shown: false },
    { isAdmin: true, cloudProfileId: "", blocked: false, shown: true },
    { isAdmin: true, cloudProfileId: "aws", blocked: true, shown: false },
  ])(
    "gates the split configuration panel: $isAdmin / $cloudProfileId / $blocked",
    ({ isAdmin, cloudProfileId, blocked, shown }) => {
      const container = renderPicker(
        isAdmin,
        undefined,
        {
          cloudProfileId,
          cloudProfiles: [
            {
              id: "aws",
              providerId: "aws",
              operatingSystems: [{ id: "linux", label: "Linux", default: true }],
            },
          ],
        },
        { cloudDisabledReason: blocked ? "Cloud unavailable" : undefined },
      );
      expect(Boolean(container.querySelector(".new-session-page__cloud-configuration"))).toBe(
        shown,
      );
    },
  );

  it.each([
    { cloudOs: undefined, cloudMachine: undefined, expectedOs: "linux", expectedMachine: "small" },
    { cloudOs: "windows", cloudMachine: "large", expectedOs: "windows", expectedMachine: "large" },
  ])(
    "resolves split panel selected/default configuration: $expectedOs / $expectedMachine",
    ({ cloudOs, cloudMachine, expectedOs, expectedMachine }) => {
      const container = renderPicker(true, undefined, {
        cloudProfileId: "aws",
        os: cloudOs,
        machineClass: cloudMachine,
        cloudProfiles: [
          {
            id: "aws",
            providerId: "aws",
            operatingSystems: [
              { id: "linux", label: "Linux", default: true },
              { id: "windows", label: "Windows" },
            ],
            machines: [
              { id: "small", label: "Small", default: true },
              { id: "large", label: "Large" },
            ],
          },
        ],
      });
      const cloudRow = container.querySelector('[data-value="cloud:aws"]');
      expect(cloudRow?.querySelector(".session-menu__text")?.textContent?.trim()).toMatch(/^aws/);
      expect(cloudRow?.querySelector(".new-session-page__selected-summary")?.textContent).toBe(
        expectedOs === "linux" ? "Linux · Small" : "Windows · Large",
      );
      expect(container.querySelector("#new-session-where-trigger")?.textContent?.trim()).toBe(
        "aws",
      );
      expect(
        container.querySelector(`[data-value="os:${expectedOs}"]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        container
          .querySelector(`[data-value="machine:${expectedMachine}"]`)
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it("hides unavailable operating systems from cloud configuration", () => {
    const reason = "Upgrade Crabbox to 0.53.1 or newer, then restart the Gateway.";
    const container = renderPicker(true, undefined, {
      cloudProfileId: "aws",
      cloudProfiles: readDraftCloudProfiles([
        {
          id: "aws",
          providerId: "crabbox",
          operatingSystems: [
            { id: "linux", label: "Linux", default: true },
            { id: "macos", label: "macOS", disabledReason: reason },
            { id: "windows/wsl2", label: "Windows (WSL2)", disabledReason: reason },
          ],
        },
      ]),
    });
    const panel = container.querySelector(".new-session-page__cloud-configuration");
    expect(panel?.querySelector('[data-value="os:linux"]')).not.toBeNull();
    expect(
      panel?.querySelector('[data-value="os:macos"], [data-value="os:windows/wsl2"]'),
    ).toBeNull();
  });

  it.each([
    { os: undefined, machineClass: undefined, label: "aws", machine: "Tiny Linux" },
    { os: "linux", machineClass: "tiny", label: "aws", machine: "Tiny Linux" },
    {
      os: "windows/wsl2",
      machineClass: undefined,
      label: "aws",
      machine: "Tiny Windows",
    },
    {
      os: "windows/wsl2",
      machineClass: "tiny",
      label: "aws",
      machine: "Tiny Windows",
    },
  ])(
    "preserves $label while filtering its cloud card from search",
    ({ os, machineClass, label }) => {
      const container = renderPicker(
        true,
        undefined,
        {
          cloudProfileId: "aws",
          os,
          machineClass,
          cloudProfiles: [
            {
              id: "aws",
              providerId: "crabbox",
              operatingSystems: [
                { id: "linux", label: "Linux", default: true },
                { id: "windows/wsl2", label: "Windows (WSL2)" },
              ],
              machines: [
                { id: "tiny", label: "Tiny Linux", os: "linux", default: true },
                { id: "tiny", label: "Tiny Windows", os: "windows/wsl2", default: true },
                { id: "custom", label: "Custom" },
              ],
            },
          ],
        },
        { environmentQuery: "unmatched-environment" },
      );
      expect(container.querySelector('[data-value="cloud:aws"]')).toBeNull();
      expect(container.querySelector(".new-session-page__trigger-label")?.textContent).toBe(label);
      expect(container.querySelector("openclaw-select-picker")).toBeNull();
    },
  );
});
