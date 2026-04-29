import { setConfigSource } from "../config/sources/current.js";
import { resolveConfigSource } from "../config/sources/resolve.js";
import { loadDotEnv } from "../infra/dotenv.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export async function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void> {
  // Standalone doctor process should resolve the same active config source
  // (file vs Nacos) as gateway startup.
  loadDotEnv({ quiet: true });
  setConfigSource(resolveConfigSource(process.env));

  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.doctorCommand(runtime, options);
}
