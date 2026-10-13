import type { ExternalSupervisorGuidance } from "../api/types.ts";
import {
  resolveUpdateStatusCheckBanner,
  type ApplicationStatusBanner,
} from "./update-overlay-helpers.ts";

type UpdateStatusCheckBanner =
  | (ApplicationStatusBanner & {
      mode: "manual" | "completion";
    })
  | null;

export function projectUpdateStatusReadError(
  current: {
    externalSupervisorGuidance?: ExternalSupervisorGuidance | null;
    updateStatusCheckBanner: UpdateStatusCheckBanner;
  },
  error: unknown,
  mode: "manual" | "background" | "completion",
): typeof current | null {
  const externalSupervisorGuidance = error === null ? current.externalSupervisorGuidance : null;
  const updateStatusCheckBanner =
    mode === "background" ||
    (mode === "completion" && current.updateStatusCheckBanner?.mode === "manual")
      ? current.updateStatusCheckBanner
      : error === null
        ? null
        : { ...resolveUpdateStatusCheckBanner(error), mode };
  return externalSupervisorGuidance === current.externalSupervisorGuidance &&
    updateStatusCheckBanner === current.updateStatusCheckBanner
    ? null
    : { externalSupervisorGuidance, updateStatusCheckBanner };
}
