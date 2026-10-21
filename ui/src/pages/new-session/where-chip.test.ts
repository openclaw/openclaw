/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { DraftEnvironment } from "./discovery.ts";
import { renderPicker } from "./where-chip.test-support.ts";

function device(id: string, label: string, overrides: Partial<DraftEnvironment> = {}) {
  return {
    id: `node:${id}`,
    type: "node",
    label,
    status: "available",
    sessionHost: true,
    workerSlots: { total: 2, available: 1 },
    ...overrides,
  } satisfies DraftEnvironment;
}

function option(container: ParentNode, value: string) {
  return container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
}

function hoverDetails(row: Element | null | undefined) {
  return Array.from(
    row
      ?.closest("openclaw-tooltip")
      ?.querySelectorAll('[slot="content"] > div, [slot="content"] > span') ?? [],
    (detail) => detail.textContent?.trim(),
  ).join(" · ");
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
  expect(
    Array.from(actual?.children ?? [], (child) => [child.tagName, child.getAttribute("d")]),
  ).toEqual(paths.map((path) => ["path", path]));
}

describe("Where chip", () => {
  it("offers the suggested Cloud profile with its provider icon before adoption", () => {
    const onAdoptSuggestedProfile = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { cloudProfiles: [] },
      {
        suggestedProfile: { id: "cloud", providerId: "crabbox", providerDisplayId: "aws" },
        onAdoptSuggestedProfile,
      },
    );
    const item = option(container, "suggested-cloud");
    expect(item?.textContent?.trim()).toBe("Cloud");
    expect(item?.querySelector('[data-provider-icon="aws"]')).not.toBeNull();
    expect(container.querySelector('[data-action="manage-cloud-workers"]')).toBeNull();
    item?.click();
    expect(onAdoptSuggestedProfile).toHaveBeenCalledOnce();
  });

  it.each([
    { isAdmin: false, profiles: [] },
    { isAdmin: true, profiles: [{ id: "configured", providerId: "crabbox" }] },
  ])(
    "does not offer a suggestion without admin authority or beside configured profiles: %j",
    ({ isAdmin, profiles }) => {
      const container = renderPicker(
        isAdmin,
        undefined,
        { cloudProfiles: profiles },
        {
          suggestedProfile: { id: "cloud", providerId: "crabbox", providerDisplayId: "aws" },
        },
      );
      expect(option(container, "suggested-cloud")).toBeNull();
    },
  );

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
    [
      "Work MacBook Pro",
      "darwin",
      "laptop",
      [
        "M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z",
        "M20.054 15.987H3.946",
      ],
    ],
    [
      "Office Mac-mini",
      "darwin",
      "mini",
      [
        "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
        "M21.946 12.013H2.054M6 16h.01M10 16h.01",
      ],
    ],
    [
      "Build Mac Studio",
      "macOS",
      "studio",
      ["m3 8 3-4h12l3 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M3 8h18M6 15h2M11 15h2M17 15h.01"],
    ],
  ] as const)(
    "uses the same device outline in the selected row and trigger: %s / %s",
    (label, platform, form, paths) => {
      const container = renderPicker(true, undefined, {
        deviceId: "model-device",
        environments: [device("model-device", label, { platform })],
      });

      for (const selector of [
        '[data-value="device:model-device"] .session-menu__icon',
        "#new-session-where-trigger .new-session-page__target-icon",
      ]) {
        expectIconShape(container.querySelector(`${selector} svg`), paths);
        const marker = container.querySelector(`${selector} .new-session-page__device-icon`);
        expect(marker?.getAttribute("data-form")).toBe(form);
      }
    },
  );

  it("places usable devices before disabled devices while preserving each group's order", () => {
    const container = renderPicker(true, undefined, {
      environments: [
        device("offline", "Offline", { status: "offline", workerSlots: undefined }),
        device("ready", "Ready"),
        device("busy", "Busy", { workerSlots: { total: 2, available: 0 } }),
        device("ready2", "Ready two"),
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
          device("zulu", "Zulu runner", { platform: "linux" }),
          device("alpha", "Alpha runner", { platform: "linux" }),
        ],
        cloudProfiles: [{ id: "linux-worker", providerId: "crabbox", trust: "persistent" }],
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
    expect(hoverDetails(option(container, "device:alpha"))).toContain("Linux");
  });

  it("keeps explicit destinations selectable while Auto is enabled", () => {
    const onSelectDevice = vi.fn();
    const onSelectCloudProfile = vi.fn();
    const onApplyCloudDefaults = vi.fn();
    const onEnvironmentQueryInput = vi.fn();
    const onConnectMachine = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { autoDevice: true },
      {
        onSelectDevice,
        onSelectCloudProfile,
        onApplyCloudDefaults,
        onEnvironmentQueryInput,
        onConnectMachine,
      },
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
    expect(onApplyCloudDefaults).toHaveBeenCalledExactlyOnceWith("aws");
    expect(onSelectCloudProfile).toHaveBeenCalledExactlyOnceWith("aws");

    expect(capacityCaption(option(container, "device:runner"))).toBe("1 of 2 session slots in use");

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

  it("preserves aws while filtering its cloud card from search", () => {
    const container = renderPicker(
      true,
      undefined,
      {
        cloudProfileId: "aws",
        os: "windows/wsl2",
        machineClass: "tiny",
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
    expect(option(container, "cloud:aws")).toBeNull();
    expect(container.querySelector(".new-session-page__trigger-label")?.textContent).toBe("aws");
    expect(container.querySelector(".new-session-page__trigger-summary")?.textContent).toBe(
      "Windows (WSL2) · Tiny Windows",
    );
    expect(container.querySelector("openclaw-select-picker")).toBeNull();
  });

  it("renders devices for writers while cloud and Connect remain admin-only", () => {
    const writer = renderPicker(false);
    const autoRow = option(writer, "auto-device");
    expect(autoRow?.querySelector(".session-menu__text")?.textContent).toBe("Any available device");
    expect(autoRow?.tagName).toBe("BUTTON");
    expect(autoRow?.getAttribute("aria-pressed")).toBe("false");
    expect(hoverDetails(autoRow)).toContain("Chooses the least-busy connected device");
    const remoteExec = renderPicker(false, "eligible-order");
    expect(hoverDetails(option(remoteExec, "auto-device"))).toContain(
      "Chooses the first eligible connected device",
    );
    expect(option(writer, "device:runner")).not.toBeNull();
    expect(option(writer, "device:runner")?.querySelector(".session-menu__sub")).toBeNull();
    expect(hoverDetails(option(writer, "device:alpha-device"))).toContain("alpha-de");
    expect(hoverDetails(option(writer, "device:beta-device"))).toContain("beta-dev");
    expect(writer.querySelector(".session-menu__sub, .session-menu__description")).toBeNull();
    expect(option(writer, "cloud:aws")).toBeNull();
    expect(writer.querySelector('[data-action="connect-machine"]')).toBeNull();

    const admin = renderPicker(true);
    expect(option(admin, "device:runner")).not.toBeNull();
    expect(option(admin, "cloud:aws")).not.toBeNull();
    expect(admin.querySelector('[data-action="connect-machine"]')).not.toBeNull();
  });

  it("disables device placements when the selected runtime cannot dispatch to devices", () => {
    const container = renderPicker(true, undefined, {
      environments: [device("macbook", "MacBook", { workerSlots: { total: 1, available: 1 } })],
      cloudProfiles: [],
      deviceDisabledReason: "This runtime does not support paired devices",
    });

    const row = option(container, "device:macbook");
    expect(row?.matches(':disabled, [aria-disabled="true"]')).toBe(true);
    expect(row?.querySelector(".session-menu__description")).toBeNull();
    // Unavailable cards show only the actionable reason.
    expect(capacityCaption(row)).toBeUndefined();
    expect(hoverDetails(row)).toContain("This runtime does not support paired devices");
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
        device("other", "Other", { status: "offline", sessionHost: false, workerSlots: undefined }),
        device("macbook", "MacBook", { sessionHost: false, workerSlots: undefined, issues }),
      ],
      cloudProfiles: [],
    });

    const automatic = option(container, "auto-device");
    expect(automatic?.disabled).toBe(true);
    expect(hoverDetails(automatic)).toMatch(reason);
    expect(automatic?.querySelector(".session-menu__description")).toBeNull();
  });

  it.each([
    {
      name: "allows enabled remote execution without a free worker slot",
      workerSlots: { total: 1, available: 0 },
      invocableCommands: ["codex.exec-server.stdio.v1"],
      state: "invocable" as const,
      disabled: false,
      label: "1 of 1 session slots in use",
    },
    {
      name: "disables a declared remote command that the Gateway has not enabled",
      workerSlots: { total: 1, available: 1 },
      invocableCommands: [],
      state: "unauthorized" as const,
      disabled: true,
      reason:
        "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
    },
  ])("$name", ({ workerSlots, invocableCommands, state, disabled, reason, label }) => {
    const container = renderPicker(true, undefined, {
      environments: [
        device("runner", "Build runner", {
          workerSlots,
          capabilities: ["codex.exec-server.stdio.v1"],
          invocableCommands,
          requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state },
        }),
      ],
      cloudProfiles: [],
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
    });

    const row = option(container, "device:runner");
    expect(row?.matches(':disabled, [aria-disabled="true"]')).toBe(disabled);
    expect(capacityCaption(row)).toBe(disabled ? undefined : label);
    if (reason) {
      expect(hoverDetails(row)).toContain(reason);
    }
  });
});
