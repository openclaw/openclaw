/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { readDraftCloudProfiles } from "./discovery.ts";
import { renderPicker } from "./where-chip.test-support.ts";

function hoverDetails(row: Element | null | undefined) {
  return [
    ...(row
      ?.closest("openclaw-tooltip")
      ?.querySelectorAll('[slot="content"] > div, [slot="content"] > span') ?? []),
  ]
    .map((detail) => detail.textContent?.trim())
    .join(" · ");
}

function capacityCaption(row: Element | null | undefined) {
  return row
    ?.closest("openclaw-tooltip")
    ?.querySelector(".new-session-page__capacity-caption")
    ?.textContent?.trim();
}

function expectIconShape(actual: SVGElement | null, paths: readonly string[]) {
  expect(actual).not.toBeNull();
  for (const [attribute, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  })) {
    expect(actual?.getAttribute(attribute)).toBe(value);
  }
  expect(Array.from(actual?.children ?? [], (child) => child.tagName)).toEqual(
    paths.map(() => "path"),
  );
  expect(Array.from(actual?.children ?? [], (child) => child.getAttribute("d"))).toEqual(paths);
}

describe("Where chip", () => {
  it("shows device and cloud skeletons while the catalog loads", () => {
    const container = renderPicker(
      true,
      undefined,
      { environments: null, cloudProfiles: [] },
      { catalogLoading: true },
    );
    expect(container.querySelectorAll(".new-session-page__environment-skeletons")).toHaveLength(2);
    expect(container.querySelector('[data-section="devices"]')).not.toBeNull();
    expect(container.querySelector('[data-section="cloud"]')).not.toBeNull();
  });

  it.each([
    {
      label: "Work MacBook Pro",
      platform: "darwin",
      form: "laptop",
      paths: [
        "M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z",
        "M20.054 15.987H3.946",
      ],
    },
    {
      label: "Office Mac-mini",
      platform: "darwin",
      form: "mini",
      paths: [
        "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
        "M21.946 12.013H2.054M6 16h.01M10 16h.01",
      ],
    },
    {
      label: "Build Mac Studio",
      platform: "macOS",
      form: "studio",
      paths: [
        "m3 8 3-4h12l3 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
        "M3 8h18M6 15h2M11 15h2M17 15h.01",
      ],
    },
  ])(
    "uses the same device outline in the selected row and trigger: $label / $platform",
    ({ label, platform, paths, form }) => {
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

      expectIconShape(
        container.querySelector('[data-value="device:model-device"] .session-menu__icon svg'),
        paths,
      );
      expectIconShape(
        container.querySelector("#new-session-where-trigger .new-session-page__target-icon svg"),
        paths,
      );
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
    { query: "device", expected: ["device:runner", "device:alpha-device", "device:beta-device"] },
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

  it("keeps explicit destinations selectable while Auto is enabled", () => {
    const onSelectDevice = vi.fn();
    const onSelectCloudProfile = vi.fn();
    const onEnvironmentQueryInput = vi.fn();
    const onConnectMachine = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { autoDevice: true },
      { onSelectDevice, onSelectCloudProfile, onEnvironmentQueryInput, onConnectMachine },
    );
    const destinations = container.querySelectorAll<HTMLButtonElement>(
      '.new-session-page__environment-list [data-value]:not([data-value="auto-device"])',
    );

    expect(destinations).toHaveLength(5);
    for (const destination of destinations) {
      expect(destination.disabled).toBe(false);
      destination.click();
    }
    expect(onSelectDevice).toHaveBeenCalledTimes(4);
    expect(onSelectCloudProfile).toHaveBeenCalledExactlyOnceWith("aws", true);

    expect(capacityCaption(container.querySelector('[data-value="device:runner"]'))).toBe(
      "1 of 2 session slots in use",
    );

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.disabled).toBe(false);
    search.value = "cloud";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onEnvironmentQueryInput).toHaveBeenCalledExactlyOnceWith("cloud");

    const connect = container.querySelector<HTMLButtonElement>('[data-action="connect-machine"]')!;
    expect(connect.disabled).toBe(false);
    connect.click();
    expect(onConnectMachine).toHaveBeenCalledOnce();
  });

  it.each([true])("preserves destination eligibility with Auto set to %s", (autoDevice) => {
    const container = renderPicker(
      true,
      undefined,
      {
        autoDevice,
        environments: [
          {
            id: "node:ready",
            type: "node",
            label: "Ready runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
          {
            id: "node:offline",
            type: "node",
            label: "Offline runner",
            status: "unavailable",
            sessionHost: true,
            workerSlots: { total: 2, available: 1 },
          },
        ],
        cloudProfiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "blocked", providerId: "static-ssh" },
        ],
      },
      {
        cloudProfileDisabledReason: (profile) =>
          profile.id === "blocked" ? "Runtime unavailable" : undefined,
      },
    );

    for (const value of ["gateway", "device:ready", "cloud:aws"]) {
      expect(
        container
          .querySelector<HTMLButtonElement>(`[data-value="${value}"]`)
          ?.matches(':disabled, [aria-disabled="true"]'),
      ).toBe(false);
    }
    for (const value of ["device:offline", "cloud:blocked"]) {
      expect(
        container
          .querySelector<HTMLButtonElement>(`[data-value="${value}"]`)
          ?.matches(':disabled, [aria-disabled="true"]'),
      ).toBe(true);
    }
    expect(container.querySelector('[data-value="gateway"]')?.getAttribute("aria-pressed")).toBe(
      String(!autoDevice),
    );
  });

  it.each([
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
      expect(
        container
          .querySelector("#new-session-where-trigger")
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toBe(expectedOs === "linux" ? "aws Linux · Small" : "aws Windows · Large");
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
    const reason = "Upgrade Crabbox to enable this operating system.";
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
    {
      os: "windows/wsl2",
      machineClass: "tiny",
      label: "aws",
      machine: "Tiny Windows",
    },
  ])(
    "preserves $label while filtering its cloud card from search",
    ({ os, machineClass, label, machine }) => {
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
      expect(container.querySelector(".new-session-page__trigger-summary")?.textContent).toBe(
        `${os === "windows/wsl2" ? "Windows (WSL2)" : "Linux"} · ${machine}`,
      );
      expect(container.querySelector("openclaw-select-picker")).toBeNull();
    },
  );

  it.each([
    { id: "gcp", os: "windows/wsl2", osLabel: "Windows (WSL2)", size: "beast", sizeLabel: "Beast" },
  ])(
    "shows catalog labels for $id / $os / $size without provider-specific logic",
    ({ id, os, osLabel, size, sizeLabel }) => {
      const container = renderPicker(true, undefined, {
        cloudProfileId: id,
        cloudProfiles: [
          {
            id,
            providerId: "test-provider",
            operatingSystems: [{ id: os, label: osLabel }],
            machines: [{ id: size, label: sizeLabel, os }],
          },
        ],
      });
      const trigger = container.querySelector("#new-session-where-trigger");
      expect(trigger?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        `${id} ${osLabel} · ${sizeLabel}`,
      );
      expect(trigger?.getAttribute("aria-label")).toContain(`${id}, ${osLabel} · ${sizeLabel}`);
    },
  );

  it.each([
    {
      operatingSystems: undefined,
      machines: [{ id: "small", label: "Small" }],
      summary: "Small",
    },
  ])("shows only reported cloud metadata: $summary", ({ operatingSystems, machines, summary }) => {
    const container = renderPicker(true, undefined, {
      cloudProfileId: "custom",
      cloudProfiles: [{ id: "custom", providerId: "test-provider", operatingSystems, machines }],
    });
    expect(container.querySelector(".new-session-page__trigger-label")?.textContent).toBe("custom");
    expect(container.querySelector(".new-session-page__trigger-summary")?.textContent ?? null).toBe(
      summary,
    );
  });

  it("renders devices for writers while cloud and Connect remain admin-only", () => {
    const writer = renderPicker(false);
    const autoRow = writer.querySelector('[data-value="auto-device"]');
    expect(autoRow?.querySelector(".session-menu__text")?.textContent).toBe("Any available device");
    expect(autoRow?.tagName).toBe("BUTTON");
    expect(autoRow?.getAttribute("aria-pressed")).toBe("false");
    expect(hoverDetails(autoRow)).toContain("Chooses the least-busy connected device");
    const remoteExec = renderPicker(false, "eligible-order");
    expect(hoverDetails(remoteExec.querySelector('[data-value="auto-device"]'))).toContain(
      "Chooses the first eligible connected device",
    );
    expect(writer.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(writer.querySelector('[data-value="device:runner"] .session-menu__sub')).toBeNull();
    expect(hoverDetails(writer.querySelector('[data-value="device:alpha-device"]'))).toContain(
      "alpha-de",
    );
    expect(hoverDetails(writer.querySelector('[data-value="device:beta-device"]'))).toContain(
      "beta-dev",
    );
    expect(writer.querySelector(".session-menu__sub, .session-menu__description")).toBeNull();
    expect(writer.querySelector('[data-value="cloud:aws"]')).toBeNull();
    expect(writer.querySelector('[data-action="connect-machine"]')).toBeNull();

    const admin = renderPicker(true);
    expect(admin.querySelector('[data-value="device:runner"]')).not.toBeNull();
    expect(admin.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(admin.querySelector('[data-action="connect-machine"]')).not.toBeNull();
  });

  it("disables device placements when the selected runtime cannot dispatch to devices", () => {
    const container = renderPicker(true, undefined, {
      environments: [
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 1, available: 1 },
        },
      ],
      cloudProfiles: [],
      deviceDisabledReason: "This runtime does not support paired devices",
    });

    const device = container.querySelector<HTMLButtonElement>('[data-value="device:macbook"]');
    expect(device?.matches(':disabled, [aria-disabled="true"]')).toBe(true);
    expect(device?.querySelector(".session-menu__description")).toBeNull();
    // Unavailable cards show only the actionable reason.
    expect(capacityCaption(device)).toBeUndefined();
    expect(hoverDetails(device)).toContain("This runtime does not support paired devices");
  });

  it.each([
    {
      name: "no paired device hosts sessions",
      issues: undefined,
      reason: /no devices have session hosting enabled/i,
    },
    {
      name: "a paired node must be updated before it can advertise session hosting",
      issues: [
        {
          code: "update-required",
          action: "update-and-reconnect",
          updateCommand: "openclaw update",
          headlessReconnectCommand: "openclaw node restart",
        } as const,
      ],
      reason: /openclaw update.*openclaw node restart/i,
    },
  ])("disables automatic selection with an actionable reason when $name", ({ issues, reason }) => {
    const container = renderPicker(false, undefined, {
      environments: [
        { id: "node:other", type: "node", label: "Other", status: "offline", sessionHost: false },
        {
          id: "node:macbook",
          type: "node",
          label: "MacBook",
          status: "available",
          sessionHost: false,
          ...(issues ? { issues } : {}),
        },
      ],
      cloudProfiles: [],
    });

    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]');
    expect(automatic?.disabled).toBe(true);
    expect(hoverDetails(automatic)).toMatch(reason);
    expect(automatic?.querySelector(".session-menu__description")).toBeNull();
  });

  it.each([
    {
      name: "allows enabled remote execution without a free worker slot",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: ["codex.exec-server.stdio.v1"],
      commandState: "invocable" as const,
      disabled: false,
      label: "1 of 1 session slots in use",
    },
    {
      name: "disables a declared remote command that the Gateway has not enabled",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: { total: 1, available: 1 },
      invocableCommands: [],
      commandState: "unauthorized" as const,
      disabled: true,
      reason:
        "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
      label: "Slot utilization unavailable",
    },
  ])(
    "$name in the New Session picker",
    ({
      devicePlacement,
      workerSlots,
      invocableCommands,
      commandState,
      disabled,
      reason,
      label,
    }) => {
      const container = renderPicker(true, undefined, {
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots,
            capabilities: ["codex.exec-server.stdio.v1"],
            invocableCommands,
            ...(commandState
              ? {
                  requiredNodeCommand: {
                    command: "codex.exec-server.stdio.v1",
                    state: commandState,
                  },
                }
              : {}),
          },
        ],
        cloudProfiles: [],
        devicePlacement,
      });

      const device = container.querySelector<HTMLButtonElement>('[data-value="device:runner"]');
      expect(device?.matches(':disabled, [aria-disabled="true"]')).toBe(disabled);
      expect(capacityCaption(device)).toBe(disabled ? undefined : label);
      if (reason) {
        expect(hoverDetails(device)).toContain(reason);
      }
    },
  );
});
