/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  capacityCaption,
  hoverDetails,
  renderPicker,
} from "../../test-helpers/new-session-where-chip.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

describe("Where chip selection", () => {
  it("keeps concurrent session details and reserves the checkmark column when selecting a device", () => {
    const container = renderPicker(true, undefined, { deviceId: "runner" });
    const selected = container.querySelector('[data-value="device:runner"]');
    const unselected = container.querySelector('[data-value="device:alpha-device"]');

    expect(capacityCaption(selected)).toBe("1 of 2 session slots in use");
    expect(selected?.querySelector(".session-menu__check svg")).not.toBeNull();
    expect(capacityCaption(unselected)).toBe("0 of 1 session slots in use");
    expect(unselected?.querySelector(".session-menu__check")).not.toBeNull();
    expect(unselected?.querySelector(".session-menu__check svg")).toBeNull();
  });

  it.each([false, true])("selects automatic placement when currently %s", (autoDevice) => {
    const onSelectDevice = vi.fn();
    const onSelectAutoDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      { autoDevice },
      { onSelectDevice, onSelectAutoDevice },
    );
    const automatic = container.querySelector<HTMLButtonElement>('[data-value="auto-device"]')!;

    expect(automatic.getAttribute("data-popover")).toBe("close");
    expect(automatic.getAttribute("aria-pressed")).toBe(String(autoDevice));
    expect(hoverDetails(automatic)).toContain("Chooses the least-busy connected device");
    expect(automatic.querySelector(".session-menu__description")).toBeNull();
    automatic.click();

    expect(onSelectAutoDevice).toHaveBeenCalledOnce();
    expect(onSelectDevice).not.toHaveBeenCalled();
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

    expect(container.querySelector('[data-value="connect-machine"]')).toBeNull();
  });

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
