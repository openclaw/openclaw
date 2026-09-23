import type { DoctorUpdateWork } from "./doctor-update-budget.js";
// Private doctor selection metadata around the public health-check contract.
import type { HealthCheck } from "./health-checks.js";

export type DoctorHealthCheck = HealthCheck & {
  readonly defaultEnabled?: boolean;
  readonly updateReadiness?: "post-plugin";
  readonly updateWork?: DoctorUpdateWork;
};
