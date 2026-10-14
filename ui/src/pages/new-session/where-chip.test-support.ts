import { createComponent } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { resolveWhereChip, type WhereChipOptions } from "./where-chip.ts";
import { WhereChip } from "./where-chip.tsx";

export function pickerParams(
  isAdmin: boolean,
  autoPlacementMode?: "least-busy" | "eligible-order",
  selection: Partial<Parameters<typeof resolveWhereChip>[0]> = {},
  presentation: Partial<WhereChipOptions> = {},
) {
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
      {
        id: "node:alpha-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
      {
        id: "node:beta-device",
        type: "node",
        label: "Duplicate runner",
        status: "available",
        sessionHost: true,
        workerSlots: { total: 1, available: 1 },
      },
    ],
    cloudProfiles: [{ id: "aws", providerId: "crabbox" }],
    cloudProfileId: "",
    deviceId: "",
    ...selection,
  });
  return {
    state,
    gatewayName: "",
    environmentQuery: "",
    onEnvironmentQueryInput: vi.fn(),
    cloudProfileId: selection.cloudProfileId ?? "",
    deviceId: selection.deviceId ?? "",
    autoDevice: selection.autoDevice,
    submitting: false,
    pendingPlacement: false,
    popoverOpen: true,
    popoverHiding: false,
    isAdmin,
    ...(autoPlacementMode ? { autoPlacementMode } : {}),
    onGuardTransition: vi.fn(),
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
    onSelectDevice: vi.fn(),
    onSelectAutoDevice: vi.fn(),
    onSelectCloudProfile: vi.fn(),
    onConnectMachine: vi.fn(),
    onManageCloudWorkers: vi.fn(),
    ...presentation,
  };
}

export function renderPicker(...args: Parameters<typeof pickerParams>) {
  return mountSolid(() => createComponent(WhereChip, { params: pickerParams(...args) })).container;
}
