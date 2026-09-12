/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { capacityCaption, hoverDetails } from "./where-chip.test-helpers.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

describe("Where chip", () => {
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
