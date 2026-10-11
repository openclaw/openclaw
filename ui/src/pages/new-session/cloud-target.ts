import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import { readSessionPlacementPolicy } from "../../lib/sessions/session-placement-policy.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import {
  LegacySessionMenuItem,
  CloudProfileMenuItems,
  CloudChoiceMenuItems,
} from "./cloud-target-view.tsx";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";

registerNewSessionSetupEnglish();
registerSessionPlacementEnglish();

/** Read the destination directive through the existing session-writer bootstrap grant. */
export async function requestSessionPlacement(client: Pick<GatewayBrowserClient, "request">) {
  const policy = await readSessionPlacementPolicy(client);
  const required = policy.requiredProfile;
  return {
    requiredProfile: required?.id,
    profiles: readDraftCloudProfiles(required ? [required] : []),
  };
}

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  runtimeId?: string,
): Promise<{
  profiles: DraftCloudProfile[];
  environments: DraftEnvironment[];
}> {
  const result = await client.request<EnvironmentsListResult>(
    "environments.list",
    runtimeId ? { runtimeId } : {},
  );
  return {
    profiles: readDraftCloudProfiles(result?.profiles),
    environments: readDraftEnvironments(result?.environments),
  };
}

export type SessionMenuItemOptions = {
  value: string;
  label: string;
  accessibleProvider?: string;
  description?: string;
  icon?: unknown;
  sub?: string;
  facts?: readonly string[];
  checked: boolean;
  disabled?: boolean;
  title?: string;
  keepOpen?: boolean;
  compact?: boolean;
  capacityLabel?: string;
  platform?: string;
  summary?: string;
  selectedSummary?: string;
  hasSubmenu?: boolean;
  suggested?: boolean;
  capabilityLabels?: readonly string[];
  hardware?: string;
  hideDetails?: boolean;
  remediation?: "enable-session-hosting" | "update-device";
  provider?: string;
  trust?: "persistent" | "disposable";
  onSelect: () => void;
};

export type CloudProfileMenuItemsOptions = {
  profiles: readonly DraftCloudProfile[];
  selectedId: string;
  selectedOs?: string;
  selectedMachine?: string;
  onSelectOs?: (osId: string) => void;
  onSelectMachine?: (machineId: string) => void;
  submitting: boolean;
  disabled?: boolean;
  disabledReason?: string;
  profileDisabledReason?: (profile: DraftCloudProfile) => string | undefined;
  compact?: boolean;
  onSelect: (profileId: string, useDefaults?: boolean) => void;
};

export type CloudChoiceMenuItemsOptions = {
  kind: "machine" | "os";
  choices: readonly (WorkerMachineOption & WorkerOperatingSystem)[];
  selectedId: string;
  suggestedId?: string;
  submitting: boolean;
  onSelect: (id: string) => void;
};

/** Machine shape as a picker sub-line; providers may report neither, one, or both numbers. */
export function machineShapeText(machine: WorkerMachineOption): string | undefined {
  const cpu = machine.cpu === undefined ? undefined : String(machine.cpu);
  const memory = machine.memoryGb === undefined ? undefined : String(machine.memoryGb);
  if (cpu && memory) {
    return t("newSession.machineShape", { cpu, memory });
  }
  if (cpu) {
    return t("newSession.machineCpu", { cpu });
  }
  return memory ? t("newSession.machineMemory", { memory }) : undefined;
}

export function renderSessionMenuItem(item: SessionMenuItemOptions, submitting: boolean) {
  return solidContent(LegacySessionMenuItem, { item, submitting });
}

export function renderCloudProfileMenuItems(params: CloudProfileMenuItemsOptions) {
  return solidContent(CloudProfileMenuItems, { params });
}

export function renderCloudChoiceMenuItems(params: CloudChoiceMenuItemsOptions) {
  return solidContent(CloudChoiceMenuItems, { params });
}
