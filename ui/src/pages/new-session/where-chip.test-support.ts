import { createComponent } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import * as hosted from "./hosted-environments.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";
import { resolveWhereChip } from "./where-chip.ts";
import { WhereChip } from "./where-chip.tsx";

type PickerPresentation = {
  gatewayName?: string;
  environmentQuery?: string;
  suggestedProfile?: NewSessionPlaceControlsOptions["gateway"]["suggestedProfile"];
  catalogRead?: Promise<void>;
  onEnvironmentQueryInput?: (query: string) => void;
  onSelectDevice?: (id: string) => void;
  onSelectCloudProfile?: (id: string) => void;
  onApplyCloudDefaults?: (id: string) => void;
  onConnectMachine?: () => void;
  onAdoptSuggestedProfile?: () => void;
  cloudProfileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
};

export function pickerParams(
  isAdmin: boolean,
  autoPlacementMode?: "least-busy" | "eligible-order",
  selection: Partial<Parameters<typeof resolveWhereChip>[0]> = {},
  presentation: PickerPresentation = {},
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
  const { state: place, browser, gateway } = createRepositoryFixture();
  Object.defineProperties(place, {
    cloudProfileId: { get: () => selection.cloudProfileId ?? "" },
    deviceId: { get: () => selection.deviceId ?? "" },
    autoDevice: { get: () => selection.autoDevice ?? false },
    cloudSelection: { get: () => ({ os: selection.os, machineClass: selection.machineClass }) },
  });
  vi.spyOn(place, "isAdmin").mockReturnValue(isAdmin);
  vi.spyOn(place, "canWrite").mockReturnValue(true);
  vi.spyOn(place.modelControl, "hostedEnvironments").mockReturnValue([]);
  vi.spyOn(place.modelControl, "hostedEnvironmentsLoading").mockReturnValue(false);
  vi.spyOn(place.modelControl, "hostEnvironmentRuntime").mockReturnValue(undefined);
  vi.spyOn(place.modelControl, "resolveAgentRuntime").mockReturnValue(undefined);
  vi.spyOn(place.modelControl, "hostEnvironmentDisabledReason").mockReturnValue(undefined);
  vi.spyOn(place.modelControl, "autoPlacementSelectionMode").mockReturnValue(
    autoPlacementMode ?? "least-busy",
  );
  vi.spyOn(place, "selectDevice").mockImplementation(presentation.onSelectDevice ?? vi.fn());
  vi.spyOn(place, "selectCloudProfile").mockImplementation(
    presentation.onSelectCloudProfile ?? vi.fn(),
  );
  vi.spyOn(place.cloudMachines, "applyPending").mockImplementation(
    presentation.onApplyCloudDefaults ?? vi.fn(),
  );
  vi.spyOn(place.suggestedCloudProfile, "adopt").mockImplementation(async () =>
    presentation.onAdoptSuggestedProfile?.(),
  );
  vi.spyOn(browser, "environmentQuery", "get").mockReturnValue(presentation.environmentQuery ?? "");
  vi.spyOn(browser, "changeEnvironmentQuery").mockImplementation(
    presentation.onEnvironmentQueryInput ?? vi.fn(),
  );
  vi.spyOn(browser, "popoverOpen").mockReturnValue(true);
  vi.spyOn(browser, "popoverCallbacks").mockReturnValue({
    popoverOpen: true,
    onPopoverShow: vi.fn(),
    onPopoverHide: vi.fn(),
    onPopoverAfterHide: vi.fn(),
  });
  Object.defineProperties(gateway, {
    gatewayName: { value: presentation.gatewayName ?? "" },
    suggestedProfile: { value: presentation.suggestedProfile },
    cloudProfilesRead: { value: presentation.catalogRead },
  });
  if (presentation.cloudProfileDisabledReason) {
    const original = hosted.environmentCloudDisabledReason;
    vi.spyOn(hosted, "environmentCloudDisabledReason").mockImplementation((control, profile) =>
      control === place.modelControl && profile
        ? presentation.cloudProfileDisabledReason!(profile)
        : original(control, profile),
    );
  }
  const params: NewSessionPlaceControlsOptions = {
    place,
    gateway,
    context: undefined,
    data: undefined,
    submitting: false,
    pendingPlacement: false,
    onConnectMachine: presentation.onConnectMachine ?? vi.fn(),
    onNavigate: vi.fn(),
    onFocusComposer: vi.fn(),
    onChange: vi.fn(),
  };
  return { params, state };
}

export function renderPicker(...args: Parameters<typeof pickerParams>) {
  return mountSolid(() => createComponent(WhereChip, pickerParams(...args))).container;
}
