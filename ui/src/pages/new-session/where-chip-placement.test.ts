/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { readDraftCloudProfiles } from "./discovery.ts";
import { capacityCaption, hoverDetails, renderPicker } from "./test-helpers/where-chip.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

describe("Where chip", () => {
  it.each([true, false])("preserves destination eligibility with Auto set to %s", (autoDevice) => {
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
    { submitting: false, pendingPlacement: false, disabled: false },
    { submitting: true, pendingPlacement: false, disabled: true },
    { submitting: false, pendingPlacement: true, disabled: true },
  ])("keeps Auto hidden with no devices regardless of pending submission: %j", (presentation) => {
    const onSelectAutoDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { environments: [], autoDevice: true },
      { ...presentation, onSelectAutoDevice },
    );
    expect(container.querySelector('[data-value="auto-device"]')).toBeNull();
    expect(onSelectAutoDevice).not.toHaveBeenCalled();
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

  it("shows a session-slot caption without capacity bars", () => {
    const state = resolveWhereChip({
      environments: [
        {
          id: "node:runner",
          type: "node",
          label: "Build runner",
          status: "available",
          sessionHost: true,
          workerSlots: { total: 2, available: 1 },
        },
      ],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "runner",
    });

    expect(state.kind).toBe("device");
    expect(state.label).toBe("Build runner");
    const row = renderPicker(false).querySelector('[data-value="device:runner"]');
    expect(capacityCaption(row)).toBe("1 of 2 session slots in use");
    expect(row?.textContent).not.toContain("Worker slots");
    expect(state.devices[0]?.workerSlots).toEqual({ total: 2, available: 1 });
    expect(state.devices[0]?.facts).toEqual([]);
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
    const state = resolveWhereChip({
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
      cloudProfileId: "",
      deviceId: "",
      deviceDisabledReason: "This runtime does not support paired devices",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: true,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onSelectDevice: () => undefined,
        onSelectAutoDevice: () => undefined,
        onSelectCloudProfile: () => undefined,
        onConnectMachine: () => undefined,
        onManageCloudWorkers: () => undefined,
      }),
      container,
    );

    const device = container.querySelector<HTMLButtonElement>('[data-value="device:macbook"]');
    expect(device?.matches(':disabled, [aria-disabled="true"]')).toBe(true);
    expect(device?.querySelector(".session-menu__description")).toBeNull();
    // Unavailable cards show only the actionable reason.
    expect(capacityCaption(device)).toBeUndefined();
    expect(hoverDetails(device)).toContain("This runtime does not support paired devices");
  });

  it("omits automatic placement when no devices are paired and Auto is off", () => {
    const state = resolveWhereChip({
      environments: [],
      cloudProfiles: [],
      cloudProfileId: "",
      deviceId: "",
    });
    const emptyContainer = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onSelectAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
        onManageCloudWorkers: () => undefined,
      }),
      emptyContainer,
    );
    expect(emptyContainer.querySelector('[data-value="auto-device"]')).toBeNull();
  });

  it.each([
    {
      name: "no paired device hosts sessions",
      issues: undefined,
      reason: /no session hosts are paired/i,
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
    const state = resolveWhereChip({
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
      cloudProfileId: "",
      deviceId: "",
    });
    const container = document.createElement("div");
    render(
      renderWhereChip({
        state,
        gatewayName: "",
        environmentQuery: "",
        onEnvironmentQueryInput: vi.fn(),
        cloudProfileId: "",
        deviceId: "",
        worktreeAvailable: true,
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        isAdmin: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectDevice: vi.fn(),
        onSelectAutoDevice: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onConnectMachine: vi.fn(),
        onManageCloudWorkers: () => undefined,
      }),
      container,
    );

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
      name: "shows slot-less remote execution without a capacity claim",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
      workerSlots: undefined,
      invocableCommands: ["codex.exec-server.stdio.v1"],
      commandState: "invocable" as const,
      disabled: false,
      label: undefined,
    },
    {
      name: "keeps worker execution capacity-gated",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      workerSlots: { total: 1, available: 0 },
      invocableCommands: [],
      commandState: undefined,
      disabled: true,
      reason: "No worker slots are available. Wait for a slot or pick another device.",
      label: "Slot utilization unavailable",
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
      const state = resolveWhereChip({
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
        cloudProfileId: "",
        deviceId: "",
        devicePlacement,
      });
      const container = document.createElement("div");
      render(
        renderWhereChip({
          state,
          gatewayName: "",
          environmentQuery: "",
          onEnvironmentQueryInput: vi.fn(),
          cloudProfileId: "",
          deviceId: "",
          worktreeAvailable: true,
          submitting: false,
          pendingPlacement: false,
          popoverOpen: true,
          popoverHiding: false,
          isAdmin: true,
          onGuardTransition: vi.fn(),
          onPopoverShow: vi.fn(),
          onPopoverHide: vi.fn(),
          onPopoverAfterHide: vi.fn(),
          onSelectDevice: vi.fn(),
          onSelectAutoDevice: vi.fn(),
          onSelectCloudProfile: vi.fn(),
          onConnectMachine: vi.fn(),
          onManageCloudWorkers: () => undefined,
        }),
        container,
      );

      const device = container.querySelector<HTMLButtonElement>('[data-value="device:runner"]');
      expect(device?.matches(':disabled, [aria-disabled="true"]')).toBe(disabled);
      expect(capacityCaption(device)).toBe(disabled ? undefined : label);
      if (reason) {
        expect(hoverDetails(device)).toContain(reason);
      }
    },
  );
});
