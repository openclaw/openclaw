import { vi } from "vitest";
import type { ApplicationUpdateOverlaySnapshot } from "../../app/overlays-types.ts";
import type { renderUpdates } from "./updates.ts";

type UpdatesViewProps = Parameters<typeof renderUpdates>[0];

export type UpdatesViewOverrides = Partial<Omit<UpdatesViewProps, "update">> & {
  update?: Partial<ApplicationUpdateOverlaySnapshot>;
};

export function createUpdatesViewProps(overrides: UpdatesViewOverrides = {}): UpdatesViewProps {
  return {
    configObject: { update: { channel: "stable", auto: { enabled: false } } },
    gatewayVersion: "2026.8.1",
    controlUiCommit: "0123456789abcdef0123456789abcdef01234567",
    controlUiCommitAt: "1970-01-01T00:00:00.000Z",
    controlUiBuiltAt: "1970-01-01T00:00:00.000Z",
    connected: true,
    configBusy: false,
    canAdmin: true,
    canUpdate: true,
    canCheckStatus: true,
    canHoldUpdate: true,
    canReport: true,
    updateBusy: false,
    nowMs: 1_000,
    onChannelChange: vi.fn(),
    onUpdateChecksChange: vi.fn(),
    onAutomaticUpdatesChange: vi.fn(),
    onUpdateNow: vi.fn(),
    onHoldUpdate: vi.fn(async () => true),
    onCheckStatus: vi.fn(async () => true),
    onReportFailure: vi.fn(async () => undefined),
    ...overrides,
    update: {
      updateSchedule: {
        channel: "stable",
        autoEnabled: false,
        install: { kind: "package" },
        target: { kind: "package", version: "2026.8.2" },
      },
      heldUpdateCampaignId: null,
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "stable",
      },
      updateStatusBanner: null,
      updateStatusCheckBanner: null,
      recordedUpdateAttempt: null,
      updateRun: null,
      updateStatusRefreshing: false,
      reportableUpdateFailureId: null,
      updateFailureReportBusy: false,
      updateFailureReportNotice: null,
      updateRunning: false,
      updateCampaignStatusHydrated: true,
      updateReconciliationPending: false,
      updateRunAcknowledged: false,
      controlUiRefreshRequired: false,
      ...overrides.update,
    },
  };
}

export function createUpdatesViewDom() {
  const container = document.createElement("div");
  function row(title: string): HTMLElement {
    const match = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
      (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
    );
    if (!match) {
      throw new Error(`Missing settings row: ${title}`);
    }
    return match;
  }

  function automaticUpdatesControl(): {
    row: HTMLElement;
    toggle: HTMLElement & { checked: boolean };
  } {
    const automaticRow = row("Automatic updates");
    const toggle = automaticRow.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    if (!toggle) {
      throw new Error("Missing automatic updates control");
    }
    return { row: automaticRow, toggle };
  }

  return { container, row, automaticUpdatesControl };
}
