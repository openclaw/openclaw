import { t } from "../../lib/reactive/i18n.ts";
import { CapacityMeter } from "./capacity-meter.tsx";
import { Icon } from "./icon.tsx";

/** Presentation only: the caller owns connectivity and placement eligibility. */
export function workerCapacityPresentation(params: {
  workerSlots?: { available: number; total: number };
  capabilities?: readonly string[];
  commands?: readonly string[];
  unavailable: boolean;
}) {
  const slots = params.workerSlots;
  if (slots) {
    const used = params.unavailable ? null : slots.total - slots.available;
    const label =
      used === null
        ? t("capacityMeter.unavailable")
        : t("capacityMeter.workerSlots", {
            used: String(used),
            total: String(slots.total),
          });
    const tone = params.unavailable ? "stale" : slots.available === 0 ? "warn" : "accent";
    return {
      label,
      // Row titles carry countable facts only; an unavailable node's title
      // belongs to its disabled reason, not the meter's alt text.
      title: used === null ? undefined : label,
      meter: (
        <CapacityMeter mode="discrete" total={slots.total} used={used} tone={tone} label={label} />
      ),
    };
  }
  // Environments advertise capabilities/commands together; node inventory keeps them separate.
  const execHost =
    params.capabilities?.some(
      (capability) =>
        capability === "codex.exec-server" || capability === "codex.exec-server.stdio.v1",
    ) || params.commands?.includes("codex.exec-server.stdio.v1");
  if (!execHost) {
    return undefined;
  }
  const label = t("capacityMeter.execHost");
  return {
    label,
    title: label,
    meter: (
      <span class="capacity-meter-exec" role="img" aria-label={label}>
        <span aria-hidden="true">
          <Icon name="terminal" />
        </span>
        {label}
      </span>
    ),
  };
}
