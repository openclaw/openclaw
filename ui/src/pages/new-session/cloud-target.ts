import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  WorkerMachineOption,
  WorkerOperatingSystem,
} from "../../../../packages/gateway-protocol/src/schema/environments.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import type { DraftCloudProfile, DraftEnvironment } from "./discovery.ts";

registerNewSessionSetupEnglish();
registerSessionPlacementEnglish();

export async function requestPlaceCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  runtimeId?: string,
): Promise<{
  profiles: DraftCloudProfile[];
  environments: DraftEnvironment[];
  suggestedProfile?: EnvironmentsListResult["suggestedProfile"];
}> {
  const result = await client.request<EnvironmentsListResult>(
    "environments.list",
    runtimeId ? { runtimeId } : {},
  );
  return {
    profiles: (result.profiles ?? []).toSorted((left, right) => left.id.localeCompare(right.id)),
    suggestedProfile: result.suggestedProfile,
    environments: result.environments
      .filter((environment) => ["local", "node", "worker"].includes(environment.type))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

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
