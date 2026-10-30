/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { PopoverHandle } from "../../components/solid/popover.tsx";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DraftEnvironment } from "./discovery.ts";
import { pickerParams, renderPicker } from "./where-chip.test-support.ts";
import { WhereChip } from "./where-chip.tsx";

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

function fields(container: ParentNode) {
  return {
    trigger: expectDefined(
      container.querySelector<HTMLButtonElement>("#new-session-where-trigger"),
      "Where trigger",
    ),
    search: expectDefined(
      container.querySelector<HTMLInputElement>('input[type="search"]'),
      "environment search",
    ),
  };
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

describe("Where chip", () => {
  it("loads the menu on first open, focuses its search, and retains it after closing", async () => {
    const props = pickerParams(true);
    vi.spyOn(props.params.place.browser, "popoverOpen").mockReturnValue(false);
    const hostedEnvironments = vi.spyOn(props.params.place.modelControl, "hostedEnvironments");
    hostedEnvironments.mockClear();
    let picker: PopoverHandle | undefined;
    const { container } = mountSolid(() =>
      createComponent(WhereChip, {
        ...props,
        ref: (handle) => {
          picker = handle;
        },
      }),
    );
    expect(container.querySelector(".new-session-page__environment-list")).toBeNull();
    expect(hostedEnvironments).not.toHaveBeenCalled();
    const trigger = expectDefined(
      container.querySelector<HTMLButtonElement>("#new-session-where-trigger"),
      "Where trigger",
    );
    trigger.focus();
    trigger.click();
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(container.querySelector(".new-session-page__environment-list")).not.toBeNull(),
    );
    const { search } = fields(container);
    expect(document.activeElement).toBe(search);
    picker?.hide();
    picker?.show();
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(container.querySelector("#new-session-where-trigger")).toBe(trigger);
  });

  it("offers the suggested Cloud profile with its provider icon before adoption", async () => {
    const onAdoptSuggestedProfile = vi.fn();
    const container = await renderPicker(
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
    async ({ isAdmin, profiles }) => {
      const container = await renderPicker(
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

  it("keeps the trigger and focused search through a delayed first catalog read", async () => {
    const completion = createDeferred();
    const container = await renderPicker(
      true,
      undefined,
      { environments: null, cloudProfiles: [] },
      { catalogRead: completion.promise },
    );
    await waitForSolid(() =>
      expect(container.querySelectorAll(".new-session-page__environment-skeletons")).toHaveLength(
        2,
      ),
    );
    expect(container.querySelector('[data-section="devices"]')).not.toBeNull();
    expect(container.querySelector('[data-section="cloud"]')).not.toBeNull();
    const { trigger, search } = fields(container);
    expect(trigger.disabled).toBe(false);
    expect(container.querySelector('[data-action="manage-cloud-workers"]')).toBeNull();
    search.focus();
    completion.resolve();
    await waitForSolid(() =>
      expect(container.querySelectorAll(".new-session-page__environment-skeletons")).toHaveLength(
        0,
      ),
    );
    expect(container.querySelector("#new-session-where-trigger")).toBe(trigger);
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["Work MacBook Pro", "darwin", "laptop"],
    ["Office Mac-mini", "darwin", "mini"],
    ["Build Mac Studio", "macOS", "studio"],
  ] as const)(
    "uses the same device outline in the selected row and trigger: %s / %s",
    async (label, platform, form) => {
      const container = await renderPicker(true, undefined, {
        deviceId: "model-device",
        environments: [device("model-device", label, { platform })],
      });

      for (const selector of [
        '[data-value="device:model-device"] .session-menu__icon',
        "#new-session-where-trigger .new-session-page__target-icon",
      ]) {
        const marker = container.querySelector(`${selector} .new-session-page__device-icon`);
        expect(marker?.getAttribute("data-form")).toBe(form);
        expect(marker?.querySelector("svg path")).not.toBeNull();
      }
    },
  );

  it("places usable devices before disabled devices while preserving each group's order", async () => {
    const container = await renderPicker(true, undefined, {
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

  it("keeps matching Local, Devices and Cloud in order with device facts searchable", async () => {
    const container = await renderPicker(
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

  it("keeps explicit destinations selectable while Auto is enabled", async () => {
    const onSelectDevice = vi.fn();
    const onSelectCloudProfile = vi.fn();
    const onApplyCloudDefaults = vi.fn();
    const onEnvironmentQueryInput = vi.fn();
    const onConnectMachine = vi.fn();
    const container = await renderPicker(
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

    for (const destination of destinations) {
      expect(destination.disabled).toBe(false);
      destination.click();
    }
    expect(onSelectDevice).toHaveBeenCalledWith("runner");
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

  it("preserves aws while filtering its cloud card from search", async () => {
    const container = await renderPicker(
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

  it("renders granted cloud profiles for writers while Connect and setup remain admin-only", async () => {
    const writer = await renderPicker(false);
    const autoRow = option(writer, "auto-device");
    expect(autoRow?.getAttribute("aria-pressed")).toBe("false");
    expect(hoverDetails(autoRow)).toContain("Chooses the least-busy connected device");
    expect(option(writer, "device:runner")).not.toBeNull();
    expect(writer.querySelector(".session-menu__sub, .session-menu__description")).toBeNull();
    expect(option(writer, "cloud:aws")).not.toBeNull();
    expect(writer.querySelector('[data-action="connect-machine"]')).toBeNull();
    expect(writer.querySelector('[data-action="manage-cloud-workers"]')).toBeNull();

    const admin = await renderPicker(true);
    expect(option(admin, "cloud:aws")).not.toBeNull();
    expect(admin.querySelector('[data-action="connect-machine"]')).not.toBeNull();
  });

  it("disables device placements when the selected runtime cannot dispatch to devices", async () => {
    const container = await renderPicker(true, undefined, {
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

  it.each<[DraftEnvironment["issues"], RegExp]>([
    [undefined, /no devices have session hosting enabled/i],
    [
      [
        {
          code: "update-required",
          action: "update-and-reconnect",
          updateCommand: "openclaw update",
          headlessReconnectCommand: "openclaw node restart",
        },
      ],
      /openclaw update.*openclaw node restart/i,
    ],
  ])("disables automatic selection with actionable remediation for %j", async (issues, reason) => {
    const container = await renderPicker(false, undefined, {
      environments: [
        device("other", "Other", {
          status: "offline",
          sessionHost: false,
          workerSlots: undefined,
        }),
        device("macbook", "MacBook", { sessionHost: false, workerSlots: undefined, issues }),
      ],
      cloudProfiles: [],
    });

    const automatic = option(container, "auto-device");
    expect(automatic?.disabled).toBe(true);
    expect(hoverDetails(automatic)).toMatch(reason);
    expect(automatic?.querySelector(".session-menu__description")).toBeNull();
  });

  it.each(["invocable", "unauthorized"] as const)(
    "gates remote execution on %s command authority, not capacity",
    async (state) => {
      const disabled = state === "unauthorized";
      const container = await renderPicker(true, undefined, {
        environments: [
          device("runner", "Build runner", {
            workerSlots: { total: 1, available: disabled ? 1 : 0 },
            capabilities: ["codex.exec-server.stdio.v1"],
            invocableCommands: disabled ? [] : ["codex.exec-server.stdio.v1"],
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
      expect(capacityCaption(row)).toBe(disabled ? undefined : "1 of 1 session slots in use");
      if (disabled) {
        expect(hoverDetails(row)).toContain(
          "Authorize codex.exec-server.stdio.v1 in the Gateway node command policy, or pick another device.",
        );
      }
    },
  );
});
