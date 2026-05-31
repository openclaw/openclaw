import type { DoctorHealthResult } from "../flows/doctor-health-contributions.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export async function doctorCommand(
  runtime?: RuntimeEnv,
  options?: DoctorOptions,
): Promise<DoctorHealthResult> {
  const doctorHealth = await import("../flows/doctor-health.js");
  return doctorHealth.doctorCommand(runtime, options);
}
