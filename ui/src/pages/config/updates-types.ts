import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { ApplicationUpdateOverlaySnapshot } from "../../app/overlays-types.ts";

export const UPDATES_CHANNELS = ["stable", "beta", "dev", "extended-stable"] as const;
export type UpdatesChannel = (typeof UPDATES_CHANNELS)[number];

export type UpdatesCommandPresentation = {
  retired: Promise<void>;
  isCurrent: () => boolean;
};

export type UpdatesViewProps = {
  update: ApplicationUpdateOverlaySnapshot;
  statusRead: Promise<boolean> | null;
  commandScope?: object;
  captureCommandPresentation: () => UpdatesCommandPresentation;
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
  configObject: Record<string, unknown>;
  gatewayVersion: string | null;
  gatewayBuildId?: string | null;
  controlUiCommit: string | null;
  controlUiCommitAt: string | null;
  controlUiBuiltAt: string | null;
  connected: boolean;
  configBusy: boolean;
  canAdmin: boolean;
  canUpdate: boolean;
  canCheckStatus: boolean;
  canHoldUpdate: boolean;
  canReport: boolean;
  canDiagnose: boolean;
  updateBusy: boolean;
  nowMs?: number;
  onChannelChange: (channel: UpdatesChannel) => void;
  onUpdateChecksChange: (enabled: boolean) => void;
  onAutomaticUpdatesChange: (enabled: boolean) => void;
  onUpdateNow: () => Promise<void>;
  onHoldUpdate: () => Promise<boolean>;
  onCheckStatus: () => Promise<boolean>;
  onReportFailure: (attemptId: string) => Promise<void>;
  onDiagnoseFailure: (attemptId: string) => void;
};
