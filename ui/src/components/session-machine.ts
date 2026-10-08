import type { SessionPlacementMachine } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { t } from "../i18n/index.ts";

export function sessionMachineParts(machine?: SessionPlacementMachine): string[] {
  return [
    machine?.osLabel || machine?.os || "",
    machine?.class || "",
    machine?.cpu ? t("sessionHovercard.machineCpu", { cpu: String(machine.cpu) }) : "",
    machine?.memoryGb
      ? t("sessionHovercard.machineMemory", { memory: String(machine.memoryGb) })
      : "",
  ];
}
