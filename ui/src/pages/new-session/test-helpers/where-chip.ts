import { render } from "lit";
import { vi } from "vitest";
import { renderWhereChip, resolveWhereChip } from "../where-chip.ts";

export function hoverDetails(row: Element | null | undefined) {
  return [
    ...(row
      ?.closest("openclaw-tooltip")
      ?.querySelectorAll('[slot="content"] > div, [slot="content"] > span') ?? []),
  ]
    .map((detail) => detail.textContent?.trim())
    .join(" · ");
}

export function capacityCaption(row: Element | null | undefined) {
  return row
    ?.closest("openclaw-tooltip")
    ?.querySelector(".new-session-page__capacity-caption")
    ?.textContent?.trim();
}

export function renderPicker(
  isAdmin: boolean,
  autoPlacementMode?: "least-busy" | "eligible-order",
  selection: Partial<Parameters<typeof resolveWhereChip>[0]> = {},
  presentation: Partial<Parameters<typeof renderWhereChip>[0]> = {},
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
  const container = document.createElement("div");
  render(
    renderWhereChip({
      state,
      gatewayName: "",
      environmentQuery: "",
      onEnvironmentQueryInput: vi.fn(),
      cloudProfileId: selection.cloudProfileId ?? "",
      deviceId: selection.deviceId ?? "",
      autoDevice: selection.autoDevice,
      worktreeAvailable: true,
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
    }),
    container,
  );
  return container;
}
